#!/usr/bin/env python3
"""Protocol-level smoke test for python/ros_backend.py.

Run in an isolated domain, with demo_sensors.py running in the same domain:
  ROS_DOMAIN_ID=87 ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST /usr/bin/python3 test/smoke_backend.py
"""
import json
import os
import struct
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(HERE, '..', 'python', 'ros_backend.py')

import tempfile  # noqa: E402

sys.path.insert(0, os.path.join(HERE, '..', 'python'))
import demo_robot  # noqa: E402

# fake ament package 'ros_vis_test_assets' providing meshes for package:// resolution
PREFIX = tempfile.mkdtemp(prefix='ros_vis_prefix_')
os.makedirs(os.path.join(PREFIX, 'share', 'ament_index', 'resource_index', 'packages'))
open(os.path.join(PREFIX, 'share', 'ament_index', 'resource_index', 'packages', 'ros_vis_test_assets'), 'w').close()
MESH_DIR = demo_robot.write_assets(os.path.join(PREFIX, 'share', 'ros_vis_test_assets', 'meshes'))
URDF_PATH = os.path.join(MESH_DIR, 'robot.urdf')
with open(URDF_PATH, 'w') as f:
    f.write(demo_robot.urdf('package://ros_vis_test_assets/meshes'))
with open(os.path.join(MESH_DIR, 'secret.txt'), 'w') as f:
    f.write('not a mesh')
env = dict(os.environ)
env['AMENT_PREFIX_PATH'] = PREFIX + os.pathsep + env.get('AMENT_PREFIX_PATH', '')

proc = subprocess.Popen([sys.executable, BACKEND], stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=sys.stderr, env=env)
replies = {}
events = []
lock = threading.Lock()


def reader():
    f = proc.stdout
    while True:
        hdr = f.read(8)
        if len(hdr) < 8:
            return
        jl, bl = struct.unpack('>II', hdr)
        j = json.loads(f.read(jl))
        b = f.read(bl) if bl else b''
        with lock:
            if 'id' in j:
                j['_payload'] = b
                replies[j['id']] = j
            else:
                events.append((j, b))


threading.Thread(target=reader, daemon=True).start()
_id = [0]


def call(op, _timeout=10, **kw):
    _id[0] += 1
    rid = _id[0]
    proc.stdin.write((json.dumps({'op': op, 'id': rid, **kw}) + '\n').encode())
    proc.stdin.flush()
    t0 = time.time()
    while time.time() - t0 < _timeout:
        with lock:
            if rid in replies:
                return replies.pop(rid)
        time.sleep(0.01)
    raise TimeoutError(op)


def take(pred):
    with lock:
        out = [e for e in events if pred(e[0])]
        for e in out:
            events.remove(e)
    return out


failures = []


def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else f'  -> {detail}'))
    if not cond:
        failures.append(name)


r = call('ping')
check('ping', r['ok'], r)
time.sleep(2.5)
g = call('graph')['result']
names = [n['fqn'] for n in g['nodes']]
check('graph has demo node', '/demo/demo_sensors' in names, names)
topics = {t['name']: t for t in g['topics']}
check('graph topics', '/demo/points' in topics and '/demo/scan' in topics, list(topics))
check('demo pubs listed', '/demo/demo_sensors' in topics.get('/demo/sine', {}).get('pubs', []))

ti = call('topicInfo', topic='/demo/scan')['result']
check('topicInfo best_effort', ti['publishers'] and ti['publishers'][0]['qos']['reliability'] == 'best_effort', ti)

for sid, topic, mode, opts in [
    ('j1', '/demo/pose', 'json', {'maxRate': 5}),
    ('s1', '/demo/sine', 'stats', {}),
    ('p1', '/demo/sine', 'plot', {'fields': ['data']}),
    ('i1', '/demo/camera/image_raw', 'image', {}),
    ('i2', '/demo/camera/depth', 'image', {}),
    ('i3', '/demo/camera/image_raw/compressed', 'image', {}),
    ('i4', '/demo/map', 'image', {}),
    ('c1', '/demo/points', 'cloud', {}),
    ('c2', '/demo/scan', 'cloud', {}),
    ('t1', '/tf', 'tf', {}),
    ('t2', '/tf_static', 'tf', {}),
    ('r1', '/rosout', 'json', {'maxRate': 0}),
]:
    res = call('subscribe', subId=sid, topic=topic, mode=mode, opts=opts)
    check(f'subscribe {sid} {topic}', res['ok'] and res['result']['type'], res)

# ack images/clouds continuously, like the webview does
t_end = time.time() + 3.0
while time.time() < t_end:
    for e, _ in take(lambda j: j.get('ev') == 'msg' and j.get('kind') in ('image', 'cloud')):
        events.append(({**e, 'ev': 'seen'}, b''))
        proc.stdin.write((json.dumps({'op': 'ack', 'subId': e['subId']}) + '\n').encode())
    proc.stdin.flush()
    time.sleep(0.02)

seen = take(lambda j: j.get('ev') == 'seen')
by_sub = {}
for e, _ in seen:
    by_sub.setdefault(e['subId'], []).append(e)
for sid in ('i1', 'i2', 'i3', 'i4', 'c1', 'c2'):
    check(f'binary frames {sid}', len(by_sub.get(sid, [])) > 0, by_sub.get(sid))
if by_sub.get('i1'):
    print('   image fps ~', len(by_sub['i1']) / 3.0, by_sub['i1'][-1]['format'], by_sub['i1'][-1]['width'])
if by_sub.get('i2'):
    e = by_sub['i2'][-1]
    check('depth colormapped', e.get('colormapped') and e['max'] > e['min'], e)
if by_sub.get('c1'):
    e = by_sub['c1'][-1]
    check('cloud rgb auto', e['color'] == 'rgb' and e['n'] > 1000, e)
if by_sub.get('c2'):
    e = by_sub['c2'][-1]
    check('scan points', e['n'] > 300 and e['color'] == 'scalar', e)

js = take(lambda j: j.get('ev') == 'msg' and j.get('subId') == 'j1')
check('json pose rate-limited (~5Hz)', 8 <= len(js) <= 25, len(js))
if js:
    check('json pose content', 'pose' in js[-1][0]['msg'], js[-1][0])
plots = take(lambda j: j.get('ev') == 'plot')
npts = sum(len(e['t']) for e, _ in plots)
check('plot batches ~100Hz', npts > 150, npts)
stats = take(lambda j: j.get('ev') == 'stats')
last = stats[-1][0]['stats'] if stats else {}
hz = last.get('/demo/sine', {}).get('hz', 0)
check('sine hz ~100', 80 < hz < 120, last.get('/demo/sine'))
check('image bw > 0', last.get('/demo/camera/image_raw', {}).get('bw', 0) > 1e6, last.get('/demo/camera/image_raw'))
tfs = take(lambda j: j.get('ev') == 'tf')
frames = {}
for e, _ in tfs:
    frames.update(e['frames'])
check('tf frames', {'odom', 'base_link', 'laser', 'camera'} <= set(frames), list(frames))
logs = take(lambda j: j.get('ev') == 'msg' and j.get('subId') == 'r1')
check('rosout messages', len(logs) > 0, len(logs))

res = call('interface', type='geometry_msgs/msg/PoseStamped')
check('interface msg', res['ok'] and 'pose' in res['result']['default'], res)
res = call('interface', type='example_interfaces/srv/AddTwoInts')
check('interface srv', res['ok'] and 'a' in res['result']['request'], res)
res = call('callService', service='/demo/add_two_ints', request={'a': 2, 'b': 40})
check('callService', res['ok'] and res['result']['response']['sum'] == 42, res)
res = call('callService', service='/demo/nope', type='std_srvs/srv/Trigger', timeout=0.5)
check('callService unavailable -> error', not res['ok'], res)
res = call('params.list', node='/demo/demo_sensors')
check('params.list', res['ok'] and any(p['name'] == 'gain' for p in res['result']), res)
gain = [p for p in res['result'] if p['name'] == 'gain'][0] if res['ok'] else {}
check('param range', gain.get('range', [None, None])[1] == 10.0, gain)
res = call('params.set', node='/demo/demo_sensors', name='gain', type=3, value=2.5)
check('params.set', res['ok'] and res['result']['successful'], res)
res = call('params.list', node='/demo/demo_sensors')
gain = [p for p in res['result'] if p['name'] == 'gain'][0]
check('param updated', gain['value'] == 2.5, gain)
call('params.set', node='/demo/demo_sensors', name='gain', type=3, value=1.0)

res = call('subscribe', subId='e1', topic='/vis_test/echo', type='std_msgs/msg/String', mode='json', opts={'maxRate': 0})
check('pending subscribe', res['ok'], res)
res = call('startPublisher', pubId='pub1', topic='/vis_test/echo', type='std_msgs/msg/String', msg={'data': 'hi'}, rate=20)
check('startPublisher', res['ok'], res)
time.sleep(2.0)
echo = take(lambda j: j.get('ev') == 'msg' and j.get('subId') == 'e1')
check('publisher -> subscriber loop', len(echo) > 5 and echo[-1][0]['msg']['data'] == 'hi', len(echo))
check('stopPublisher', call('stopPublisher', pubId='pub1')['result'] is True)
res = call('listInterfaces')
check('listInterfaces', res['ok'] and 'std_msgs/msg/String' in res['result']['msgs'])
res = call('nope')
check('unknown op error', not res['ok'])

# ---- URDF support
res = call('loadUrdf', path=URDF_PATH)
check('loadUrdf .urdf', res['ok'] and '<robot name="demo_bot">' in res['result']['urdf'] and res['result']['base'] == MESH_DIR, res.get('error'))
res = call('loadUrdf', path='/opt/ros/jazzy/share/robot_state_publisher/urdf/test-desc.urdf.xacro', _timeout=60)
check('loadUrdf .xacro (runs xacro)', res['ok'] and '<robot' in res['result']['urdf'] and 'xacro:' not in res['result']['urdf'], res.get('error'))
res = call('loadUrdf', path='/nonexistent/robot.urdf')
check('loadUrdf missing file -> error', not res['ok'])
res = call('readResource', uri='package://ros_vis_test_assets/meshes/forearm.stl')
check('readResource package://', res['ok'] and res['_payload'].startswith(b'solid forearm') and res['result']['size'] == len(res['_payload']), res.get('error'))
res = call('readResource', uri='file://' + os.path.join(MESH_DIR, 'head.dae'))
check('readResource file://', res['ok'] and b'COLLADA' in res['_payload'], res.get('error'))
res = call('readResource', uri='lidar.obj', base=MESH_DIR)
check('readResource relative to base', res['ok'] and res['_payload'].startswith(b'v '), res.get('error'))
res = call('readResource', uri='file://' + os.path.join(MESH_DIR, 'secret.txt'))
check('readResource refuses non-mesh files', not res['ok'] and 'only mesh' in res['error'], res)
res = call('readResource', uri='package://no_such_pkg_xyz/a.stl')
check('readResource unknown package -> error', not res['ok'], res)
res = call('params.get', node='/demo/demo_sensors', names=['gain', 'label'])
check('params.get', res['ok'] and res['result'].get('label') == 'hello', res)
for sid in ('j1', 's1', 'p1', 'i1', 'i2', 'i3', 'i4', 'c1', 'c2', 't1', 't2', 'r1', 'e1'):
    call('unsubscribe', subId=sid)
time.sleep(1.5)
take(lambda j: True)
time.sleep(1.2)
left = take(lambda j: j.get('ev') in ('msg', 'stats'))
check('quiet after unsubscribe', len(left) == 0, left[:3])

proc.stdin.close()
proc.wait(timeout=5)
check('clean exit on stdin EOF', proc.returncode == 0, proc.returncode)
print('\n%d failure(s)' % len(failures))
sys.exit(1 if failures else 0)
