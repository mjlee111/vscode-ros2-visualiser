#!/usr/bin/env python3
"""Synthetic ROS 2 sensor node for exercising the visualiser.

Publishes images, depth, compressed images, point clouds, laser scans,
scalars, poses, TF, an occupancy grid, logs; offers services and parameters.
Run:  /usr/bin/python3 python/demo_sensors.py
"""
import math
import struct
import time

import numpy as np
import rclpy
from builtin_interfaces.msg import Time
from example_interfaces.srv import AddTwoInts
from geometry_msgs.msg import PoseStamped, TransformStamped
from nav_msgs.msg import OccupancyGrid
from rcl_interfaces.msg import FloatingPointRange, ParameterDescriptor
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, qos_profile_sensor_data
from sensor_msgs.msg import CompressedImage, Image, LaserScan, PointCloud2, PointField
from sensor_msgs.msg import JointState
from std_msgs.msg import Float64, String
from std_srvs.srv import SetBool
from tf2_msgs.msg import TFMessage

try:
    import cv2
except Exception:
    cv2 = None

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import demo_robot  # noqa: E402


class Demo(Node):
    def __init__(self):
        super().__init__('demo_sensors', namespace='/demo')
        self.declare_parameter('gain', 1.0, ParameterDescriptor(
            description='Sine amplitude',
            floating_point_range=[FloatingPointRange(from_value=0.0, to_value=10.0, step=0.0)]))
        self.declare_parameter('enabled', True)
        self.declare_parameter('label', 'hello')
        self.declare_parameter('cloud_points', 40000)
        self.t0 = time.monotonic()
        self.pub_img = self.create_publisher(Image, 'camera/image_raw', 5)
        self.pub_depth = self.create_publisher(Image, 'camera/depth', 5)
        self.pub_cimg = self.create_publisher(CompressedImage, 'camera/image_raw/compressed', 5)
        self.pub_pts = self.create_publisher(PointCloud2, 'points', 5)
        self.pub_scan = self.create_publisher(LaserScan, 'scan', qos_profile_sensor_data)
        self.pub_sine = self.create_publisher(Float64, 'sine', 10)
        self.pub_cos = self.create_publisher(Float64, 'cosine', 10)
        self.pub_pose = self.create_publisher(PoseStamped, 'pose', 10)
        self.pub_str = self.create_publisher(String, 'chatter', 10)
        latched = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)
        self.pub_map = self.create_publisher(OccupancyGrid, 'map', latched)
        self.pub_tf = self.create_publisher(TFMessage, '/tf', 100)
        self.pub_tf_static = self.create_publisher(TFMessage, '/tf_static', latched)
        self.create_service(AddTwoInts, 'add_two_ints', self.on_add)
        self.create_service(SetBool, 'set_enabled', self.on_set_enabled)
        self.create_timer(1 / 30, self.tick_image)
        self.create_timer(1 / 10, self.tick_cloud)
        self.create_timer(1 / 20, self.tick_scan)
        self.create_timer(1 / 100, self.tick_scalar)
        self.create_timer(1 / 50, self.tick_tf)
        self.create_timer(1.0, self.tick_slow)
        self.publish_static_tf()
        self.publish_map()
        self.n = 0
        # robot model: /robot_description (latched) + /joint_states
        assets = demo_robot.write_assets()
        self.pub_desc = self.create_publisher(String, '/robot_description', latched)
        self.pub_desc.publish(String(data=demo_robot.urdf('file://' + assets)))
        self.pub_js = self.create_publisher(JointState, '/joint_states', 10)
        self.create_timer(1 / 50, self.tick_joints)
        self.get_logger().info(f'demo robot meshes in {assets}')

    def now(self):
        return self.get_clock().now().to_msg()

    def t(self):
        return time.monotonic() - self.t0

    # -- services --------------------------------------------------------
    def on_add(self, req, res):
        res.sum = req.a + req.b
        self.get_logger().info(f'add_two_ints {req.a} + {req.b} = {res.sum}')
        return res

    def on_set_enabled(self, req, res):
        self.set_parameters([rclpy.parameter.Parameter('enabled', value=req.data)])
        res.success = True
        res.message = f'enabled={req.data}'
        return res

    # -- publishers ------------------------------------------------------
    def tick_image(self):
        if not self.get_parameter('enabled').value:
            return
        t = self.t()
        w, h = 640, 480
        x = np.arange(w)[None, :]
        y = np.arange(h)[:, None]
        img = np.zeros((h, w, 3), np.uint8)
        img[..., 0] = ((x + t * 60) % 256).astype(np.uint8)
        img[..., 1] = ((y + t * 30) % 256).astype(np.uint8)
        img[..., 2] = 128
        cx = int(w / 2 + 200 * math.cos(t))
        cy = int(h / 2 + 150 * math.sin(t * 1.3))
        mask = (x - cx) ** 2 + (y - cy) ** 2 < 40 ** 2
        img[mask] = (255, 255, 255)
        m = Image()
        m.header.stamp = self.now()
        m.header.frame_id = 'camera'
        m.height, m.width, m.encoding, m.step = h, w, 'rgb8', w * 3
        m.data = img.tobytes()
        self.pub_img.publish(m)
        if cv2 is not None and self.n % 2 == 0:
            ok, buf = cv2.imencode('.jpg', img[:, :, ::-1])
            c = CompressedImage()
            c.header = m.header
            c.format = 'rgb8; jpeg compressed bgr8'
            c.data = buf.tobytes()
            self.pub_cimg.publish(c)
        if self.n % 2 == 0:
            dw, dh = 320, 240
            xx = np.arange(dw)[None, :] / dw
            yy = np.arange(dh)[:, None] / dh
            depth = (1.0 + 2.0 * xx + 0.5 * np.sin(yy * 8 + t)).astype(np.float32)
            depth[:20, :20] = np.nan
            d = Image()
            d.header = m.header
            d.height, d.width, d.encoding, d.step = dh, dw, '32FC1', dw * 4
            d.data = depth.tobytes()
            self.pub_depth.publish(d)
        self.n += 1

    def tick_cloud(self):
        t = self.t()
        n = int(self.get_parameter('cloud_points').value)
        side = int(math.sqrt(n))
        g = np.linspace(-5, 5, side, dtype=np.float32)
        xx, yy = np.meshgrid(g, g)
        zz = 0.5 * np.sin(np.sqrt(xx ** 2 + yy ** 2) * 2 - t * 2)
        pts = np.zeros(side * side, dtype=[('x', 'f4'), ('y', 'f4'), ('z', 'f4'),
                                           ('intensity', 'f4'), ('rgb', 'f4')])
        pts['x'] = xx.ravel()
        pts['y'] = yy.ravel()
        pts['z'] = zz.ravel()
        pts['intensity'] = (zz.ravel() + 0.5) * 100
        r = ((xx.ravel() + 5) / 10 * 255).astype(np.uint32)
        gch = ((yy.ravel() + 5) / 10 * 255).astype(np.uint32)
        b = ((zz.ravel() + 0.5) * 255).clip(0, 255).astype(np.uint32)
        pts['rgb'] = ((r << 16) | (gch << 8) | b).view(np.float32)
        m = PointCloud2()
        m.header.stamp = self.now()
        m.header.frame_id = 'world'
        m.height, m.width = 1, pts.size
        m.fields = [PointField(name=nm, offset=4 * i, datatype=PointField.FLOAT32, count=1)
                    for i, nm in enumerate(['x', 'y', 'z', 'intensity', 'rgb'])]
        m.is_bigendian = False
        m.point_step = 20
        m.row_step = 20 * pts.size
        m.is_dense = True
        m.data = pts.tobytes()
        self.pub_pts.publish(m)

    def tick_scan(self):
        t = self.t()
        n = 360
        a = np.linspace(-math.pi, math.pi, n, endpoint=False)
        r = 3.0 + 0.8 * np.sin(a * 4 + t)
        r[10:20] = float('inf')
        m = LaserScan()
        m.header.stamp = self.now()
        m.header.frame_id = 'laser'
        m.angle_min, m.angle_max = -math.pi, math.pi
        m.angle_increment = 2 * math.pi / n
        m.range_min, m.range_max = 0.1, 10.0
        m.ranges = r.astype(np.float32).tolist()
        m.intensities = ((np.cos(a * 3) + 1) * 50).astype(np.float32).tolist()
        self.pub_scan.publish(m)

    def tick_scalar(self):
        t = self.t()
        gain = self.get_parameter('gain').value
        self.pub_sine.publish(Float64(data=gain * math.sin(t * 2)))
        self.pub_cos.publish(Float64(data=gain * math.cos(t * 0.7)))
        if int(t * 100) % 2 == 0:
            p = PoseStamped()
            p.header.stamp = self.now()
            p.header.frame_id = 'world'
            p.pose.position.x = 2 * math.cos(t * 0.5)
            p.pose.position.y = 2 * math.sin(t * 0.5)
            p.pose.orientation.z = math.sin(t * 0.25)
            p.pose.orientation.w = math.cos(t * 0.25)
            self.pub_pose.publish(p)

    def tick_joints(self):
        js = JointState()
        js.header.stamp = self.now()
        js.name = demo_robot.JOINTS
        js.position = demo_robot.joint_positions(self.t())
        self.pub_js.publish(js)

    def _tf(self, parent, child, xyz, yaw):
        tr = TransformStamped()
        tr.header.stamp = self.now()
        tr.header.frame_id = parent
        tr.child_frame_id = child
        tr.transform.translation.x, tr.transform.translation.y, tr.transform.translation.z = xyz
        tr.transform.rotation.z = math.sin(yaw / 2)
        tr.transform.rotation.w = math.cos(yaw / 2)
        return tr

    def tick_tf(self):
        t = self.t()
        self.pub_tf.publish(TFMessage(transforms=[
            self._tf('world', 'odom', (0.0, 0.0, 0.0), 0.0),
            self._tf('odom', 'base_link', (2 * math.cos(t * 0.5), 2 * math.sin(t * 0.5), 0.0), t * 0.5),
        ]))

    def publish_static_tf(self):
        self.pub_tf_static.publish(TFMessage(transforms=[
            self._tf('base_link', 'laser', (0.2, 0.0, 0.3), 0.0),
            self._tf('base_link', 'camera', (0.25, 0.0, 0.5), 0.0),
            self._tf('camera', 'camera_optical', (0.0, 0.0, 0.0), -math.pi / 2),
        ]))

    def publish_map(self):
        w = h = 100
        g = np.full((h, w), -1, np.int8)
        g[10:90, 10:90] = 0
        g[10:90, 10] = g[10:90, 89] = g[10, 10:90] = g[89, 10:90] = 100
        g[40:60, 45:55] = 100
        m = OccupancyGrid()
        m.header.stamp = self.now()
        m.header.frame_id = 'world'
        m.info.resolution = 0.05
        m.info.width, m.info.height = w, h
        m.info.origin.position.x = -2.5
        m.info.origin.position.y = -2.5
        m.data = g.ravel().tolist()
        self.pub_map.publish(m)

    def tick_slow(self):
        k = int(self.t())
        self.pub_str.publish(String(data=f'hello world {k}'))
        lg = self.get_logger()
        if k % 10 == 0:
            lg.error(f'synthetic error #{k}')
        elif k % 5 == 0:
            lg.warning(f'synthetic warning #{k}')
        elif k % 3 == 0:
            lg.debug(f'debug tick {k}')
        else:
            lg.info(f'tick {k}')


class Helpers:
    """Small in-process nodes so the graph has real connections."""

    def __init__(self):
        self.listener = Node('chatter_listener', namespace='/demo')
        self.listener.create_subscription(String, 'chatter', lambda m: None, 10)
        self.filter = Node('sine_filter', namespace='/demo')
        self.out = self.filter.create_publisher(Float64, 'sine_filtered', 10)
        self.y = 0.0
        self.filter.create_subscription(Float64, 'sine', self.on_sine, 10)
        self.monitor = Node('filter_monitor', namespace='/demo')
        self.monitor.create_subscription(Float64, 'sine_filtered', lambda m: None, 10)

    def on_sine(self, m):
        self.y += 0.1 * (m.data - self.y)
        self.out.publish(Float64(data=self.y))

    @property
    def nodes(self):
        return [self.listener, self.filter, self.monitor]


def main():
    rclpy.init()
    executor = rclpy.executors.SingleThreadedExecutor()
    node = Demo()
    helpers = Helpers()
    for n in [node, *helpers.nodes]:
        executor.add_node(n)
    try:
        executor.spin()
    except (KeyboardInterrupt, rclpy.executors.ExternalShutdownException):
        pass


if __name__ == '__main__':
    main()
