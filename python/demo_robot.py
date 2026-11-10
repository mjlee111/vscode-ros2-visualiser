"""Demo robot for demo_sensors.py: URDF text plus generated STL / OBJ / DAE meshes."""
import math
import os
import tempfile


def _stl_prism(path, length, radius, sides):
    """ASCII STL prism along +X from 0 to `length`."""
    ring = [(radius * math.cos(2 * math.pi * k / sides), radius * math.sin(2 * math.pi * k / sides)) for k in range(sides)]
    tris = []
    for k in range(sides):
        (y0, z0), (y1, z1) = ring[k], ring[(k + 1) % sides]
        a, b, c, d = (0, y0, z0), (length, y0, z0), (length, y1, z1), (0, y1, z1)
        tris += [(a, b, c), (a, c, d)]
        tris += [((0, 0, 0), (0, y1, z1), (0, y0, z0)), ((length, 0, 0), (length, y0, z0), (length, y1, z1))]

    def normal(t):
        u = [t[1][i] - t[0][i] for i in range(3)]
        v = [t[2][i] - t[0][i] for i in range(3)]
        n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
        m = math.sqrt(sum(x * x for x in n)) or 1.0
        return tuple(x / m for x in n)

    with open(path, 'w') as f:
        f.write('solid forearm\n')
        for t in tris:
            f.write('facet normal %f %f %f\n outer loop\n' % normal(t))
            for p in t:
                f.write('  vertex %f %f %f\n' % p)
            f.write(' endloop\nendfacet\n')
        f.write('endsolid forearm\n')


def _obj_prism(path, radius, height, sides):
    """OBJ prism along Z centred on the origin (lidar puck)."""
    with open(path, 'w') as f:
        for z in (-height / 2, height / 2):
            for k in range(sides):
                a = 2 * math.pi * k / sides
                f.write('v %f %f %f\n' % (radius * math.cos(a), radius * math.sin(a), z))
        for k in range(sides):
            n = (k + 1) % sides
            f.write('f %d %d %d %d\n' % (k + 1, n + 1, sides + n + 1, sides + k + 1))
        f.write('f ' + ' '.join(str(k + 1) for k in reversed(range(sides))) + '\n')
        f.write('f ' + ' '.join(str(sides + k + 1) for k in range(sides)) + '\n')


def _dae_box(path, sx, sy, sz):
    """Collada (Z_UP) box resting on z=0 with its own orange material."""
    x, y = sx / 2, sy / 2
    v = [(-x, -y, 0), (x, -y, 0), (x, y, 0), (-x, y, 0), (-x, -y, sz), (x, -y, sz), (x, y, sz), (-x, y, sz)]
    faces = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4),
             (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    pos = [c for f in faces for i in f for c in v[i]]  # unshared vertices -> flat normals
    idx = ' '.join(str(i) for i in range(len(faces) * 3))
    with open(path, 'w') as f:
        f.write(f'''<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><unit name="meter" meter="1"/><up_axis>Z_UP</up_axis></asset>
  <library_effects><effect id="fx"><profile_COMMON><technique sid="common"><phong>
    <diffuse><color sid="diffuse">0.95 0.55 0.15 1</color></diffuse>
  </phong></technique></profile_COMMON></effect></library_effects>
  <library_materials><material id="mat" name="head"><instance_effect url="#fx"/></material></library_materials>
  <library_geometries><geometry id="geo" name="head"><mesh>
    <source id="pos"><float_array id="pos-array" count="{len(pos)}">{' '.join('%f' % c for c in pos)}</float_array>
      <technique_common><accessor source="#pos-array" count="{len(pos) // 3}" stride="3">
        <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
      </accessor></technique_common></source>
    <vertices id="verts"><input semantic="POSITION" source="#pos"/></vertices>
    <triangles material="mat" count="{len(faces)}"><input semantic="VERTEX" source="#verts" offset="0"/><p>{idx}</p></triangles>
  </mesh></geometry></library_geometries>
  <library_visual_scenes><visual_scene id="Scene" name="Scene"><node id="head" name="head">
    <instance_geometry url="#geo"><bind_material><technique_common>
      <instance_material symbol="mat" target="#mat"/>
    </technique_common></bind_material></instance_geometry>
  </node></visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>
''')


def write_assets(directory=None):
    d = directory or tempfile.mkdtemp(prefix='ros_vis_demo_')
    os.makedirs(d, exist_ok=True)
    _stl_prism(os.path.join(d, 'forearm.stl'), 0.25, 0.035, 6)
    _obj_prism(os.path.join(d, 'lidar.obj'), 0.06, 0.05, 16)
    _dae_box(os.path.join(d, 'head.dae'), 0.16, 0.12, 0.1)
    return d


def urdf(mesh_prefix):
    """URDF of the demo robot; `mesh_prefix` is e.g. 'file:///tmp/x' or 'package://pkg/meshes'."""
    m = mesh_prefix.rstrip('/')
    return f'''<?xml version="1.0"?>
<robot name="demo_bot">
  <material name="grey"><color rgba="0.55 0.57 0.6 1"/></material>
  <material name="blue"><color rgba="0.16 0.45 0.85 1"/></material>
  <material name="dark"><color rgba="0.16 0.16 0.18 1"/></material>
  <link name="base_link">
    <visual><geometry><box size="0.6 0.4 0.15"/></geometry><material name="grey"/></visual>
    <collision><geometry><box size="0.62 0.42 0.17"/></geometry></collision>
  </link>
  <joint name="wheel_left_joint" type="continuous">
    <parent link="base_link"/><child link="wheel_left"/>
    <origin xyz="0 0.23 -0.05" rpy="-1.5708 0 0"/><axis xyz="0 0 1"/>
  </joint>
  <link name="wheel_left"><visual><geometry><cylinder radius="0.1" length="0.05"/></geometry><material name="dark"/></visual></link>
  <joint name="wheel_right_joint" type="continuous">
    <parent link="base_link"/><child link="wheel_right"/>
    <origin xyz="0 -0.23 -0.05" rpy="-1.5708 0 0"/><axis xyz="0 0 1"/>
  </joint>
  <link name="wheel_right"><visual><geometry><cylinder radius="0.1" length="0.05"/></geometry><material name="dark"/></visual></link>
  <joint name="torso_lift" type="prismatic">
    <parent link="base_link"/><child link="torso"/>
    <origin xyz="0 0 0.075"/><axis xyz="0 0 1"/><limit lower="0" upper="0.3" effort="100" velocity="0.1"/>
  </joint>
  <link name="torso">
    <visual><origin xyz="0 0 0.2"/><geometry><cylinder radius="0.08" length="0.4"/></geometry><material name="blue"/></visual>
    <collision><origin xyz="0 0 0.2"/><geometry><cylinder radius="0.09" length="0.42"/></geometry></collision>
  </link>
  <joint name="head_pan" type="revolute">
    <parent link="torso"/><child link="head"/>
    <origin xyz="0 0 0.42"/><axis xyz="0 0 1"/><limit lower="-1.57" upper="1.57" effort="10" velocity="1"/>
  </joint>
  <link name="head"><visual><geometry><mesh filename="{m}/head.dae"/></geometry></visual></link>
  <joint name="lidar_joint" type="fixed">
    <parent link="head"/><child link="lidar"/><origin xyz="0 0 0.125"/>
  </joint>
  <link name="lidar"><visual><geometry><mesh filename="{m}/lidar.obj"/></geometry><material name="dark"/></visual></link>
  <joint name="shoulder" type="revolute">
    <parent link="torso"/><child link="upper_arm"/>
    <origin xyz="0.09 -0.12 0.35"/><axis xyz="0 1 0"/><limit lower="-1.57" upper="1.57" effort="10" velocity="1"/>
  </joint>
  <link name="upper_arm"><visual><origin xyz="0.15 0 0"/><geometry><box size="0.3 0.06 0.06"/></geometry><material name="grey"/></visual></link>
  <joint name="elbow" type="revolute">
    <parent link="upper_arm"/><child link="forearm"/>
    <origin xyz="0.3 0 0"/><axis xyz="0 1 0"/><limit lower="-2.0" upper="2.0" effort="10" velocity="1"/>
  </joint>
  <link name="forearm"><visual><geometry><mesh filename="{m}/forearm.stl"/></geometry><material name="blue"/></visual></link>
  <joint name="wrist" type="continuous">
    <parent link="forearm"/><child link="gripper"/><origin xyz="0.26 0 0"/><axis xyz="1 0 0"/>
  </joint>
  <link name="gripper"><visual><geometry><box size="0.03 0.12 0.04"/></geometry><material name="dark"/></visual></link>
  <joint name="finger_left_joint" type="prismatic">
    <parent link="gripper"/><child link="finger_left"/>
    <origin xyz="0.04 0.015 0"/><axis xyz="0 1 0"/><limit lower="0" upper="0.04" effort="5" velocity="0.1"/>
  </joint>
  <link name="finger_left"><visual><origin xyz="0.01 0 0"/><geometry><box size="0.05 0.01 0.03"/></geometry><material name="grey"/></visual></link>
  <joint name="finger_right_joint" type="prismatic">
    <parent link="gripper"/><child link="finger_right"/>
    <origin xyz="0.04 -0.015 0"/><axis xyz="0 1 0"/><limit lower="-0.04" upper="0" effort="5" velocity="0.1"/>
    <mimic joint="finger_left_joint" multiplier="-1" offset="0"/>
  </joint>
  <link name="finger_right"><visual><origin xyz="0.01 0 0"/><geometry><box size="0.05 0.01 0.03"/></geometry><material name="grey"/></visual></link>
</robot>
'''


JOINTS = ['wheel_left_joint', 'wheel_right_joint', 'torso_lift', 'head_pan', 'shoulder', 'elbow', 'wrist', 'finger_left_joint']


def joint_positions(t):
    return [t * 2.0, t * 2.0, 0.15 + 0.15 * math.sin(t * 0.7), 1.2 * math.sin(t * 0.5), -0.6 + 0.6 * math.sin(t),
            1.0 + 0.8 * math.sin(t * 1.3), t, 0.02 + 0.02 * math.sin(t * 3)]
