import './common/base.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { applyColormap, colormapGradient, COLORMAPS } from './common/colormap';
import { ros, Subscription } from './common/ros';
import { clear, fmtHz, fmtSec, h, isCloudType, statusBanner, TopicSelect } from './common/ui';

interface Ui {
  colorField: string;
  colormap: string;
  autoRange: boolean;
  min: number;
  max: number;
  pointSize: number;
  maxPoints: number;
  fps: number;
  decay: number;
  grid: boolean;
  axes: boolean;
  flatColor: string;
  bg: string;
}
const ui = ros.loadState<Ui>({
  colorField: 'auto',
  colormap: 'turbo',
  autoRange: true,
  min: 0,
  max: 1,
  pointSize: 2,
  maxPoints: 300000,
  fps: 10,
  decay: 1,
  grid: true,
  axes: true,
  flatColor: '#ffffff',
  bg: '#111111',
});
const save = () => ros.saveState(ui);

let sub: Subscription | undefined;
let paused = false;
let heldAck: Subscription | undefined;
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && heldAck) {
    const s = heldAck;
    heldAck = undefined;
    s.ack();
  }
});
let head: Record<string, unknown> = {};
let lastRange: [number, number] = [0, 1];
let framesThisSec = 0;
let fpsShown = 0;
let fittedOnce = false;
let error = '';

// ---- toolbar --------------------------------------------------------------
const app = document.getElementById('app')!;
const topicSel = new TopicSelect(isCloudType, (t, ty) => setTopic(t, ty), '— select PointCloud2 / LaserScan —');
const fieldSel = h('select', {
  title: 'Color by field',
  onchange: () => {
    ui.colorField = fieldSel.value;
    save();
    sub?.update({ colorField: ui.colorField === 'flat' ? 'none' : ui.colorField });
  },
});
const cmapSel = h(
  'select',
  {
    onchange: () => {
      ui.colormap = cmapSel.value;
      save();
      legend.style.background = colormapGradient(ui.colormap);
      recolorLast();
    },
  },
  ...COLORMAPS.map((c) => h('option', { value: c, selected: c === ui.colormap }, c)),
);
const autoCb = h('input', {
  type: 'checkbox',
  checked: ui.autoRange,
  onchange: () => {
    ui.autoRange = autoCb.checked;
    minIn.disabled = maxIn.disabled = ui.autoRange;
    save();
    recolorLast();
  },
});
const minIn = h('input', { type: 'number', step: 'any', value: String(ui.min), disabled: ui.autoRange, style: 'width: 64px' });
const maxIn = h('input', { type: 'number', step: 'any', value: String(ui.max), disabled: ui.autoRange, style: 'width: 64px' });
for (const el of [minIn, maxIn])
  el.addEventListener('change', () => {
    ui.min = Number(minIn.value);
    ui.max = Number(maxIn.value);
    save();
    recolorLast();
  });
const sizeIn = h('input', {
  type: 'range',
  min: '1',
  max: '10',
  step: '0.5',
  value: String(ui.pointSize),
  style: 'width: 80px',
  oninput: () => {
    ui.pointSize = Number(sizeIn.value);
    material.size = ui.pointSize;
    for (const p of clouds) (p.material as THREE.PointsMaterial).size = ui.pointSize;
    save();
    dirty = true;
  },
});
const maxPtsSel = h(
  'select',
  {
    title: 'Max points per message (decimated in the backend)',
    onchange: () => {
      ui.maxPoints = Number(maxPtsSel.value);
      save();
      sub?.update({ maxPoints: ui.maxPoints });
    },
  },
  ...[20000, 50000, 100000, 300000, 1000000, 0].map((n) =>
    h('option', { value: String(n), selected: n === ui.maxPoints }, n ? `${n >= 1e6 ? n / 1e6 + 'M' : n / 1000 + 'k'} pts` : 'all pts'),
  ),
);
const fpsSel = h(
  'select',
  {
    onchange: () => {
      ui.fps = Number(fpsSel.value);
      save();
      sub?.update({ maxRate: ui.fps });
    },
  },
  ...[1, 2, 5, 10, 20, 30].map((f) => h('option', { value: String(f), selected: f === ui.fps }, `${f} fps`)),
);
const decayIn = h('input', {
  type: 'number',
  min: '1',
  max: '100',
  value: String(ui.decay),
  title: 'Keep the last N clouds (accumulate scans)',
  style: 'width: 52px',
  onchange: () => {
    ui.decay = Math.max(1, Math.min(100, Number(decayIn.value) || 1));
    save();
    trimDecay();
  },
});
const pauseBtn = h(
  'button',
  {
    class: 'secondary',
    onclick: () => {
      paused = !paused;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    },
  },
  'Pause',
);
function toggle(key: 'grid' | 'axes', label: string): HTMLLabelElement {
  const cb = h('input', {
    type: 'checkbox',
    checked: ui[key],
    onchange: () => {
      ui[key] = cb.checked;
      save();
      grid.visible = ui.grid;
      axes.visible = ui.axes;
      dirty = true;
    },
  });
  return h('label', null, cb, label);
}
const legend = h('span', { style: `display: inline-block; width: 90px; height: 10px; border-radius: 2px; background: ${colormapGradient(ui.colormap)}` });
const legendLo = h('span', { class: 'mono muted', style: 'font-size: 11px' });
const legendHi = h('span', { class: 'mono muted', style: 'font-size: 11px' });

const stage = h('div', { class: 'grow', style: 'position: relative; overflow: hidden' });
const placeholder = h('div', { class: 'empty', style: 'position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none' }, 'Select a PointCloud2 or LaserScan topic');
const info = h('div', { class: 'statusbar' });

app.append(
  statusBanner(),
  h(
    'div',
    { class: 'toolbar' },
    topicSel.el,
    fpsSel,
    pauseBtn,
    h('span', { class: 'sep' }),
    h('label', null, 'color', fieldSel),
    cmapSel,
    legendLo,
    legend,
    legendHi,
    h('label', null, autoCb, 'auto'),
    minIn,
    maxIn,
    h('span', { class: 'sep' }),
    h('label', null, 'size', sizeIn),
    maxPtsSel,
    h('label', null, 'decay', decayIn),
    h('span', { class: 'sep' }),
    toggle('grid', 'grid'),
    toggle('axes', 'axes'),
    h('button', { class: 'secondary', title: 'Fit view to the cloud', onclick: () => fitView() }, '⤢ Fit'),
    h('button', { class: 'secondary', title: 'Top-down view', onclick: () => topView() }, '⊤ Top'),
  ),
  stage,
  info,
);
stage.append(placeholder);

// ---- three.js scene (ROS convention: Z up) --------------------------------
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
renderer.setPixelRatio(window.devicePixelRatio || 1);
stage.prepend(renderer.domElement);
renderer.domElement.style.display = 'block';
const scene = new THREE.Scene();
scene.background = new THREE.Color(ui.bg);
const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 5000);
camera.up.set(0, 0, 1);
camera.position.set(-8, -8, 6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.15;
controls.screenSpacePanning = true;
controls.target.set(0, 0, 0);
const grid = new THREE.GridHelper(40, 40, 0x555555, 0x2a2a2a);
grid.rotation.x = Math.PI / 2;
grid.visible = ui.grid;
scene.add(grid);
const axes = new THREE.AxesHelper(1);
axes.visible = ui.axes;
scene.add(axes);

const material = new THREE.PointsMaterial({ size: ui.pointSize, vertexColors: true, sizeAttenuation: false });
const clouds: THREE.Points[] = [];
let lastScalars: Float32Array | undefined;
let lastColorAttr: THREE.BufferAttribute | undefined;
let dirty = true;

function resize(): void {
  const w = stage.clientWidth;
  const hgt = stage.clientHeight;
  renderer.setSize(w, hgt, true);
  camera.aspect = w / Math.max(1, hgt);
  camera.updateProjectionMatrix();
  dirty = true;
}
new ResizeObserver(resize).observe(stage);
controls.addEventListener('change', () => (dirty = true));

function loop(): void {
  requestAnimationFrame(loop);
  if (controls.update()) dirty = true;
  if (!dirty) return;
  dirty = false;
  renderer.render(scene, camera);
}
loop();

function fitView(): void {
  const b = head.bounds as [number[], number[]] | undefined;
  if (!b) return;
  const center = new THREE.Vector3((b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2, (b[0][2] + b[1][2]) / 2);
  const size = Math.max(b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2], 0.5);
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(-0.9, -0.9, 0.7).multiplyScalar(size));
  camera.near = size / 1000;
  camera.far = size * 100;
  camera.updateProjectionMatrix();
  controls.update();
  dirty = true;
}

function topView(): void {
  const t = controls.target;
  const dist = camera.position.distanceTo(t);
  camera.position.set(t.x, t.y - dist * 0.001, t.z + dist);
  controls.update();
  dirty = true;
}

// ---- data -----------------------------------------------------------------
function aligned(payload: Uint8Array): Uint8Array {
  return payload.byteOffset % 4 === 0 ? payload : payload.slice();
}

function rangeFor(values: Float32Array): [number, number] {
  if (!ui.autoRange) return [ui.min, ui.max];
  const lo = Number(head.min);
  const hi = Number(head.max);
  if (Number.isFinite(lo) && Number.isFinite(hi)) return [lo, hi];
  let mn = Infinity;
  let mx = -Infinity;
  for (const v of values)
    if (Number.isFinite(v)) {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  return [mn, mx];
}

function setLegend(show: boolean): void {
  legend.style.visibility = show ? 'visible' : 'hidden';
  legendLo.textContent = show ? lastRange[0].toPrecision(3) : '';
  legendHi.textContent = show ? lastRange[1].toPrecision(3) : '';
}

function recolorLast(): void {
  if (!lastScalars || !lastColorAttr) return;
  lastRange = rangeFor(lastScalars);
  applyColormap(lastScalars, lastRange[0], lastRange[1], ui.colormap, lastColorAttr.array as Uint8Array);
  lastColorAttr.needsUpdate = true;
  setLegend(true);
  dirty = true;
}

function trimDecay(): void {
  while (clouds.length > ui.decay) {
    const p = clouds.shift()!;
    scene.remove(p);
    p.geometry.dispose();
  }
  dirty = true;
}

function updateFields(fields: string[]): void {
  const opts = ['auto', ...fields.filter((f) => f !== 'rgb' && f !== 'rgba'), ...(fields.includes('rgb') || fields.includes('rgba') ? ['rgb'] : []), 'flat'];
  const sig = opts.join(',');
  if (fieldSel.dataset.sig === sig) return;
  fieldSel.dataset.sig = sig;
  clear(fieldSel);
  for (const f of opts) fieldSel.append(h('option', { value: f, selected: f === ui.colorField }, f));
  if (!opts.includes(ui.colorField)) fieldSel.value = 'auto';
}

function onCloud(s: Subscription, ev: Record<string, unknown>, raw: Uint8Array): void {
  try {
    if (document.hidden) {
      heldAck = s;
      return;
    }
    if (paused || s !== sub) return;
    head = ev;
    const payload = aligned(raw);
    const n = Number(ev.n);
    updateFields((ev.fields as string[]) ?? []);
    const positions = new Float32Array(payload.buffer, payload.byteOffset, n * 3);
    let colors: Uint8Array;
    lastScalars = undefined;
    if (ui.colorField === 'flat' || ev.color === 'none') {
      const c = new THREE.Color(ui.flatColor);
      colors = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) {
        colors[i * 3] = c.r * 255;
        colors[i * 3 + 1] = c.g * 255;
        colors[i * 3 + 2] = c.b * 255;
      }
      setLegend(false);
    } else if (ev.color === 'rgb') {
      colors = new Uint8Array(payload.buffer, payload.byteOffset + n * 12, n * 3).slice();
      setLegend(false);
    } else {
      const scalars = new Float32Array(payload.buffer, payload.byteOffset + n * 12, n).slice();
      lastScalars = scalars;
      lastRange = rangeFor(scalars);
      colors = applyColormap(scalars, lastRange[0], lastRange[1], ui.colormap);
      setLegend(true);
    }
    let pts: THREE.Points;
    if (ui.decay <= 1 && clouds.length === 1) {
      pts = clouds[0];
      const g = pts.geometry;
      const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (pos && pos.array.length >= n * 3) {
        (pos.array as Float32Array).set(positions);
        (g.getAttribute('color').array as Uint8Array).set(colors);
        pos.needsUpdate = true;
        g.getAttribute('color').needsUpdate = true;
      } else {
        const cap = Math.ceil(n * 1.25);
        const pa = new Float32Array(cap * 3);
        pa.set(positions);
        const ca = new Uint8Array(cap * 3);
        ca.set(colors);
        g.setAttribute('position', new THREE.BufferAttribute(pa, 3));
        g.setAttribute('color', new THREE.BufferAttribute(ca, 3, true));
      }
      g.setDrawRange(0, n);
      g.computeBoundingSphere();
    } else {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
      g.computeBoundingSphere();
      pts = new THREE.Points(g, material);
      pts.frustumCulled = false;
      scene.add(pts);
      clouds.push(pts);
      trimDecay();
    }
    lastColorAttr = pts.geometry.getAttribute('color') as THREE.BufferAttribute;
    framesThisSec++;
    error = '';
    placeholder.classList.add('hidden');
    if (!fittedOnce && n > 0) {
      fittedOnce = true;
      fitView();
    }
    dirty = true;
  } catch (e) {
    error = String((e as Error).message ?? e);
  } finally {
    if (heldAck !== s) s.ack();
  }
}

function setTopic(topic: string, type?: string): void {
  sub?.close();
  sub = undefined;
  for (const p of clouds.splice(0)) {
    scene.remove(p);
    p.geometry.dispose();
  }
  fittedOnce = false;
  head = {};
  error = '';
  dirty = true;
  ros.args.topic = topic;
  save();
  ros.setTitle(topic ? `3D: ${topic}` : '3D View');
  placeholder.classList.remove('hidden');
  placeholder.textContent = topic ? `Waiting for ${topic}…` : 'Select a PointCloud2 or LaserScan topic';
  if (!topic) return;
  const s = ros.subscribe(
    topic,
    'cloud',
    { maxRate: ui.fps, maxPoints: ui.maxPoints, colorField: ui.colorField === 'flat' ? 'none' : ui.colorField },
    (ev, payload) => {
      if (ev.ev === 'subError') {
        error = String(ev.error);
        placeholder.classList.remove('hidden');
        placeholder.textContent = error;
        return;
      }
      if (ev.ev === 'msg' && payload) onCloud(s, ev as Record<string, unknown>, payload);
    },
    type,
  );
  sub = s;
}

setInterval(() => {
  fpsShown = framesThisSec;
  framesThisSec = 0;
  const topic = ros.args.topic as string | undefined;
  const st = topic ? ros.stats[topic] : undefined;
  const parts: [string, string][] = [];
  if (head.n !== undefined) parts.push(['points', `${Number(head.n).toLocaleString()} / ${Number(head.total).toLocaleString()}`]);
  if (head.frameId) parts.push(['frame', String(head.frameId)]);
  if (head.colorField) parts.push(['color', String(head.colorField)]);
  parts.push(['display', `${fpsShown} fps`]);
  if (st) parts.push(['topic', `${fmtHz(st.hz)} Hz`]);
  if (head.stamp) parts.push(['latency', fmtSec(Date.now() / 1000 - Number(head.stamp))]);
  if (ui.decay > 1) parts.push(['clouds', String(clouds.length)]);
  if (error) parts.push(['error', error]);
  parts.push(['', 'drag: orbit · right/shift-drag: pan · wheel: zoom']);
  info.replaceChildren(...parts.map(([k, v]) => h('span', null, k ? `${k} ` : '', h('b', null, v))));
}, 1000);

updateFields([]);
setLegend(false);
ros.on('init', (args) => {
  if (typeof args.topic === 'string') {
    topicSel.set(args.topic);
    setTopic(args.topic, args.type as string | undefined);
  }
});
ros.on('args', (args) => {
  if (typeof args.topic === 'string' && args.topic !== sub?.topic) {
    topicSel.set(args.topic);
    setTopic(args.topic);
  }
});
ros.start();
