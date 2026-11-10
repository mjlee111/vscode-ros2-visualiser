#!/usr/bin/env python3
"""ROS 2 introspection backend for the VS Code ROS visualiser.

Protocol
  stdin : one JSON command per line: {"op": str, "id"?: int, ...}
  stdout: binary frames  [u32 BE json_len][u32 BE bin_len][json utf-8][binary payload]
          - replies: {"id": int, "ok": bool, "result"|"error": ...}
          - events : {"ev": str, ...}
  stderr: human readable log

All ROS work happens on the executor thread. The stdin reader thread only
queues commands and triggers a guard condition.
"""

import array
import inspect
import json
import math
import os
import queue
import shutil
import struct
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
from collections import deque

# Keep the protocol channel private: anything printed to fd 1 (including C
# extensions) is redirected to stderr.
_proto_fd = os.dup(1)
os.dup2(2, 1)
sys.stdout = sys.stderr
_proto = os.fdopen(_proto_fd, 'wb', buffering=1 << 20)
_proto_lock = threading.Lock()

import numpy as np  # noqa: E402
import rclpy  # noqa: E402
from rclpy.executors import ExternalShutdownException, SingleThreadedExecutor  # noqa: E402
from rclpy.node import Node  # noqa: E402
from rclpy.qos import (DurabilityPolicy, HistoryPolicy, QoSProfile,  # noqa: E402
                       ReliabilityPolicy)
from rclpy.serialization import deserialize_message  # noqa: E402
from rclpy.task import Future  # noqa: E402
from rosidl_runtime_py.set_message import set_message_fields  # noqa: E402
from rosidl_runtime_py.utilities import get_message, get_service  # noqa: E402

try:
    import cv2  # noqa: E402
except Exception:  # pragma: no cover - optional
    cv2 = None
try:
    from PIL import Image as PILImage  # noqa: E402
    import io  # noqa: E402
except Exception:  # pragma: no cover - optional
    PILImage = None


def log(*args):
    print('[ros_backend]', *args, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Output channel
# --------------------------------------------------------------------------

def _sanitize(o):
    if isinstance(o, float):
        if math.isfinite(o):
            return o
        return 'NaN' if math.isnan(o) else ('Infinity' if o > 0 else '-Infinity')
    if isinstance(o, dict):
        return {k: _sanitize(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_sanitize(v) for v in o]
    return o


def emit(obj, payload=b''):
    try:
        j = json.dumps(obj, separators=(',', ':'), allow_nan=False)
    except ValueError:
        j = json.dumps(_sanitize(obj), separators=(',', ':'), allow_nan=False)
    jb = j.encode('utf-8')
    with _proto_lock:
        try:
            _proto.write(struct.pack('>II', len(jb), len(payload)))
            _proto.write(jb)
            if payload:
                _proto.write(payload)
            _proto.flush()
        except (BrokenPipeError, OSError):
            os._exit(0)


# --------------------------------------------------------------------------
# Message <-> plain data
# --------------------------------------------------------------------------

_SEQ_TYPES = (list, tuple, array.array, np.ndarray)


def to_plain(v, limit=None):
    """Convert a ROS message (or field value) into JSON-friendly data.

    Sequences longer than `limit` are replaced by
    {"__truncated__": true, "length": n, "head": [...first `limit` items]}.
    """
    if hasattr(v, 'get_fields_and_field_types'):
        return {f: to_plain(getattr(v, f), limit) for f in v.get_fields_and_field_types()}
    if isinstance(v, bool):
        return v
    if isinstance(v, float):
        if math.isfinite(v):
            return v
        return 'NaN' if math.isnan(v) else ('Infinity' if v > 0 else '-Infinity')
    if isinstance(v, (int, str)):
        return v
    if isinstance(v, (bytes, bytearray)):
        if len(v) == 1:
            return v[0]
        seq = list(v)
        if limit is not None and len(seq) > limit:
            return {'__truncated__': True, 'length': len(seq), 'head': seq[:limit]}
        return seq
    if isinstance(v, _SEQ_TYPES):
        n = len(v)
        if limit is not None and n > limit:
            return {'__truncated__': True, 'length': n,
                    'head': [to_plain(x, limit) for x in v[:limit]]}
        if isinstance(v, np.ndarray) and v.dtype.kind in 'iuf' and v.ndim == 1:
            return [to_plain(x) for x in v.tolist()]
        return [to_plain(x, limit) for x in v]
    if isinstance(v, np.generic):
        return to_plain(v.item(), limit)
    return str(v)


def fields_schema(cls, depth=0):
    """Recursive field schema {name: {type, children?}} for UI field pickers."""
    out = {}
    if depth > 8:
        return out
    for name, typ in cls.get_fields_and_field_types().items():
        entry = {'type': typ}
        base = typ.split('<')[0].split('[')[0]
        if '/' in base:
            try:
                parts = base.split('/')
                sub = get_message(f'{parts[0]}/msg/{parts[-1]}')
                entry['children'] = fields_schema(sub, depth + 1)
            except Exception:
                pass
        out[name] = entry
    return out


def parse_path(path):
    """'pose.position.x' / 'ranges[3]' / 'a.b[2].c' -> list of str|int tokens."""
    tokens = []
    for part in path.replace(']', '').split('.'):
        if not part:
            continue
        sub = part.split('[')
        if sub[0]:
            tokens.append(sub[0])
        for idx in sub[1:]:
            tokens.append(int(idx))
    return tokens


def resolve_path(msg, tokens):
    v = msg
    for t in tokens:
        if isinstance(t, int):
            v = v[t]
        else:
            v = getattr(v, t)
    return v


def to_number(v):
    if isinstance(v, (bool, np.bool_)):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float, np.integer, np.floating)):
        f = float(v)
        return f if math.isfinite(f) else None
    if isinstance(v, (bytes, bytearray)) and len(v) == 1:
        return float(v[0])
    if hasattr(v, 'sec') and hasattr(v, 'nanosec'):
        return v.sec + v.nanosec * 1e-9
    return None


def stamp_of(msg):
    h = getattr(msg, 'header', None)
    s = getattr(h, 'stamp', None) if h is not None else None
    if s is None or not hasattr(s, 'sec'):
        return None
    t = s.sec + s.nanosec * 1e-9
    return t if t > 0 else None


# --------------------------------------------------------------------------
# Statistics
# --------------------------------------------------------------------------

class TopicStats:
    WINDOW = 5.0
    MAX_SAMPLES = 20000

    def __init__(self):
        self.times = deque()
        self.sizes = deque()
        self.count = 0
        self.last = None
        self.delays = deque(maxlen=200)

    def add(self, t, size):
        self.times.append(t)
        self.sizes.append(size)
        self.count += 1
        self.last = t
        lim = t - self.WINDOW
        while self.times and (self.times[0] < lim or len(self.times) > self.MAX_SAMPLES):
            self.times.popleft()
            self.sizes.popleft()

    def summary(self, now):
        n = len(self.times)
        out = {'count': self.count, 'hz': 0.0, 'bw': 0.0, 'size': 0,
               'age': None if self.last is None else now - self.last}
        if n:
            out['size'] = sum(self.sizes) / n
        if n >= 2:
            span = self.times[-1] - self.times[0]
            periods = np.diff(np.fromiter(self.times, dtype=np.float64, count=n))
            mean = float(periods.mean())
            stale = (now - self.last) > max(2.0, 4.0 * mean)
            if span > 0 and not stale:
                out['hz'] = (n - 1) / span
                out['bw'] = sum(self.sizes) / max(span, now - self.times[0])
            out['min'] = float(periods.min())
            out['max'] = float(periods.max())
            out['std'] = float(periods.std())
            out['mean'] = mean
            out['stale'] = stale
        if self.delays:
            d = list(self.delays)
            out['delay'] = d[-1]
            out['delayAvg'] = sum(d) / len(d)
        return out


# --------------------------------------------------------------------------
# Consumers (one per webview subscription)
# --------------------------------------------------------------------------

class Consumer:
    default_rate = 10.0
    flow = False

    def __init__(self, backend, sub_id, opts):
        self.backend = backend
        self.sub_id = sub_id
        self.opts = dict(opts or {})
        self.last_sent = 0.0
        self.inflight_since = None

    @property
    def max_rate(self):
        r = self.opts.get('maxRate', self.default_rate)
        return float(r) if r is not None else 0.0

    def update(self, opts):
        self.opts.update(opts or {})

    def due(self, now):
        if self.flow and self.inflight_since is not None:
            if now - self.inflight_since < 2.0:
                return False
            self.inflight_since = None
        r = self.max_rate
        return r <= 0 or (now - self.last_sent) >= (1.0 / r) * 0.98

    def mark_sent(self, now):
        self.last_sent = now
        if self.flow:
            self.inflight_since = now

    def ack(self):
        self.inflight_since = None

    def handle(self, msg, now, type_name):
        raise NotImplementedError

    def tick(self, now):
        pass


class StatsConsumer(Consumer):
    def due(self, now):
        return False

    def handle(self, msg, now, type_name):
        pass


class JsonConsumer(Consumer):
    default_rate = 10.0

    def handle(self, msg, now, type_name):
        limit = int(self.opts.get('arrayLimit', 64))
        emit({'ev': 'msg', 'subId': self.sub_id, 't': time.time(), 'type': type_name,
              'msg': to_plain(msg, limit)})
        self.mark_sent(now)


class PlotConsumer(Consumer):
    default_rate = 0.0  # every message

    def __init__(self, backend, sub_id, opts):
        super().__init__(backend, sub_id, opts)
        self.buf_t = []
        self.buf_v = []
        self._compile()

    def _compile(self):
        self.paths = list(self.opts.get('fields') or [])
        self.tokens = []
        for p in self.paths:
            try:
                self.tokens.append(parse_path(p))
            except Exception:
                self.tokens.append(None)

    def update(self, opts):
        super().update(opts)
        self._compile()

    def handle(self, msg, now, type_name):
        t = None
        if self.opts.get('useHeaderStamp'):
            t = stamp_of(msg)
        if t is None:
            t = time.time()
        vals = []
        for tok in self.tokens:
            try:
                vals.append(to_number(resolve_path(msg, tok)) if tok is not None else None)
            except Exception:
                vals.append(None)
        self.buf_t.append(t)
        self.buf_v.append(vals)
        self.mark_sent(now)
        if len(self.buf_t) > 5000:
            self.tick(now)

    def tick(self, now):
        if not self.buf_t:
            return
        emit({'ev': 'plot', 'subId': self.sub_id, 'fields': self.paths,
              't': self.buf_t, 'v': self.buf_v})
        self.buf_t, self.buf_v = [], []


class TfConsumer(Consumer):
    """Aggregates tf2_msgs/TFMessage into a frame tree summary (1 Hz)."""
    default_rate = 0.0

    def __init__(self, backend, sub_id, opts):
        super().__init__(backend, sub_id, opts)
        self.frames = {}
        self.last_emit = 0.0

    def handle(self, msg, now, type_name):
        for tr in getattr(msg, 'transforms', []):
            child = tr.child_frame_id.lstrip('/')
            parent = tr.header.frame_id.lstrip('/')
            f = self.frames.get(child)
            if f is None:
                f = self.frames[child] = {'parent': parent, 'times': deque(maxlen=200), 'count': 0}
            f['parent'] = parent
            f['times'].append(now)
            f['count'] += 1
            t = tr.transform.translation
            r = tr.transform.rotation
            f['t'] = [t.x, t.y, t.z]
            f['q'] = [r.x, r.y, r.z, r.w]
            f['stamp'] = tr.header.stamp.sec + tr.header.stamp.nanosec * 1e-9
        self.mark_sent(now)

    def tick(self, now):
        if now - self.last_emit < 1.0:
            return
        self.last_emit = now
        out = {}
        for child, f in self.frames.items():
            ts = f['times']
            hz = 0.0
            if len(ts) >= 2 and (now - ts[-1]) < 5.0 and ts[-1] > ts[0]:
                hz = (len(ts) - 1) / (ts[-1] - ts[0])
            out[child] = {'parent': f['parent'], 'hz': hz, 'count': f['count'],
                          't': f.get('t'), 'q': f.get('q'), 'stamp': f.get('stamp'),
                          'age': now - ts[-1] if ts else None}
        emit({'ev': 'tf', 'subId': self.sub_id, 'frames': out})


_COLORMAPS = {}


def _colormap_lut(name):
    """256x3 uint8 LUT. Uses OpenCV maps when available, else approximations."""
    if name in _COLORMAPS:
        return _COLORMAPS[name]
    x = np.linspace(0.0, 1.0, 256)
    if name == 'gray':
        lut = np.stack([x, x, x], -1)
    elif cv2 is not None and name in ('turbo', 'jet', 'viridis', 'inferno'):
        code = {'turbo': cv2.COLORMAP_TURBO, 'jet': cv2.COLORMAP_JET,
                'viridis': cv2.COLORMAP_VIRIDIS, 'inferno': cv2.COLORMAP_INFERNO}[name]
        bgr = cv2.applyColorMap(np.arange(256, dtype=np.uint8).reshape(-1, 1), code).reshape(256, 3)
        lut = bgr[:, ::-1].astype(np.float64) / 255.0
    else:  # jet-like fallback
        r = np.clip(1.5 - np.abs(4 * x - 3), 0, 1)
        g = np.clip(1.5 - np.abs(4 * x - 2), 0, 1)
        b = np.clip(1.5 - np.abs(4 * x - 1), 0, 1)
        lut = np.stack([r, g, b], -1)
    lut = (lut * 255).astype(np.uint8)
    _COLORMAPS[name] = lut
    return lut


_ENC = {
    'rgb8': (np.uint8, 3, 'rgb'), 'bgr8': (np.uint8, 3, 'bgr'),
    'rgba8': (np.uint8, 4, 'rgba'), 'bgra8': (np.uint8, 4, 'bgra'),
    'rgb16': (np.uint16, 3, 'rgb'), 'bgr16': (np.uint16, 3, 'bgr'),
    'rgba16': (np.uint16, 4, 'rgba'), 'bgra16': (np.uint16, 4, 'bgra'),
    'mono8': (np.uint8, 1, 'mono'), 'mono16': (np.uint16, 1, 'mono'),
    '8UC1': (np.uint8, 1, 'mono'), '8UC3': (np.uint8, 3, 'bgr'), '8UC4': (np.uint8, 4, 'bgra'),
    '8SC1': (np.int8, 1, 'mono'),
    '16UC1': (np.uint16, 1, 'mono'), '16SC1': (np.int16, 1, 'mono'),
    '32SC1': (np.int32, 1, 'mono'), '32FC1': (np.float32, 1, 'mono'),
    '64FC1': (np.float64, 1, 'mono'),
    'bayer_rggb8': (np.uint8, 1, 'bayer_rggb'), 'bayer_bggr8': (np.uint8, 1, 'bayer_bggr'),
    'bayer_gbrg8': (np.uint8, 1, 'bayer_gbrg'), 'bayer_grbg8': (np.uint8, 1, 'bayer_grbg'),
    'yuv422': (np.uint8, 2, 'uyvy'), 'uyvy': (np.uint8, 2, 'uyvy'),
    'yuv422_yuy2': (np.uint8, 2, 'yuyv'), 'yuyv': (np.uint8, 2, 'yuyv'),
}


# Default JPEG quality for streamed images (setting rosVis.image.jpegQuality).
try:
    JPEG_QUALITY = min(100, max(10, int(os.environ.get('ROS_VIS_JPEG_QUALITY', '85'))))
except ValueError:
    JPEG_QUALITY = 85


class ImageConsumer(Consumer):
    """Streams sensor_msgs/Image, CompressedImage and nav_msgs/OccupancyGrid
    to the webview as browser-decodable JPEG/PNG (or raw RGBA fallback)."""
    default_rate = 30.0
    flow = True

    def handle(self, msg, now, type_name):
        try:
            if type_name.endswith('/CompressedImage'):
                head, payload = self._compressed(msg)
            elif type_name.endswith('/OccupancyGrid'):
                head, payload = self._grid(msg)
            else:
                head, payload = self._raw(msg)
        except Exception as e:  # report and keep streaming
            emit({'ev': 'subError', 'subId': self.sub_id, 'error': f'image decode: {e}'})
            self.mark_sent(now)
            self.inflight_since = None
            return
        h = getattr(msg, 'header', None)
        head.update({'ev': 'msg', 'subId': self.sub_id, 'kind': 'image', 'type': type_name,
                     'frameId': getattr(h, 'frame_id', '') if h is not None else '',
                     'stamp': stamp_of(msg), 't': time.time()})
        emit(head, payload)
        self.mark_sent(now)

    # -- helpers ---------------------------------------------------------
    def _scale_to_u8(self, a, valid=None):
        a = a.astype(np.float32)
        mask = np.isfinite(a) if valid is None else (valid & np.isfinite(a))
        if self.opts.get('autoRange', True) or self.opts.get('min') is None:
            vals = a[mask]
            lo, hi = (float(vals.min()), float(vals.max())) if vals.size else (0.0, 1.0)
        else:
            lo, hi = float(self.opts.get('min', 0)), float(self.opts.get('max', 1))
        if hi <= lo:
            hi = lo + 1e-6
        a = np.where(mask, a, lo)
        u8 = np.clip((a - lo) * (255.0 / (hi - lo)), 0, 255).astype(np.uint8)
        u8[~mask] = 0
        return u8, lo, hi, mask

    def _encode(self, rgb):
        """rgb: HxWx3 uint8 (RGB order) -> (format, bytes)."""
        max_w = int(self.opts.get('maxWidth') or 0)
        if max_w and rgb.shape[1] > max_w:
            f = max_w / rgb.shape[1]
            nh = max(1, int(rgb.shape[0] * f))
            if cv2 is not None:
                rgb = cv2.resize(rgb, (max_w, nh), interpolation=cv2.INTER_AREA)
            else:
                ys = (np.arange(nh) / f).astype(int)
                xs = (np.arange(max_w) / f).astype(int)
                rgb = rgb[ys][:, xs]
        fmt = self.opts.get('format', 'jpeg')
        q = int(self.opts.get('quality', JPEG_QUALITY))
        if cv2 is not None:
            bgr = np.ascontiguousarray(rgb[:, :, ::-1])
            if fmt == 'png':
                ok, buf = cv2.imencode('.png', bgr)
                return 'png', buf.tobytes()
            ok, buf = cv2.imencode('.jpg', bgr, [cv2.IMWRITE_JPEG_QUALITY, q])
            return 'jpeg', buf.tobytes()
        if PILImage is not None:
            bio = io.BytesIO()
            im = PILImage.fromarray(np.ascontiguousarray(rgb), 'RGB')
            if fmt == 'png':
                im.save(bio, format='PNG')
                return 'png', bio.getvalue()
            im.save(bio, format='JPEG', quality=q)
            return 'jpeg', bio.getvalue()
        rgba = np.concatenate([rgb, np.full(rgb.shape[:2] + (1,), 255, np.uint8)], -1)
        return 'rgba', np.ascontiguousarray(rgba).tobytes()

    def _colorize(self, u8):
        lut = _colormap_lut(self.opts.get('colormap', 'turbo'))
        return lut[u8]

    def _raw(self, msg):
        enc = msg.encoding
        h, w, step = msg.height, msg.width, msg.step
        if enc not in _ENC:
            raise ValueError(f'unsupported encoding "{enc}"')
        dtype, ch, order = _ENC[enc]
        dt = np.dtype(dtype)
        if dt.itemsize > 1:
            dt = dt.newbyteorder('>' if msg.is_bigendian else '<')
        buf = np.frombuffer(bytes(msg.data) if not isinstance(msg.data, (bytes, array.array))
                            else msg.data, dtype=np.uint8)
        rows = buf[: h * step].reshape(h, step)[:, : w * ch * dt.itemsize]
        a = np.ascontiguousarray(rows).view(dt).reshape(h, w, ch)
        head = {'width': w, 'height': h, 'encoding': enc}
        if order in ('uyvy', 'yuyv'):
            if cv2 is None:
                raise ValueError('YUV images require OpenCV')
            code = cv2.COLOR_YUV2RGB_UYVY if order == 'uyvy' else cv2.COLOR_YUV2RGB_YUY2
            rgb = cv2.cvtColor(a.reshape(h, w, 2), code)
        elif order.startswith('bayer'):
            if cv2 is None:
                raise ValueError('Bayer images require OpenCV')
            code = {'bayer_rggb': cv2.COLOR_BayerRG2RGB, 'bayer_bggr': cv2.COLOR_BayerBG2RGB,
                    'bayer_gbrg': cv2.COLOR_BayerGB2RGB, 'bayer_grbg': cv2.COLOR_BayerGR2RGB}[order]
            # OpenCV bayer naming is shifted by one pixel relative to ROS naming
            code = {cv2.COLOR_BayerRG2RGB: cv2.COLOR_BayerBG2RGB,
                    cv2.COLOR_BayerBG2RGB: cv2.COLOR_BayerRG2RGB,
                    cv2.COLOR_BayerGB2RGB: cv2.COLOR_BayerGR2RGB,
                    cv2.COLOR_BayerGR2RGB: cv2.COLOR_BayerGB2RGB}[code]
            rgb = cv2.cvtColor(a.reshape(h, w), code)
        elif ch == 1:
            mono = a[:, :, 0]
            if dt.kind == 'u' and dt.itemsize == 1 and not self.opts.get('forceColormap'):
                rgb = np.repeat(mono[:, :, None], 3, axis=2)
            else:
                valid = mono != 0 if enc in ('16UC1', 'mono16', '32FC1') else None
                u8, lo, hi, _ = self._scale_to_u8(mono, valid)
                rgb = self._colorize(u8)
                head.update({'min': lo, 'max': hi, 'colormapped': True})
        else:
            if dt.itemsize > 1:
                a = (a.astype(np.float32) / (np.iinfo(dt).max / 255.0)).astype(np.uint8)
            if order in ('bgr', 'bgra'):
                rgb = a[:, :, 2::-1] if ch >= 3 else a
            else:
                rgb = a[:, :, :3]
        fmt, payload = self._encode(rgb)
        head['format'] = fmt
        head['outWidth'] = int(rgb.shape[1]) if fmt != 'rgba' else int(rgb.shape[1])
        head['outHeight'] = int(rgb.shape[0])
        return head, payload

    def _compressed(self, msg):
        fmt = (msg.format or '').lower()
        data = bytes(msg.data) if not isinstance(msg.data, bytes) else msg.data
        head = {'encoding': msg.format}
        if 'compresseddepth' in fmt:
            if cv2 is None:
                raise ValueError('compressedDepth requires OpenCV')
            depth = cv2.imdecode(np.frombuffer(data[12:], np.uint8), cv2.IMREAD_UNCHANGED)
            if depth is None:
                raise ValueError('cannot decode compressedDepth payload')
            u8, lo, hi, _ = self._scale_to_u8(depth, depth != 0)
            rgb = self._colorize(u8)
            out_fmt, payload = self._encode(rgb)
            head.update({'width': depth.shape[1], 'height': depth.shape[0], 'format': out_fmt,
                         'min': lo, 'max': hi, 'colormapped': True,
                         'outWidth': rgb.shape[1], 'outHeight': rgb.shape[0]})
            return head, payload
        if data[:3] == b'\xff\xd8\xff':
            head['format'] = 'jpeg'
        elif data[:8] == b'\x89PNG\r\n\x1a\n':
            head['format'] = 'png'
        elif 'png' in fmt:
            head['format'] = 'png'
        else:
            head['format'] = 'jpeg'
        return head, data

    def _grid(self, msg):
        w, h = msg.info.width, msg.info.height
        d = np.asarray(msg.data, dtype=np.int8).reshape(h, w)
        rgb = np.empty((h, w, 3), np.uint8)
        rgb[:] = 128
        known = d >= 0
        v = (255 - (np.clip(d.astype(np.int16), 0, 100) * 255 // 100)).astype(np.uint8)
        rgb[known] = v[known][:, None]
        rgb = rgb[::-1]  # grid origin is bottom-left
        fmt, payload = self._encode(rgb)
        return {'width': w, 'height': h, 'encoding': f'occupancy {msg.info.resolution:.3f} m/cell',
                'format': fmt, 'outWidth': w, 'outHeight': h}, payload


_PF_DTYPES = {1: np.int8, 2: np.uint8, 3: np.int16, 4: np.uint16,
              5: np.int32, 6: np.uint32, 7: np.float32, 8: np.float64}


class CloudConsumer(Consumer):
    """sensor_msgs/PointCloud2 and LaserScan -> float32 xyz + color/scalar."""
    default_rate = 10.0
    flow = True

    def handle(self, msg, now, type_name):
        try:
            if type_name.endswith('/LaserScan'):
                head, payload = self._scan(msg)
            else:
                head, payload = self._cloud(msg)
        except Exception as e:
            emit({'ev': 'subError', 'subId': self.sub_id, 'error': f'cloud decode: {e}'})
            self.mark_sent(now)
            self.inflight_since = None
            return
        head.update({'ev': 'msg', 'subId': self.sub_id, 'kind': 'cloud', 'type': type_name,
                     'frameId': msg.header.frame_id, 'stamp': stamp_of(msg), 't': time.time()})
        emit(head, payload)
        self.mark_sent(now)

    def _finish(self, xyz, scalar, rgb, head):
        n0 = xyz.shape[0]
        mask = np.isfinite(xyz).all(axis=1)
        xyz = xyz[mask]
        scalar = scalar[mask] if scalar is not None else None
        rgb = rgb[mask] if rgb is not None else None
        max_pts = int(self.opts.get('maxPoints', 300000))
        if max_pts > 0 and xyz.shape[0] > max_pts:
            stride = int(math.ceil(xyz.shape[0] / max_pts))
            xyz = xyz[::stride]
            scalar = scalar[::stride] if scalar is not None else None
            rgb = rgb[::stride] if rgb is not None else None
        n = int(xyz.shape[0])
        parts = [np.ascontiguousarray(xyz, dtype=np.float32).tobytes()]
        head.update({'n': n, 'total': int(n0)})
        if rgb is not None:
            head['color'] = 'rgb'
            parts.append(np.ascontiguousarray(rgb, dtype=np.uint8).tobytes())
        elif scalar is not None:
            s = scalar.astype(np.float32)
            fin = s[np.isfinite(s)]
            head['color'] = 'scalar'
            head['min'] = float(fin.min()) if fin.size else 0.0
            head['max'] = float(fin.max()) if fin.size else 1.0
            parts.append(np.ascontiguousarray(s).tobytes())
        else:
            head['color'] = 'none'
        if n:
            head['bounds'] = [xyz.min(axis=0).astype(float).tolist(),
                              xyz.max(axis=0).astype(float).tolist()]
        return head, b''.join(parts)

    def _cloud(self, msg):
        names, formats, offsets = [], [], []
        endian = '>' if msg.is_bigendian else '<'
        for f in msg.fields:
            base = _PF_DTYPES.get(f.datatype)
            if base is None or f.name in names:
                continue
            dt = np.dtype(base).newbyteorder(endian)
            names.append(f.name)
            formats.append(dt if f.count <= 1 else (dt, (f.count,)))
            offsets.append(f.offset)
        if not all(k in names for k in ('x', 'y', 'z')):
            raise ValueError('PointCloud2 has no x/y/z fields')
        dt = np.dtype({'names': names, 'formats': formats, 'offsets': offsets,
                       'itemsize': msg.point_step})
        n = msg.width * msg.height
        raw = msg.data if isinstance(msg.data, (bytes, array.array)) else bytes(msg.data)
        buf = np.frombuffer(raw, dtype=np.uint8)
        if msg.height > 1 and msg.row_step != msg.width * msg.point_step:
            buf = np.ascontiguousarray(
                buf[: msg.height * msg.row_step].reshape(msg.height, msg.row_step)
                [:, : msg.width * msg.point_step]).reshape(-1)
        pts = np.frombuffer(buf[: n * msg.point_step], dtype=dt, count=n)
        xyz = np.empty((n, 3), np.float32)
        xyz[:, 0] = pts['x']
        xyz[:, 1] = pts['y']
        xyz[:, 2] = pts['z']
        field = self.opts.get('colorField') or 'auto'
        scalar_names = [nm for nm, fm in zip(names, formats) if not isinstance(fm, tuple)]
        if field == 'auto':
            for cand in ('rgb', 'rgba', 'intensity', 'z'):
                if cand in names:
                    field = cand
                    break
        rgb = scalar = None
        if field in ('rgb', 'rgba') and field in names:
            packed = np.ascontiguousarray(pts[field]).view(np.uint32)
            rgb = np.empty((n, 3), np.uint8)
            rgb[:, 0] = (packed >> 16) & 0xFF
            rgb[:, 1] = (packed >> 8) & 0xFF
            rgb[:, 2] = packed & 0xFF
        elif field in scalar_names:
            scalar = np.asarray(pts[field], dtype=np.float32)
        elif field == 'range':
            scalar = np.linalg.norm(xyz, axis=1)
        head = {'fields': scalar_names + ['range'], 'colorField': field,
                'width': msg.width, 'height': msg.height}
        return self._finish(xyz, scalar, rgb, head)

    def _scan(self, msg):
        r = np.asarray(msg.ranges, dtype=np.float32)
        a = msg.angle_min + np.arange(r.size, dtype=np.float32) * msg.angle_increment
        valid = np.isfinite(r) & (r >= msg.range_min) & (r <= msg.range_max)
        xyz = np.zeros((r.size, 3), np.float32)
        xyz[:, 0] = r * np.cos(a)
        xyz[:, 1] = r * np.sin(a)
        xyz[~valid] = np.nan
        field = self.opts.get('colorField') or 'auto'
        inten = np.asarray(msg.intensities, dtype=np.float32)
        if field in ('auto', 'intensity') and inten.size == r.size and inten.size:
            scalar, field = inten, 'intensity'
        else:
            scalar, field = r, 'range'
        head = {'fields': ['range', 'intensity'] if inten.size == r.size else ['range'],
                'colorField': field, 'width': r.size, 'height': 1}
        return self._finish(xyz, scalar, None, head)


CONSUMERS = {
    'stats': StatsConsumer, 'json': JsonConsumer, 'plot': PlotConsumer,
    'image': ImageConsumer, 'cloud': CloudConsumer, 'tf': TfConsumer,
}


# --------------------------------------------------------------------------
# Topic subscriptions (shared across consumers)
# --------------------------------------------------------------------------

class TopicSub:
    def __init__(self, backend, topic, type_name):
        self.backend = backend
        self.topic = topic
        self.type_name = type_name
        self.cls = None
        self.sub = None
        self.qos_key = None
        self.consumers = {}
        self.stats = TopicStats()
        self.error = None

    def ensure(self):
        """Create/recreate the rclpy subscription when type and QoS are known."""
        b = self.backend
        if self.type_name is None:
            types = b.topic_types.get(self.topic)
            if not types:
                return
            self.type_name = types[0]
        if self.cls is None:
            try:
                self.cls = get_message(self.type_name)
            except Exception as e:
                if self.error is None:
                    self.error = f'cannot load type {self.type_name}: {e} (source your workspace?)'
                    for c in self.consumers.values():
                        emit({'ev': 'subError', 'subId': c.sub_id, 'error': self.error})
                return
        qos, key = b.qos_for(self.topic)
        if self.sub is not None and key == self.qos_key:
            return
        if self.sub is not None:
            b.node.destroy_subscription(self.sub)
            self.sub = None
        self.qos_key = key
        self.sub = b.node.create_subscription(
            self.cls, self.topic, self._on_raw, qos, raw=True)
        for c in self.consumers.values():
            emit({'ev': 'subInfo', 'subId': c.sub_id, 'topic': self.topic,
                  'type': self.type_name, 'qos': key})

    def destroy(self):
        if self.sub is not None:
            self.backend.node.destroy_subscription(self.sub)
            self.sub = None

    def _on_raw(self, data):
        now = time.monotonic()
        self.stats.add(now, len(data))
        due = [c for c in self.consumers.values() if c.due(now)]
        if not due:
            return
        try:
            msg = deserialize_message(data, self.cls)
        except Exception as e:
            for c in due:
                emit({'ev': 'subError', 'subId': c.sub_id, 'error': f'deserialize: {e}'})
            return
        st = stamp_of(msg)
        if st is not None:
            self.stats.delays.append(time.time() - st)
        for c in due:
            try:
                c.handle(msg, now, self.type_name)
            except Exception as e:
                log('consumer error', self.topic, e, traceback.format_exc())
                emit({'ev': 'subError', 'subId': c.sub_id, 'error': str(e)})


# --------------------------------------------------------------------------
# Backend
# --------------------------------------------------------------------------

class Binary:
    """Reply carrying a binary payload next to the JSON result."""
    __slots__ = ('result', 'payload')

    def __init__(self, result, payload):
        self.result = result
        self.payload = payload


# Files the webview may request through readResource (URDF meshes and textures).
RESOURCE_EXT = {'.stl', '.dae', '.obj', '.mtl', '.glb', '.gltf', '.bin', '.ply',
                '.png', '.jpg', '.jpeg', '.tga', '.bmp'}
MAX_RESOURCE_BYTES = 256 * 1024 * 1024


class Backend:
    def __init__(self):
        rclpy.init(args=None)
        self.node = Node(f'_vscode_ros_vis_{os.getpid()}')
        self.self_fqn = self.node.get_fully_qualified_name()
        self.executor = SingleThreadedExecutor()
        self.executor.add_node(self.node)
        self.cmd_q = queue.Queue()
        self.gc = self.node.create_guard_condition(self._drain)
        self.exiting = False
        self.subs = {}          # (topic, type|None) -> TopicSub
        self.consumers = {}     # subId -> (TopicSub, Consumer)
        self.publishers = {}    # pubId -> dict
        self.clients = {}       # (service, type) -> client
        self.param_clients = {}
        self.topic_types = {}
        self.graph_sig = None
        self.graph = None
        poll = float(os.environ.get('ROS_VIS_GRAPH_POLL', '1.0'))
        self.node.create_timer(poll, self._poll_graph)
        self.node.create_timer(1.0, self._emit_stats)
        self.node.create_timer(0.05, self._tick_consumers)

    # ---- plumbing ------------------------------------------------------
    def reader(self):
        for line in sys.stdin.buffer:
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
            except Exception as e:
                log('bad command', e)
                continue
            self.cmd_q.put(cmd)
            self.gc.trigger()
        self.cmd_q.put({'op': '__exit__'})
        try:
            self.gc.trigger()
        except Exception:
            pass

    def _drain(self):
        while True:
            try:
                cmd = self.cmd_q.get_nowait()
            except queue.Empty:
                return
            if callable(cmd):
                cmd()
                continue
            self._dispatch(cmd)

    def _dispatch(self, cmd):
        op = cmd.get('op', '')
        rid = cmd.get('id')
        if op == '__exit__':
            self.exiting = True
            return
        fn = getattr(self, 'op_' + op.replace('.', '_'), None)
        if fn is None:
            self._reply(rid, error=f'unknown op {op}')
            return
        try:
            res = fn(cmd)
        except Exception as e:
            log(f'op {op} failed:', traceback.format_exc())
            self._reply(rid, error=str(e) or e.__class__.__name__)
            return
        if inspect.iscoroutine(res):
            self.executor.create_task(self._run_async(res, rid, op))
        else:
            self._reply(rid, result=res)

    async def _run_async(self, coro, rid, op):
        try:
            res = await coro
        except Exception as e:
            log(f'op {op} failed:', traceback.format_exc())
            self._reply(rid, error=str(e) or e.__class__.__name__)
            return
        self._reply(rid, result=res)

    def _reply(self, rid, result=None, error=None):
        if rid is None:
            if error:
                emit({'ev': 'log', 'level': 'error', 'text': error})
            return
        if error is not None:
            emit({'id': rid, 'ok': False, 'error': error})
        elif isinstance(result, Binary):
            emit({'id': rid, 'ok': True, 'result': result.result}, result.payload)
        else:
            emit({'id': rid, 'ok': True, 'result': result})

    def _call_soon(self, fn):
        """Runs `fn` on the executor thread (thread-safe)."""
        self.cmd_q.put(fn)
        self.gc.trigger()

    async def _in_thread(self, fn, *args):
        """Runs blocking `fn` in a worker thread without stalling the executor."""
        fut = Future(executor=self.executor)

        def work():
            try:
                res = fn(*args)
                self._call_soon(lambda: fut.done() or fut.set_result(res))
            except Exception as e:  # noqa: BLE001 - forwarded to the caller
                self._call_soon(lambda e=e: fut.done() or fut.set_exception(e))

        threading.Thread(target=work, daemon=True).start()
        return await fut

    async def _await(self, fut, timeout):
        """Await an rclpy future with a timeout (seconds)."""
        out = Future(executor=self.executor)
        timer = None

        def done(f):
            if out.done():
                return
            exc = f.exception()
            if exc is not None:
                out.set_exception(exc)
            else:
                out.set_result(f.result())

        def expired():
            timer.cancel()
            if not out.done():
                out.set_exception(TimeoutError(f'timed out after {timeout:.1f}s'))

        fut.add_done_callback(done)
        timer = self.node.create_timer(timeout, expired)
        try:
            return await out
        finally:
            timer.cancel()
            self.node.destroy_timer(timer)

    async def _sleep(self, dt):
        fut = Future(executor=self.executor)
        timer = None

        def fire():
            timer.cancel()
            if not fut.done():
                fut.set_result(None)

        timer = self.node.create_timer(dt, fire)
        try:
            await fut
        finally:
            self.node.destroy_timer(timer)

    def run(self):
        threading.Thread(target=self.reader, daemon=True).start()
        emit({'ev': 'ready', 'info': self.info()})
        self._poll_graph()
        try:
            while rclpy.ok() and not self.exiting:
                self.executor.spin_once(timeout_sec=0.1)
        except (KeyboardInterrupt, ExternalShutdownException):
            pass
        finally:
            for s in list(self.subs.values()):
                s.destroy()
            try:
                self.node.destroy_node()
                rclpy.try_shutdown()
            except Exception:
                pass

    def info(self):
        try:
            import rclpy.utilities
            rmw = rclpy.utilities.get_rmw_implementation_identifier()
        except Exception:
            rmw = os.environ.get('RMW_IMPLEMENTATION', '')
        return {'distro': os.environ.get('ROS_DISTRO', ''), 'rmw': rmw,
                'domainId': int(os.environ.get('ROS_DOMAIN_ID', '0') or 0),
                'node': self.self_fqn, 'pid': os.getpid(),
                'python': sys.version.split()[0],
                'opencv': cv2.__version__ if cv2 is not None else None}

    # ---- graph ---------------------------------------------------------
    def _by_node(self, fn, name, ns):
        try:
            return [[t, list(ty)] for t, ty in fn(name, ns)]
        except Exception:
            return []

    def _snapshot(self):
        n = self.node
        from rclpy.action import (get_action_client_names_and_types_by_node,
                                  get_action_names_and_types,
                                  get_action_server_names_and_types_by_node)
        nodes = []
        unique = {}
        for name, ns in n.get_node_names_and_namespaces():
            fqn = (ns.rstrip('/') + '/' + name) if ns != '/' else '/' + name
            if fqn in unique:
                unique[fqn][2] += 1  # several nodes share this exact name
            else:
                unique[fqn] = [name, ns, 1]
        for fqn, (name, ns, count) in unique.items():
            entry = {
                'name': name, 'ns': ns, 'fqn': fqn, 'self': fqn == self.self_fqn, 'count': count,
                'pubs': self._by_node(n.get_publisher_names_and_types_by_node, name, ns),
                'subs': self._by_node(n.get_subscriber_names_and_types_by_node, name, ns),
                'srvs': self._by_node(n.get_service_names_and_types_by_node, name, ns),
                'clients': self._by_node(n.get_client_names_and_types_by_node, name, ns),
            }
            try:
                entry['actionServers'] = [[a, list(t)] for a, t in
                                          get_action_server_names_and_types_by_node(n, name, ns)]
                entry['actionClients'] = [[a, list(t)] for a, t in
                                          get_action_client_names_and_types_by_node(n, name, ns)]
            except Exception:
                entry['actionServers'] = []
                entry['actionClients'] = []
            nodes.append(entry)
        topics = {}
        for t, types in n.get_topic_names_and_types():
            topics[t] = {'name': t, 'types': list(types), 'pubs': [], 'subs': []}
        for e in nodes:
            if e['self']:
                continue
            for t, ty in e['pubs']:
                topics.setdefault(t, {'name': t, 'types': ty, 'pubs': [], 'subs': []})['pubs'].append(e['fqn'])
            for t, ty in e['subs']:
                topics.setdefault(t, {'name': t, 'types': ty, 'pubs': [], 'subs': []})['subs'].append(e['fqn'])
        services = [{'name': s, 'types': list(t)} for s, t in n.get_service_names_and_types()]
        try:
            actions = [{'name': a, 'types': list(t)} for a, t in get_action_names_and_types(n)]
        except Exception:
            actions = []
        nodes.sort(key=lambda e: e['fqn'])
        return {'nodes': nodes, 'topics': sorted(topics.values(), key=lambda x: x['name']),
                'services': sorted(services, key=lambda x: x['name']),
                'actions': sorted(actions, key=lambda x: x['name']), 'self': self.self_fqn}

    def _poll_graph(self):
        try:
            g = self._snapshot()
        except Exception as e:
            log('graph poll failed', e)
            return
        self.topic_types = {t['name']: t['types'] for t in g['topics']}
        sig = json.dumps(g, sort_keys=True)
        changed = sig != self.graph_sig
        self.graph_sig = sig
        self.graph = g
        if changed:
            emit({'ev': 'graph', 'graph': g})
        # resolve pending types / adapt QoS to (late) publishers
        for s in list(self.subs.values()):
            if s.consumers:
                s.ensure()

    def qos_for(self, topic):
        reliability = ReliabilityPolicy.RELIABLE
        durability = DurabilityPolicy.VOLATILE
        try:
            infos = self.node.get_publishers_info_by_topic(topic)
        except Exception:
            infos = []
        infos = [i for i in infos if i.node_name != self.node.get_name()] or infos
        if infos:
            if any(i.qos_profile.reliability == ReliabilityPolicy.BEST_EFFORT for i in infos):
                reliability = ReliabilityPolicy.BEST_EFFORT
            if all(i.qos_profile.durability == DurabilityPolicy.TRANSIENT_LOCAL for i in infos):
                durability = DurabilityPolicy.TRANSIENT_LOCAL
        depth = 100 if topic in ('/rosout', '/tf', '/tf_static') else 10
        if durability == DurabilityPolicy.TRANSIENT_LOCAL and topic == '/rosout':
            depth = 1000
        qos = QoSProfile(history=HistoryPolicy.KEEP_LAST, depth=depth,
                         reliability=reliability, durability=durability)
        key = f"{'best_effort' if reliability == ReliabilityPolicy.BEST_EFFORT else 'reliable'}" \
              f"/{'transient_local' if durability == DurabilityPolicy.TRANSIENT_LOCAL else 'volatile'}"
        return qos, key

    def _emit_stats(self):
        now = time.monotonic()
        out = {}
        for s in self.subs.values():
            if s.consumers:
                out[s.topic] = s.stats.summary(now)
        if out:
            emit({'ev': 'stats', 'stats': out})

    def _tick_consumers(self):
        now = time.monotonic()
        for s, c in list(self.consumers.values()):
            try:
                c.tick(now)
            except Exception as e:
                log('tick error', e)

    # ---- ops: info -----------------------------------------------------
    def op_ping(self, cmd):
        return self.info()

    def op_graph(self, cmd):
        if self.graph is None:
            self._poll_graph()
        return self.graph

    def op_topicInfo(self, cmd):
        topic = cmd['topic']

        def qos_str(q):
            return {
                'reliability': q.reliability.name.lower(),
                'durability': q.durability.name.lower(),
                'history': q.history.name.lower(),
                'depth': q.depth,
            }

        def conv(infos):
            out = []
            for i in infos:
                ns = i.node_namespace
                fqn = (ns.rstrip('/') + '/' + i.node_name) if ns != '/' else '/' + i.node_name
                out.append({'node': fqn, 'type': i.topic_type, 'qos': qos_str(i.qos_profile),
                            'self': fqn == self.self_fqn})
            return out

        return {'topic': topic, 'types': self.topic_types.get(topic, []),
                'publishers': conv(self.node.get_publishers_info_by_topic(topic)),
                'subscribers': conv(self.node.get_subscriptions_info_by_topic(topic))}

    def op_interface(self, cmd):
        """Definition text, default value and field schema of a msg/srv/action type."""
        from rosidl_runtime_py import get_interface_path
        name = cmd['type']
        out = {'type': name}
        try:
            path = get_interface_path(name)
            with open(path, 'r', encoding='utf-8') as f:
                out['definition'] = f.read()
            out['path'] = path
        except Exception as e:
            out['definition'] = f'# definition file not found: {e}'
        kind = name.split('/')[1] if name.count('/') == 2 else 'msg'
        out['kind'] = kind
        if kind == 'msg':
            cls = get_message(name)
            out['default'] = to_plain(cls())
            out['schema'] = fields_schema(cls)
        elif kind == 'srv':
            cls = get_service(name)
            out['request'] = to_plain(cls.Request())
            out['response'] = to_plain(cls.Response())
            out['schema'] = fields_schema(cls.Request)
        return out

    def op_listInterfaces(self, cmd):
        from rosidl_runtime_py import get_message_interfaces, get_service_interfaces
        msgs, srvs = [], []
        for pkg, names in get_message_interfaces().items():
            msgs += [f'{pkg}/{n}' for n in names]
        for pkg, names in get_service_interfaces().items():
            srvs += [f'{pkg}/{n}' for n in names]
        return {'msgs': sorted(msgs), 'srvs': sorted(srvs)}

    # ---- ops: subscriptions --------------------------------------------
    def op_subscribe(self, cmd):
        sub_id = cmd['subId']
        topic = cmd['topic']
        type_name = cmd.get('type') or None
        mode = cmd.get('mode', 'json')
        if sub_id in self.consumers:
            self.op_unsubscribe({'subId': sub_id})
        cls = CONSUMERS.get(mode)
        if cls is None:
            raise ValueError(f'unknown mode {mode}')
        if type_name is None:
            types = self.topic_types.get(topic)
            type_name = types[0] if types else None
        # share one rclpy subscription per topic/type, including pending ones
        ts = None
        for cand in self.subs.values():
            if cand.topic == topic and (type_name is None or cand.type_name in (None, type_name)):
                ts = cand
                break
        if ts is None:
            ts = self.subs[(topic, type_name)] = TopicSub(self, topic, type_name)
        elif ts.type_name is None and type_name is not None:
            ts.type_name = type_name
        c = cls(self, sub_id, cmd.get('opts'))
        ts.consumers[sub_id] = c
        self.consumers[sub_id] = (ts, c)
        if ts.error:
            emit({'ev': 'subError', 'subId': sub_id, 'error': ts.error})
        ts.ensure()
        return {'topic': topic, 'type': ts.type_name, 'pending': ts.sub is None}

    def op_unsubscribe(self, cmd):
        entry = self.consumers.pop(cmd['subId'], None)
        if entry is None:
            return False
        ts, c = entry
        ts.consumers.pop(c.sub_id, None)
        if not ts.consumers:
            ts.destroy()
            for k in [k for k, v in self.subs.items() if v is ts]:
                del self.subs[k]
        return True

    def op_updateSub(self, cmd):
        entry = self.consumers.get(cmd['subId'])
        if entry:
            entry[1].update(cmd.get('opts'))
            entry[1].inflight_since = None
        return bool(entry)

    def op_ack(self, cmd):
        entry = self.consumers.get(cmd.get('subId'))
        if entry:
            entry[1].ack()

    # ---- ops: services -------------------------------------------------
    async def op_callService(self, cmd):
        service = cmd['service']
        type_name = cmd.get('type')
        if not type_name:
            for s in (self.graph or {}).get('services', []):
                if s['name'] == service and s['types']:
                    type_name = s['types'][0]
        if not type_name:
            raise ValueError(f'unknown type for service {service}')
        timeout = float(cmd.get('timeout', 5.0))
        srv = get_service(type_name)
        req = srv.Request()
        if cmd.get('request'):
            set_message_fields(req, cmd['request'])
        key = (service, type_name)
        client = self.clients.get(key)
        if client is None:
            client = self.clients[key] = self.node.create_client(srv, service)
        t0 = time.monotonic()
        while not client.service_is_ready():
            if time.monotonic() - t0 > timeout:
                raise TimeoutError(f'service {service} not available')
            await self._sleep(0.05)
        t1 = time.monotonic()
        res = await self._await(client.call_async(req), max(0.1, timeout - (t1 - t0)))
        return {'response': to_plain(res, 2000), 'elapsed': time.monotonic() - t1,
                'type': type_name}

    # ---- ops: publishers -----------------------------------------------
    def _qos_from(self, q):
        q = q or {}
        return QoSProfile(
            history=HistoryPolicy.KEEP_LAST, depth=int(q.get('depth', 10)),
            reliability=ReliabilityPolicy.BEST_EFFORT if q.get('reliability') == 'best_effort'
            else ReliabilityPolicy.RELIABLE,
            durability=DurabilityPolicy.TRANSIENT_LOCAL if q.get('durability') == 'transient_local'
            else DurabilityPolicy.VOLATILE)

    def _build_msg(self, cls, values, auto_stamp):
        msg = cls()
        if values:
            set_message_fields(msg, values)
        if auto_stamp:
            self._stamp(msg)
        return msg

    def _stamp(self, msg):
        h = getattr(msg, 'header', None)
        if h is not None and hasattr(h, 'stamp'):
            h.stamp = self.node.get_clock().now().to_msg()

    def op_startPublisher(self, cmd):
        pub_id = cmd['pubId']
        self.op_stopPublisher({'pubId': pub_id})
        cls = get_message(cmd['type'])
        msg = self._build_msg(cls, cmd.get('msg'), False)
        pub = self.node.create_publisher(cls, cmd['topic'], self._qos_from(cmd.get('qos')))
        entry = {'pub': pub, 'msg': msg, 'count': 0, 'timer': None,
                 'autoStamp': bool(cmd.get('autoStamp')), 'topic': cmd['topic']}
        self.publishers[pub_id] = entry

        def fire():
            if entry['autoStamp']:
                self._stamp(entry['msg'])
            pub.publish(entry['msg'])
            entry['count'] += 1
            if entry['count'] % max(1, int(rate or 1)) == 0 or not rate:
                emit({'ev': 'pubStatus', 'pubId': pub_id, 'count': entry['count']})

        rate = float(cmd.get('rate') or 0.0)
        if rate > 0:
            entry['timer'] = self.node.create_timer(1.0 / rate, fire)
        else:
            # one-shot after a short delay so subscribers can match
            def once():
                entry['timer'].cancel()
                fire()
            entry['timer'] = self.node.create_timer(0.3, once)
        return {'pubId': pub_id}

    def op_publishOnce(self, cmd):
        entry = self.publishers.get(cmd['pubId'])
        if entry is None:
            raise ValueError('publisher not started')
        if entry['autoStamp']:
            self._stamp(entry['msg'])
        entry['pub'].publish(entry['msg'])
        entry['count'] += 1
        emit({'ev': 'pubStatus', 'pubId': cmd['pubId'], 'count': entry['count']})
        return entry['count']

    def op_updatePublisher(self, cmd):
        entry = self.publishers.get(cmd['pubId'])
        if entry is None:
            raise ValueError('publisher not started')
        cls = type(entry['msg'])
        entry['msg'] = self._build_msg(cls, cmd.get('msg'), False)
        if 'autoStamp' in cmd:
            entry['autoStamp'] = bool(cmd['autoStamp'])
        return True

    def op_stopPublisher(self, cmd):
        entry = self.publishers.pop(cmd['pubId'], None)
        if entry is None:
            return False
        if entry['timer'] is not None:
            entry['timer'].cancel()
            self.node.destroy_timer(entry['timer'])
        self.node.destroy_publisher(entry['pub'])
        return True

    # ---- ops: parameters -----------------------------------------------
    def _param_client(self, node_fqn):
        from rclpy.parameter_client import AsyncParameterClient
        c = self.param_clients.get(node_fqn)
        if c is None:
            c = self.param_clients[node_fqn] = AsyncParameterClient(self.node, node_fqn)
        return c

    async def _wait_param_services(self, c, node_fqn, timeout):
        t0 = time.monotonic()
        while not c.services_are_ready():
            if time.monotonic() - t0 > timeout:
                raise TimeoutError(f'parameter services of {node_fqn} not available')
            await self._sleep(0.05)

    async def op_params_list(self, cmd):
        from rclpy.parameter import parameter_value_to_python
        node_fqn = cmd['node']
        timeout = float(cmd.get('timeout', 3.0))
        c = self._param_client(node_fqn)
        await self._wait_param_services(c, node_fqn, timeout)
        lst = await self._await(c.list_parameters([], 0), timeout)
        names = sorted(lst.result.names)
        if not names:
            return []
        vals = await self._await(c.get_parameters(names), timeout)
        descs = await self._await(c.describe_parameters(names), timeout)
        out = []
        for name, v, d in zip(names, vals.values, descs.descriptors):
            entry = {'name': name, 'type': v.type, 'value': to_plain(parameter_value_to_python(v)),
                     'description': d.description, 'readOnly': d.read_only,
                     'constraints': d.additional_constraints, 'dynamicTyping': d.dynamic_typing}
            if d.floating_point_range:
                r = d.floating_point_range[0]
                entry['range'] = [r.from_value, r.to_value, r.step]
            elif d.integer_range:
                r = d.integer_range[0]
                entry['range'] = [r.from_value, r.to_value, r.step]
            out.append(entry)
        return out

    async def op_params_set(self, cmd):
        from rclpy.parameter import Parameter
        node_fqn = cmd['node']
        timeout = float(cmd.get('timeout', 3.0))
        ptype = Parameter.Type(int(cmd['type']))
        value = cmd['value']
        if ptype == Parameter.Type.DOUBLE:
            value = float(value)
        elif ptype == Parameter.Type.INTEGER:
            value = int(value)
        elif ptype == Parameter.Type.BOOL:
            value = bool(value)
        elif ptype == Parameter.Type.DOUBLE_ARRAY:
            value = [float(x) for x in value]
        elif ptype == Parameter.Type.INTEGER_ARRAY:
            value = [int(x) for x in value]
        elif ptype == Parameter.Type.BOOL_ARRAY:
            value = [bool(x) for x in value]
        elif ptype == Parameter.Type.BYTE_ARRAY:
            value = [bytes([int(x) & 0xFF]) for x in value]
        c = self._param_client(node_fqn)
        await self._wait_param_services(c, node_fqn, timeout)
        res = await self._await(c.set_parameters([Parameter(cmd['name'], ptype, value)]), timeout)
        r = res.results[0]
        return {'successful': r.successful, 'reason': r.reason}

    async def op_params_get(self, cmd):
        from rclpy.parameter import parameter_value_to_python
        node_fqn = cmd['node']
        names = list(cmd['names'])
        timeout = float(cmd.get('timeout', 3.0))
        c = self._param_client(node_fqn)
        await self._wait_param_services(c, node_fqn, timeout)
        res = await self._await(c.get_parameters(names), timeout)
        return {n: to_plain(parameter_value_to_python(v)) for n, v in zip(names, res.values)}

    # ---- ops: URDF resources ---------------------------------------------
    def _resolve_uri(self, uri, base=None):
        if uri.startswith('package://'):
            pkg, _, rel = uri[len('package://'):].partition('/')
            from ament_index_python.packages import get_package_share_directory
            path = os.path.join(get_package_share_directory(pkg), rel)
        elif uri.startswith('file://'):
            path = urllib.parse.unquote(uri[len('file://'):])
        elif os.path.isabs(uri):
            path = uri
        elif base:
            path = os.path.join(base, uri)
        else:
            raise ValueError(f'cannot resolve relative path "{uri}" without a base directory')
        return os.path.normpath(os.path.expanduser(path))

    def _read_resource(self, uri, base):
        path = self._resolve_uri(uri, base)
        ext = os.path.splitext(path)[1].lower()
        if ext not in RESOURCE_EXT:
            raise ValueError(f'refusing to read "{path}": only mesh/texture files are served')
        size = os.path.getsize(path)
        if size > MAX_RESOURCE_BYTES:
            raise ValueError(f'{path} is too large ({size} bytes)')
        with open(path, 'rb') as f:
            data = f.read()
        return Binary({'path': path, 'size': size}, data)

    async def op_readResource(self, cmd):
        return await self._in_thread(self._read_resource, cmd['uri'], cmd.get('base'))

    def _load_urdf(self, path, xacro_args):
        path = os.path.abspath(os.path.expanduser(path))
        if path.endswith('.xacro'):
            exe = shutil.which('xacro')
            if exe is None:
                raise ValueError('xacro executable not found (install ros-$ROS_DISTRO-xacro)')
            argv = [exe, path] + [f'{k}:={v}' for k, v in (xacro_args or {}).items()]
            proc = subprocess.run(argv, capture_output=True, text=True, timeout=60)
            if proc.returncode != 0:
                raise ValueError('xacro failed: ' + (proc.stderr.strip() or proc.stdout.strip())[-3000:])
            xml = proc.stdout
        else:
            with open(path, 'r', encoding='utf-8') as f:
                xml = f.read()
        return {'urdf': xml, 'base': os.path.dirname(path), 'path': path}

    async def op_loadUrdf(self, cmd):
        return await self._in_thread(self._load_urdf, cmd['path'], cmd.get('xacroArgs'))


def main():
    backend = Backend()
    log('started', json.dumps(backend.info()))
    backend.run()
    log('exiting')


if __name__ == '__main__':
    main()
