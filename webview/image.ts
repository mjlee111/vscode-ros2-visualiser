import './common/base.css';
import { ros, Subscription } from './common/ros';
import { fmtHz, fmtSec, h, isImageType, statusBanner, TopicSelect, toast } from './common/ui';

interface Ui {
  fps: number;
  colormap: string;
  autoRange: boolean;
  min: number;
  max: number;
  smooth: boolean;
}
const ui = ros.loadState<Ui>({ fps: 30, colormap: 'turbo', autoRange: true, min: 0, max: 5, smooth: true });
const save = () => ros.saveState(ui);

let sub: Subscription | undefined;
let frame: ImageBitmap | HTMLCanvasElement | undefined;
let head: Record<string, unknown> = {};
let paused = false;
let heldAck: Subscription | undefined;
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && heldAck) {
    const s = heldAck;
    heldAck = undefined;
    s.ack();
  }
});
let fit = true;
let zoom = 1;
let panX = 0;
let panY = 0;
let frames = 0;
let fpsShown = 0;
let lastFrameAt = 0;
let error = '';

// ---- layout ---------------------------------------------------------------
const app = document.getElementById('app')!;
const topicSel = new TopicSelect(isImageType, (t, type) => setTopic(t, type), '— select image topic —');
const fpsSel = h(
  'select',
  {
    title: 'Max display rate',
    onchange: () => {
      ui.fps = Number(fpsSel.value);
      save();
      sub?.update({ maxRate: ui.fps });
    },
  },
  ...[1, 5, 10, 15, 30, 60].map((f) => h('option', { value: String(f), selected: f === ui.fps }, `${f} fps`)),
);
const cmapSel = h(
  'select',
  {
    title: 'Colormap for depth / float / 16-bit images',
    onchange: () => {
      ui.colormap = cmapSel.value;
      save();
      sendOpts();
    },
  },
  ...['turbo', 'jet', 'viridis', 'inferno', 'gray'].map((c) => h('option', { value: c, selected: c === ui.colormap }, c)),
);
const autoCb = h('input', {
  type: 'checkbox',
  checked: ui.autoRange,
  onchange: () => {
    ui.autoRange = autoCb.checked;
    minIn.disabled = maxIn.disabled = ui.autoRange;
    save();
    sendOpts();
  },
});
const minIn = h('input', { type: 'number', step: 'any', value: String(ui.min), disabled: ui.autoRange, title: 'min value', style: 'width: 70px' });
const maxIn = h('input', { type: 'number', step: 'any', value: String(ui.max), disabled: ui.autoRange, title: 'max value', style: 'width: 70px' });
for (const el of [minIn, maxIn])
  el.addEventListener('change', () => {
    ui.min = Number(minIn.value);
    ui.max = Number(maxIn.value);
    save();
    sendOpts();
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
const canvas = h('canvas', { style: 'position: absolute; inset: 0; width: 100%; height: 100%; cursor: grab' });
const hover = h('div', { class: 'overlay hidden', style: 'left: 8px; top: 8px' });
const placeholder = h('div', { class: 'empty', style: 'position: absolute; inset: 0; display: flex; align-items: center; justify-content: center' }, 'Select an image topic');
const stage = h('div', { class: 'grow', style: 'position: relative; overflow: hidden; background: #000' }, canvas, placeholder, hover);
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
    h('label', { title: 'Applies to depth / mono16 / float images' }, 'colormap', cmapSel),
    h('label', null, autoCb, 'auto range'),
    minIn,
    maxIn,
    h('span', { class: 'sep' }),
    h('button', { class: 'secondary', title: 'Fit to window', onclick: () => ((fit = true), draw()) }, '⤢ Fit'),
    h('button', { class: 'secondary', title: 'Actual pixels', onclick: () => setZoom(1) }, '1:1'),
    h(
      'label',
      { title: 'Smooth scaling' },
      h('input', {
        type: 'checkbox',
        checked: ui.smooth,
        onchange: (e: Event) => {
          ui.smooth = (e.target as HTMLInputElement).checked;
          save();
          draw();
        },
      }),
      'smooth',
    ),
    h('button', { class: 'secondary', title: 'Save current frame as PNG', onclick: () => void savePng() }, '💾 PNG'),
  ),
  stage,
  info,
);

// ---- subscription ---------------------------------------------------------
function opts(): Record<string, unknown> {
  return { maxRate: ui.fps, colormap: ui.colormap, autoRange: ui.autoRange, min: ui.min, max: ui.max, forceColormap: false };
}

function sendOpts(): void {
  sub?.update(opts());
}

function setTopic(topic: string, type?: string): void {
  sub?.close();
  sub = undefined;
  frame = undefined;
  head = {};
  error = '';
  ros.args.topic = topic;
  save();
  ros.setTitle(topic ? `Image: ${topic}` : 'Image View');
  placeholder.classList.toggle('hidden', !!topic);
  placeholder.textContent = topic ? '' : 'Select an image topic';
  draw();
  if (!topic) return;
  placeholder.classList.remove('hidden');
  placeholder.textContent = `Waiting for ${topic}…`;
  const s = ros.subscribe(
    topic,
    'image',
    opts(),
    (ev, payload) => {
      if (ev.ev === 'subError') {
        error = String(ev.error);
        placeholder.classList.remove('hidden');
        placeholder.textContent = error;
        return;
      }
      if (ev.ev !== 'msg' || !payload) return;
      void onFrame(s, ev as Record<string, unknown>, payload);
    },
    type,
  );
  sub = s;
}

async function onFrame(s: Subscription, ev: Record<string, unknown>, payload: Uint8Array): Promise<void> {
  try {
    if (document.hidden) {
      heldAck = s;
      return;
    }
    if (paused || s !== sub) return;
    let img: ImageBitmap | HTMLCanvasElement;
    if (ev.format === 'rgba') {
      const w = Number(ev.outWidth ?? ev.width);
      const hgt = Number(ev.outHeight ?? ev.height);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = hgt;
      const data = new Uint8ClampedArray(payload.buffer, payload.byteOffset, w * hgt * 4);
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), w, hgt), 0, 0);
      img = c;
    } else {
      img = await createImageBitmap(new Blob([payload], { type: ev.format === 'png' ? 'image/png' : 'image/jpeg' }));
    }
    if (s !== sub) return;
    if (frame && 'close' in frame) frame.close();
    frame = img;
    head = ev;
    error = '';
    frames++;
    lastFrameAt = performance.now();
    placeholder.classList.add('hidden');
    draw();
  } catch (e) {
    error = `decode failed: ${(e as Error).message}`;
  } finally {
    if (heldAck !== s) s.ack();
  }
}

// ---- drawing --------------------------------------------------------------
function frameSize(): [number, number] {
  if (!frame) return [0, 0];
  return [frame.width, frame.height];
}

function draw(): void {
  const dpr = window.devicePixelRatio || 1;
  const cw = stage.clientWidth;
  const ch = stage.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!frame) return;
  const [iw, ih] = frameSize();
  if (fit) {
    zoom = Math.min(cw / iw, ch / ih);
    panX = (cw - iw * zoom) / 2;
    panY = (ch - ih * zoom) / 2;
  }
  ctx.imageSmoothingEnabled = ui.smooth && zoom < 2;
  ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * panX, dpr * panY);
  ctx.drawImage(frame, 0, 0);
}

function setZoom(z: number, cx?: number, cy?: number): void {
  const [iw, ih] = frameSize();
  const cw = stage.clientWidth;
  const ch = stage.clientHeight;
  cx ??= cw / 2;
  cy ??= ch / 2;
  const ix = (cx - panX) / zoom;
  const iy = (cy - panY) / zoom;
  fit = false;
  zoom = Math.max(0.02, Math.min(64, z));
  panX = cx - ix * zoom;
  panY = cy - iy * zoom;
  if (z === 1 && iw) {
    panX = Math.round(panX);
    panY = Math.round(panY);
  }
  void ih;
  draw();
}

stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    setZoom(zoom * Math.pow(1.0015, -e.deltaY), e.clientX - r.left, e.clientY - r.top);
  },
  { passive: false },
);
let drag: { x: number; y: number; px: number; py: number } | undefined;
stage.addEventListener('mousedown', (e) => {
  drag = { x: e.clientX, y: e.clientY, px: panX, py: panY };
  canvas.style.cursor = 'grabbing';
});
window.addEventListener('mouseup', () => {
  drag = undefined;
  canvas.style.cursor = 'grab';
});
stage.addEventListener('dblclick', () => {
  fit = !fit;
  if (!fit) setZoom(1);
  else draw();
});
stage.addEventListener('mousemove', (e) => {
  const r = stage.getBoundingClientRect();
  const mx = e.clientX - r.left;
  const my = e.clientY - r.top;
  if (drag) {
    fit = false;
    panX = drag.px + (e.clientX - drag.x);
    panY = drag.py + (e.clientY - drag.y);
    draw();
  }
  if (!frame) return;
  const [iw, ih] = frameSize();
  const ix = Math.floor((mx - panX) / zoom);
  const iy = Math.floor((my - panY) / zoom);
  if (ix < 0 || iy < 0 || ix >= iw || iy >= ih) {
    hover.classList.add('hidden');
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const p = canvas.getContext('2d')!.getImageData(Math.floor(mx * dpr), Math.floor(my * dpr), 1, 1).data;
  // map back to source resolution when the stream was downscaled
  const sx = head.width && head.outWidth ? Math.floor((ix * Number(head.width)) / Number(head.outWidth)) : ix;
  const sy = head.height && head.outHeight ? Math.floor((iy * Number(head.height)) / Number(head.outHeight)) : iy;
  hover.classList.remove('hidden');
  hover.textContent = `(${sx}, ${sy})  rgb ${p[0]} ${p[1]} ${p[2]}  zoom ${(zoom * 100).toFixed(0)}%`;
});
stage.addEventListener('mouseleave', () => hover.classList.add('hidden'));
new ResizeObserver(() => draw()).observe(stage);

async function savePng(): Promise<void> {
  if (!frame) return;
  const c = document.createElement('canvas');
  c.width = frame.width;
  c.height = frame.height;
  c.getContext('2d')!.drawImage(frame, 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  if (!blob) return;
  const name = `${(ros.args.topic as string | undefined)?.replace(/\//g, '_').replace(/^_/, '') ?? 'image'}.png`;
  ros.saveFile(name, new Uint8Array(await blob.arrayBuffer()), { Images: ['png'] });
  toast('Choose where to save the PNG…');
}

// ---- status line ----------------------------------------------------------
setInterval(() => {
  fpsShown = frames;
  frames = 0;
  const topic = ros.args.topic as string | undefined;
  const st = topic ? ros.stats[topic] : undefined;
  const parts: [string, string][] = [];
  if (head.width) parts.push(['size', `${head.width}×${head.height}`]);
  if (head.encoding) parts.push(['encoding', String(head.encoding)]);
  if (head.frameId) parts.push(['frame', String(head.frameId)]);
  parts.push(['display', `${fpsShown} fps`]);
  if (st) parts.push(['topic', `${fmtHz(st.hz)} Hz`]);
  if (head.stamp) parts.push(['latency', fmtSec(Date.now() / 1000 - Number(head.stamp))]);
  if (head.colormapped) parts.push(['range', `${Number(head.min).toPrecision(4)} … ${Number(head.max).toPrecision(4)}`]);
  if (lastFrameAt && performance.now() - lastFrameAt > 3000) parts.push(['', '⚠ no new frames']);
  if (error) parts.push(['error', error]);
  info.replaceChildren(...parts.map(([k, v]) => h('span', null, k ? `${k} ` : '', h('b', null, v))));
}, 1000);

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
