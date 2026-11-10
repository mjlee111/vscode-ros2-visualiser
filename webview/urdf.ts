import './common/base.css';
import './common/graph.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ros, Subscription } from './common/ros';
import { graphPalette, mix, onThemeChange } from './common/theme';
import { clear, fmtHz, h, statusBanner, toast } from './common/ui';
import { parseUrdf, RobotModel } from './common/urdf';

interface Ui {
  source: string;
  jointSource: string;
  showVisual: boolean;
  showCollision: boolean;
  showFrames: boolean;
  opacity: number;
  sliders: Record<string, number>;
  jointFilter: string;
}
const ui = ros.loadState<Ui>({
  source: '',
  jointSource: '',
  showVisual: true,
  showCollision: false,
  showFrames: false,
  opacity: 1,
  sliders: {},
  jointFilter: '',
});
const save = () => ros.saveState(ui);
const SLIDERS = 'slider:';
const NONE = 'none:';
const JOINT_STATE = 'sensor_msgs/msg/JointState';
const STRING = 'std_msgs/msg/String';
const PLACEHOLDER_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

let model: RobotModel | undefined;
let urdfText = '';
let baseDir = '';
let descSub: Subscription | undefined;
let jointSub: Subscription | undefined;
let jointMsgs = 0;
let jointTotal = 0;
let jointRate = 0;
let matched = 0;
let unknownNames: string[] = [];
let selectedLink = '';
let hoverLink = '';
let fitted = false;
let loadError = '';

// ---- toolbar --------------------------------------------------------------
const app = document.getElementById('app')!;
const sourceSel = h('select', { title: 'Where the URDF comes from', style: 'max-width: 340px' });
const jointSel = h('select', { title: 'Joint positions', style: 'max-width: 300px' });
sourceSel.addEventListener('change', () => {
  ui.source = sourceSel.value;
  save();
  loadSource();
});
jointSel.addEventListener('change', () => {
  ui.jointSource = jointSel.value;
  save();
  connectJoints();
});
function toggle(key: 'showVisual' | 'showCollision' | 'showFrames', label: string, title: string): HTMLLabelElement {
  const cb = h('input', {
    type: 'checkbox',
    checked: ui[key],
    onchange: () => {
      ui[key] = cb.checked;
      save();
      applyDisplay();
    },
  });
  return h('label', { title }, cb, label);
}
const opacityIn = h('input', {
  type: 'range',
  min: '0.1',
  max: '1',
  step: '0.05',
  value: String(ui.opacity),
  style: 'width: 70px',
  title: 'Visual opacity',
  oninput: () => {
    ui.opacity = Number(opacityIn.value);
    save();
    applyDisplay();
  },
});
const reloadBtn = h('button', { class: 'tb-btn', title: 'Reload the robot description', onclick: () => loadSource(true) }, '⟳ Reload');

const stage = h('div', { class: 'grow', style: 'position: relative; overflow: hidden' });
const notice = h('div', { class: 'notice center hidden' });
const hoverChip = h('div', { class: 'chip hidden', style: 'left: 10px; top: 10px; color: var(--fg)' });
const side = h('div', { class: 'side-panel scroll', style: 'flex: 0 0 320px' });
const info = h('div', { class: 'statusbar' });

app.append(
  statusBanner(),
  h(
    'div',
    { class: 'toolbar' },
    h('span', { class: 'muted' }, 'URDF'),
    sourceSel,
    reloadBtn,
    h('span', { class: 'sep' }),
    h('span', { class: 'muted' }, 'joints'),
    jointSel,
    h('span', { class: 'sep' }),
    toggle('showVisual', 'visual', 'Visual geometry'),
    toggle('showCollision', 'collision', 'Collision geometry (orange)'),
    toggle('showFrames', 'frames', 'Link frames (x red, y green, z blue)'),
    h('label', null, 'opacity', opacityIn),
    h('span', { class: 'grow' }),
    h('button', { class: 'tb-btn', title: 'Fit view to the robot', onclick: () => fitView() }, '⤢ Fit'),
    h('button', { class: 'tb-btn', title: 'Front view', onclick: () => presetView('front') }, 'Front'),
    h('button', { class: 'tb-btn', title: 'Side view', onclick: () => presetView('side') }, 'Side'),
    h('button', { class: 'tb-btn', title: 'Top view', onclick: () => presetView('top') }, 'Top'),
  ),
  h('div', { class: 'row grow', style: 'align-items: stretch; gap: 0' }, stage, side),
  info,
);

// ---- three.js (ROS: Z up) --------------------------------------------------
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio || 1);
renderer.domElement.style.display = 'block';
stage.append(renderer.domElement, notice, hoverChip);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.005, 500);
camera.up.set(0, 0, 1);
camera.position.set(1.6, -1.6, 1.2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.15;
controls.screenSpacePanning = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f4a, 1.6));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
keyLight.position.set(1, -1, 2);
camera.add(keyLight);
scene.add(camera);
let grid = new THREE.GridHelper(10, 50);
grid.rotation.x = Math.PI / 2;
scene.add(grid);
const worldAxes = new THREE.AxesHelper(0.25);
scene.add(worldAxes);
let dirty = true;

function applyTheme(): void {
  const P = graphPalette();
  scene.background = new THREE.Color(mix(P.bg, P.fg, 0.04));
  scene.remove(grid);
  grid = new THREE.GridHelper(10, 50, new THREE.Color(mix(P.bg, P.fg, 0.28)), new THREE.Color(mix(P.bg, P.fg, 0.12)));
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);
  dirty = true;
}
applyTheme();
onThemeChange(applyTheme);

function resize(): void {
  const w = stage.clientWidth;
  const hh = stage.clientHeight;
  renderer.setSize(w, hh, true);
  camera.aspect = w / Math.max(1, hh);
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

function robotBox(): THREE.Box3 | undefined {
  if (!model) return undefined;
  const box = new THREE.Box3().setFromObject(model.root);
  return box.isEmpty() ? undefined : box;
}

function fitView(margin = 1.2): void {
  const box = robotBox();
  if (!box) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const c = sphere.center;
  const r = Math.max(sphere.radius, 0.1);
  const vfov = (camera.fov * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const dist = (r * margin) / Math.sin(Math.min(vfov, hfov) / 2);
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (!Number.isFinite(dir.x) || dir.lengthSq() === 0) dir.set(1, -1, 0.7).normalize();
  controls.target.copy(c);
  camera.position.copy(c).add(dir.multiplyScalar(dist));
  camera.near = r / 200;
  camera.far = r * 200;
  camera.updateProjectionMatrix();
  controls.update();
  dirty = true;
}

function presetView(kind: 'front' | 'side' | 'top'): void {
  const d = camera.position.distanceTo(controls.target);
  const t = controls.target;
  if (kind === 'front') camera.position.set(t.x + d, t.y, t.z);
  else if (kind === 'side') camera.position.set(t.x, t.y - d, t.z);
  else camera.position.set(t.x, t.y - d * 0.001, t.z + d);
  controls.update();
  dirty = true;
}

// ---- mesh loading -----------------------------------------------------------
const meshCache = new Map<string, Promise<THREE.Object3D>>();
const manager = new THREE.LoadingManager();
manager.setURLModifier(() => PLACEHOLDER_PNG); // textures are not resolved; avoid stray requests

function genericMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xb0b4ba });
  m.userData.generic = true;
  return m;
}

async function fetchMesh(filename: string): Promise<THREE.Object3D> {
  const { payload } = await ros.requestBinary<{ path: string }>('readResource', { uri: filename, base: baseDir });
  if (!payload) throw new Error('empty file');
  const buf = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
  const ext = filename.split('?')[0].split('.').pop()?.toLowerCase();
  // ROS is Z-up; three's Collada/glTF output is Y-up (the Collada loader already
  // rotated Z_UP assets to Y-up), so both are rotated back by +90° about X.
  const yUpToZUp = (o: THREE.Object3D) => {
    const g = new THREE.Group();
    g.rotation.x = Math.PI / 2;
    g.add(o);
    const outer = new THREE.Group();
    outer.add(g);
    return outer;
  };
  switch (ext) {
    case 'stl':
      return new THREE.Mesh(new STLLoader().parse(buf), genericMaterial());
    case 'obj': {
      const g = new OBJLoader(manager).parse(new TextDecoder().decode(payload));
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && !(m.material as THREE.Material).name) m.material = genericMaterial();
      });
      return g;
    }
    case 'dae': {
      const c = new ColladaLoader(manager).parse(new TextDecoder().decode(payload), '');
      if (!c?.scene) throw new Error('cannot parse Collada file');
      return yUpToZUp(c.scene);
    }
    case 'glb':
    case 'gltf': {
      const g = await new GLTFLoader(manager).parseAsync(ext === 'glb' ? buf : new TextDecoder().decode(payload), '');
      return yUpToZUp(g.scene);
    }
    default:
      throw new Error(`unsupported mesh format .${ext}`);
  }
}

function loadMesh(filename: string): Promise<THREE.Object3D> {
  const key = `${baseDir}|${filename}`;
  let p = meshCache.get(key);
  if (!p) {
    p = fetchMesh(filename);
    meshCache.set(key, p);
    p.catch(() => meshCache.delete(key));
  }
  return p.then((o) => o.clone(true));
}

// ---- building ---------------------------------------------------------------
function showNotice(content: (string | Node)[] | undefined): void {
  notice.classList.toggle('hidden', !content);
  if (content) notice.replaceChildren(...content);
}

function build(xml: string, base: string): void {
  if (xml === urdfText && base === baseDir && model) return;
  let robot;
  try {
    robot = parseUrdf(xml);
  } catch (e) {
    loadError = `URDF parse error: ${(e as Error).message}`;
    showNotice([h('b', { class: 'err' }, 'Cannot parse the URDF'), h('span', { class: 'mono', style: 'max-width: 560px; white-space: pre-wrap' }, (e as Error).message)]);
    return;
  }
  const prevValues = new Map<string, number>();
  if (model) {
    for (const [n, j] of model.joints) prevValues.set(n, j.value);
    scene.remove(model.root);
    model.dispose();
  }
  if (base !== baseDir) meshCache.clear();
  urdfText = xml;
  baseDir = base;
  loadError = '';
  model = new RobotModel(robot, {
    loadMesh,
    defaultColor: '#b0b4ba',
    onMeshError: (f, e) => {
      console.warn(`mesh ${f}: ${e.message}`);
      dirty = true;
    },
  });
  scene.add(model.root);
  for (const [n, v] of prevValues) model.setJoint(n, v);
  if (ui.jointSource.startsWith(SLIDERS)) for (const [n, v] of Object.entries(ui.sliders)) model.setJoint(n, v);
  model.updateMimic();
  showNotice(robot.links.size ? undefined : [h('b', null, 'The URDF contains no links')]);
  if (robot.roots.length > 1) toast(`URDF has ${robot.roots.length} root links: ${robot.roots.join(', ')}`, 'error', 6000);
  applyDisplay();
  renderJoints();
  if (selectedLink && !robot.links.has(selectedLink)) selectedLink = '';
  renderSelection();
  ros.setTitle(`URDF: ${robot.name}`);
  // fit once geometry (including meshes) is in place
  // wait for meshes and (briefly) for the first joint state so the fit sees the real pose
  const waitJoints = ui.jointSource.startsWith('topic:');
  const fitWhenReady = (tries: number) => {
    if (!model) return;
    const jointsPending = waitJoints && jointTotal === 0 && tries > 50;
    if (((model.pending > 0 || jointsPending) && tries > 0) || !robotBox()) {
      setTimeout(() => fitWhenReady(tries - 1), 150);
      return;
    }
    if (!fitted) {
      fitted = true;
      fitView();
    }
    applyDisplay();
    dirty = true;
  };
  fitWhenReady(60);
  dirty = true;
}

function applyDisplay(): void {
  if (!model) return;
  model.showVisual(ui.showVisual);
  model.showCollision(ui.showCollision);
  const box = robotBox();
  const size = box ? Math.max(box.getSize(new THREE.Vector3()).length() * 0.06, 0.02) : 0.1;
  model.showFrames(ui.showFrames, size);
  for (const g of model.visualGroups.values())
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        const base = (mat.userData.baseOpacity ??= mat.opacity);
        mat.opacity = base * ui.opacity;
        mat.transparent = mat.opacity < 1;
        mat.depthWrite = mat.opacity >= 1;
        mat.needsUpdate = true;
      }
    });
  dirty = true;
}

// ---- sources --------------------------------------------------------------
interface SourceOpt {
  value: string;
  label: string;
}

function sourceOptions(): SourceOpt[] {
  const out: SourceOpt[] = [];
  const g = ros.graph;
  for (const t of g?.topics ?? []) {
    if (t.types.includes(STRING) && /robot_description$/.test(t.name)) out.push({ value: `topic:${t.name}`, label: `topic ${t.name}` });
  }
  for (const n of g?.nodes ?? []) {
    if (/robot_state_publisher/.test(n.name)) out.push({ value: `param:${n.fqn}`, label: `param ${n.fqn}.robot_description` });
  }
  const file = typeof ros.args.file === 'string' ? ros.args.file : ui.source.startsWith('file:') ? ui.source.slice(5) : '';
  if (file) out.push({ value: `file:${file}`, label: `file ${file.split('/').pop()}` });
  if (ui.source && !out.some((o) => o.value === ui.source)) out.push({ value: ui.source, label: `${ui.source} (not available)` });
  return out;
}

function jointOptions(): SourceOpt[] {
  const out: SourceOpt[] = [];
  for (const t of ros.graph?.topics ?? []) if (t.types.includes(JOINT_STATE)) out.push({ value: `topic:${t.name}`, label: t.name });
  out.push({ value: SLIDERS, label: 'sliders (local, never published)' });
  out.push({ value: NONE, label: 'zero pose' });
  if (ui.jointSource && !out.some((o) => o.value === ui.jointSource)) out.push({ value: ui.jointSource, label: `${ui.jointSource.slice(6)} (not available)` });
  return out;
}

function renderSelect(sel: HTMLSelectElement, opts: SourceOpt[], value: string, empty: string): void {
  const sig = opts.map((o) => o.value + o.label).join('|') + '#' + value;
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  clear(sel);
  if (!opts.length) sel.append(h('option', { value: '' }, empty));
  for (const o of opts) sel.append(h('option', { value: o.value, selected: o.value === value }, o.label));
  sel.value = value;
}

function refreshSelectors(): void {
  const src = sourceOptions();
  if (!ui.source && src.length) {
    ui.source = src[0].value;
    save();
    renderSelect(sourceSel, src, ui.source, 'no robot_description found');
    loadSource();
  } else renderSelect(sourceSel, src, ui.source, 'no robot_description found');
  const js = jointOptions();
  if (!ui.jointSource) {
    const pref = js.find((o) => o.value === 'topic:/joint_states') ?? js.find((o) => o.value.startsWith('topic:')) ?? js.find((o) => o.value === SLIDERS)!;
    ui.jointSource = pref.value;
    save();
    renderSelect(jointSel, js, ui.jointSource, '');
    connectJoints();
  } else renderSelect(jointSel, js, ui.jointSource, '');
  if (!ui.source) {
    showNotice([
      h('b', null, 'No robot description found'),
      h('span', { class: 'muted' }, 'Start robot_state_publisher (publishes /robot_description), or right-click a .urdf / .xacro file → "ROS: Open in URDF Viewer".'),
    ]);
  }
}

function loadSource(force = false): void {
  descSub?.close();
  descSub = undefined;
  const src = ui.source;
  if (force) urdfText = '';
  if (src.startsWith('topic:')) {
    const topic = src.slice(6);
    showNotice(model ? undefined : [h('span', { class: 'muted' }, `Waiting for ${topic}…`)]);
    descSub = ros.subscribe(
      topic,
      'json',
      { maxRate: 0, arrayLimit: 1 },
      (ev) => {
        if (ev.ev === 'subError') showNotice([h('b', { class: 'err' }, String(ev.error))]);
        if (ev.ev === 'msg') build(String((ev.msg as { data: string }).data ?? ''), '');
      },
      STRING,
    );
  } else if (src.startsWith('param:')) {
    const node = src.slice(6);
    showNotice(model ? undefined : [h('span', { class: 'muted' }, `Reading ${node}.robot_description…`)]);
    ros
      .request<Record<string, unknown>>('params.get', { node, names: ['robot_description'] })
      .then((r) => build(String(r.robot_description ?? ''), ''))
      .catch((e: Error) => showNotice([h('b', { class: 'err' }, `Cannot read the parameter: ${e.message}`)]));
  } else if (src.startsWith('file:')) {
    const path = src.slice(5);
    showNotice(model ? undefined : [h('span', { class: 'muted' }, `Loading ${path}…`)]);
    ros
      .request<{ urdf: string; base: string }>('loadUrdf', { path })
      .then((r) => {
        build(r.urdf, r.base);
        if (force) toast(`Reloaded ${path.split('/').pop()}`, 'ok', 1500);
      })
      .catch((e: Error) => {
        loadError = e.message;
        showNotice([h('b', { class: 'err' }, `Cannot load ${path.split('/').pop()}`), h('span', { class: 'mono', style: 'max-width: 640px; white-space: pre-wrap; text-align: left' }, e.message)]);
      });
  }
}

// ---- joint states ---------------------------------------------------------
function connectJoints(): void {
  jointSub?.close();
  jointSub = undefined;
  jointMsgs = 0;
  matched = 0;
  unknownNames = [];
  const src = ui.jointSource;
  if (src.startsWith('topic:')) {
    jointSub = ros.subscribe(
      src.slice(6),
      'json',
      { maxRate: 60, arrayLimit: 1000 },
      (ev) => {
        if (ev.ev !== 'msg' || !model) return;
        const m = ev.msg as { name: string[]; position: number[] };
        const names = Array.isArray(m.name) ? m.name : [];
        const pos = Array.isArray(m.position) ? m.position : [];
        let ok = 0;
        const unknown: string[] = [];
        for (let i = 0; i < names.length && i < pos.length; i++) {
          if (model.setJoint(names[i], Number(pos[i]))) ok++;
          else unknown.push(names[i]);
        }
        model.updateMimic();
        matched = ok;
        unknownNames = unknown;
        jointMsgs++;
        jointTotal++;
        dirty = true;
      },
      JOINT_STATE,
    );
  } else if (model) {
    for (const h2 of model.joints.values()) model.setJoint(h2.joint.name, src.startsWith(SLIDERS) ? (ui.sliders[h2.joint.name] ?? 0) : 0);
    model.updateMimic();
    dirty = true;
  }
  renderJoints();
}

// ---- side panel -----------------------------------------------------------
const jointRows = new Map<string, { slider: HTMLInputElement; value: HTMLElement }>();

function range(j: { type: string; limit?: { lower: number; upper: number } }): [number, number] {
  const l = j.limit;
  if (j.type === 'continuous' || !l || (l.lower === 0 && l.upper === 0)) return j.type === 'prismatic' ? [-1, 1] : [-Math.PI, Math.PI];
  return [l.lower, l.upper];
}

/** Continuous joints are displayed wrapped to [-180°, 180°]. */
function shown(type: string, v: number): number {
  return type === 'continuous' ? Math.atan2(Math.sin(v), Math.cos(v)) : v;
}

function fmtJoint(type: string, v: number): string {
  v = shown(type, v);
  return type === 'prismatic' ? `${v.toFixed(3)} m` : `${((v * 180) / Math.PI).toFixed(1)}°`;
}

const jointFilterIn = h('input', {
  type: 'search',
  placeholder: 'Filter joints',
  value: ui.jointFilter,
  style: 'width: 100%; margin: 4px 0',
  oninput: () => {
    ui.jointFilter = jointFilterIn.value;
    save();
    renderJoints();
  },
});
const selBox = h('div');
const jointBox = h('div');
side.append(selBox, h('div', { class: 'section-title' }, 'Joints'), jointFilterIn, jointBox);

function renderJoints(): void {
  clear(jointBox);
  jointRows.clear();
  if (!model) return;
  const editable = ui.jointSource.startsWith(SLIDERS);
  const f = ui.jointFilter.toLowerCase();
  const movable = model.movable.filter((j) => !f || j.joint.name.toLowerCase().includes(f));
  if (editable)
    jointBox.append(
      h(
        'div',
        { class: 'row', style: 'margin-bottom: 6px' },
        h(
          'button',
          {
            class: 'secondary',
            onclick: () => {
              ui.sliders = {};
              save();
              connectJoints();
            },
          },
          'Zero',
        ),
        h(
          'button',
          {
            class: 'secondary',
            onclick: () => {
              for (const j of model!.movable) {
                const [lo, hi] = range(j.joint);
                ui.sliders[j.joint.name] = lo + Math.random() * (hi - lo);
              }
              save();
              connectJoints();
            },
          },
          'Random',
        ),
      ),
    );
  if (!movable.length) jointBox.append(h('div', { class: 'muted' }, model.movable.length ? 'no match' : 'no movable joints'));
  for (const hj of movable) {
    const j = hj.joint;
    const [lo, hi] = range(j);
    const value = h('span', { class: 'mono muted', style: 'font-size: 11px' }, fmtJoint(j.type, hj.value));
    const slider = h('input', { type: 'range', min: String(lo), max: String(hi), step: String((hi - lo) / 1000), value: String(shown(j.type, hj.value)), disabled: !editable, style: 'width: 100%' });
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      ui.sliders[j.name] = v;
      model?.setJoint(j.name, v);
      model?.updateMimic();
      value.textContent = fmtJoint(j.type, v);
      dirty = true;
    });
    slider.addEventListener('change', save);
    jointBox.append(
      h(
        'div',
        { style: 'margin: 2px 0 6px' },
        h('div', { class: 'row', style: 'justify-content: space-between' }, h('span', { class: 'mono', style: 'font-size: 12px', title: `${j.type} · ${j.parent} → ${j.child}` }, j.name), value),
        slider,
      ),
    );
    jointRows.set(j.name, { slider, value });
  }
}

function syncJointRows(): void {
  if (!model || ui.jointSource.startsWith(SLIDERS)) return;
  for (const [name, row] of jointRows) {
    const hj = model.joints.get(name);
    if (!hj) continue;
    row.slider.value = String(shown(hj.joint.type, hj.value));
    row.value.textContent = fmtJoint(hj.joint.type, hj.value);
  }
}

function renderSelection(): void {
  clear(selBox);
  if (!model) return;
  const r = model.robot;
  const movable = model.movable.length;
  selBox.append(
    h('div', { class: 'kind' }, 'Robot'),
    h('h3', null, r.name),
    h('div', { class: 'muted', style: 'font-size: 12px' }, `${r.links.size} links · ${r.joints.size} joints (${movable} movable) · root ${r.roots.join(', ')}`),
  );
  if (model.failed.length) {
    selBox.append(h('div', { class: 'warnbox' }, `${model.failed.length} mesh(es) failed to load:`, ...model.failed.slice(0, 6).map((f) => h('div', { class: 'mono', style: 'font-size: 11px; word-break: break-all' }, f))));
  }
  if (!selectedLink) {
    selBox.append(h('div', { class: 'muted', style: 'font-size: 12px; margin-top: 6px' }, 'Click a link to inspect it.'));
    return;
  }
  const link = r.links.get(selectedLink);
  const parentJoint = [...r.joints.values()].find((j) => j.child === selectedLink);
  const childJoints = [...r.joints.values()].filter((j) => j.parent === selectedLink);
  const pose = model.linkPose(selectedLink);
  const rpy = pose ? new THREE.Euler().setFromQuaternion(pose.quat, 'ZYX') : undefined;
  const kv = h('div', { class: 'kv', style: 'margin-top: 4px' });
  const add = (k: string, v: string) => kv.append(h('span', null, k), h('span', { class: 'mono', style: 'word-break: break-all' }, v));
  add('parent joint', parentJoint ? `${parentJoint.name} (${parentJoint.type})` : '— (root)');
  add('child joints', childJoints.map((j) => j.name).join(', ') || '—');
  if (pose) add(`xyz in ${r.roots[0]}`, pose.xyz.toArray().map((v) => v.toFixed(4)).join(', '));
  if (rpy) add('rpy (deg)', [rpy.x, rpy.y, rpy.z].map((v) => ((v * 180) / Math.PI).toFixed(2)).join(', '));
  for (const v of link?.visuals ?? []) add('visual', v.geometry.type === 'mesh' ? v.geometry.filename : v.geometry.type);
  add('collisions', String(link?.collisions.length ?? 0));
  selBox.append(
    h('div', { class: 'kind', style: 'margin-top: 10px' }, 'Link'),
    h('h3', null, selectedLink),
    kv,
    h('button', { class: 'icon', onclick: () => select('') }, 'clear selection'),
  );
}

// ---- picking --------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const savedEmissive = new Map<THREE.Material, THREE.Color>();

function linkAt(ev: MouseEvent): string {
  if (!model) return '';
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(model.root, true).filter((i) => (i.object as THREE.Mesh).isMesh && i.object.visible && !i.object.userData.helper);
  for (const hit of hits) {
    let o: THREE.Object3D | null = hit.object;
    let visible = true;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) visible = false;
    if (!visible) continue;
    while (o && !o.userData.link) o = o.parent;
    if (o) return String(o.userData.link);
  }
  return '';
}

function setEmissive(link: string, on: boolean, color: number): void {
  if (!model || !link) return;
  for (const groups of [model.visualGroups, model.collisionGroups]) {
    groups.get(link)?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) {
        if (!mat.emissive) continue;
        if (on) {
          if (!savedEmissive.has(mat)) savedEmissive.set(mat, mat.emissive.clone());
          mat.emissive.setHex(color);
        } else {
          const c = savedEmissive.get(mat);
          if (c) mat.emissive.copy(c);
          savedEmissive.delete(mat);
        }
      }
    });
  }
  dirty = true;
}

function refreshHighlights(): void {
  for (const l of model?.links.keys() ?? []) setEmissive(l, false, 0);
  if (selectedLink) setEmissive(selectedLink, true, 0x7a4a00);
  if (hoverLink && hoverLink !== selectedLink) setEmissive(hoverLink, true, 0x1d4e89);
}

function select(link: string): void {
  selectedLink = link;
  refreshHighlights();
  renderSelection();
}

let moveQueued = false;
renderer.domElement.addEventListener('pointermove', (ev) => {
  if (moveQueued) return;
  moveQueued = true;
  requestAnimationFrame(() => {
    moveQueued = false;
    const l = linkAt(ev);
    if (l === hoverLink) return;
    hoverLink = l;
    hoverChip.classList.toggle('hidden', !l);
    hoverChip.textContent = l;
    renderer.domElement.style.cursor = l ? 'pointer' : '';
    refreshHighlights();
  });
});
let downAt: [number, number] | undefined;
renderer.domElement.addEventListener('pointerdown', (ev) => (downAt = [ev.clientX, ev.clientY]));
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 4) return;
  select(linkAt(ev));
});

// ---- status line ------------------------------------------------------------
setInterval(() => {
  jointRate = jointMsgs;
  jointMsgs = 0;
  syncJointRows();
  const parts: [string, string][] = [];
  if (model) {
    parts.push(['robot', model.robot.name]);
    if (model.pending) parts.push(['meshes', `loading ${model.pending}…`]);
    if (model.failed.length) parts.push(['meshes failed', String(model.failed.length)]);
  }
  if (ui.jointSource.startsWith('topic:')) {
    const st = ros.stats[ui.jointSource.slice(6)];
    parts.push(['joint states', `${fmtHz(st?.hz ?? jointRate)} Hz`]);
    if (model) parts.push(['matched', `${matched}/${model.movable.length}`]);
    if (unknownNames.length) parts.push(['not in URDF', unknownNames.slice(0, 4).join(', ') + (unknownNames.length > 4 ? ` +${unknownNames.length - 4}` : '')]);
  } else if (ui.jointSource.startsWith(SLIDERS)) parts.push(['joints', 'sliders (local only)']);
  if (ui.source) parts.push(['source', ui.source.replace(/^(\w+):/, '$1 ')]);
  if (loadError) parts.push(['error', loadError]);
  parts.push(['', 'drag: orbit · right-drag: pan · click: inspect link']);
  info.replaceChildren(...parts.map(([k, v]) => h('span', null, k ? `${k} ` : '', h('b', null, v))));
  if (model && model.failed.length && !selBox.querySelector('.warnbox')) renderSelection();
}, 1000);

// ---- wiring ---------------------------------------------------------------
function applyArgs(args: Record<string, unknown>): void {
  if (typeof args.file === 'string') {
    const want = `file:${args.file}`;
    if (ui.source !== want) {
      ui.source = want;
      fitted = false;
      save();
      refreshSelectors();
      loadSource();
      return;
    }
    if (args.reload !== undefined) loadSource(true);
  } else if (typeof args.topic === 'string' && args.topic) {
    ui.source = `topic:${args.topic}`;
    save();
    refreshSelectors();
    loadSource();
  }
}

// test hook
(window as unknown as Record<string, unknown>).__urdf = { camera, controls, scene, getModel: () => model, fitView };

ros.on('graph', () => refreshSelectors());
ros.on('init', (args) => {
  refreshSelectors();
  if (typeof args.file === 'string' || typeof args.topic === 'string') applyArgs(args);
  else if (ui.source) loadSource();
  connectJoints();
});
ros.on('args', applyArgs);
ros.start();
