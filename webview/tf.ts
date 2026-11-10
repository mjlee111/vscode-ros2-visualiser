import './common/base.css';
import './common/graph.css';
import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { ros } from './common/ros';
import { graphPalette, mix, onThemeChange } from './common/theme';
import { clear, fmtHz, fmtSec, h, statusBanner, toast } from './common/ui';

cytoscape.use(dagre);

interface Frame {
  parent: string;
  hz: number;
  count: number;
  t: [number, number, number] | null;
  q: [number, number, number, number] | null;
  stamp: number | null;
  age: number | null;
  isStatic?: boolean;
}
interface Ui {
  rankdir: 'TB' | 'LR';
  source: string;
  target: string;
}
const ui = ros.loadState<Ui>({ rankdir: 'TB', source: '', target: '' });
const save = () => ros.saveState(ui);

const dynamicFrames: Record<string, Frame> = {};
const staticFrames: Record<string, Frame> = {};
let structureSig = '';
let selected = '';

function frames(): Record<string, Frame> {
  const out: Record<string, Frame> = {};
  for (const [k, f] of Object.entries(staticFrames)) out[k] = { ...f, isStatic: true };
  for (const [k, f] of Object.entries(dynamicFrames)) out[k] = { ...f, isStatic: false };
  return out;
}

// ---- layout ---------------------------------------------------------------
const app = document.getElementById('app')!;
const dirSel = h(
  'select',
  {
    onchange: () => {
      ui.rankdir = dirSel.value as Ui['rankdir'];
      save();
      cy.style(tfStyle());
      layout();
    },
  },
  h('option', { value: 'TB', selected: ui.rankdir === 'TB' }, 'Top → Bottom'),
  h('option', { value: 'LR', selected: ui.rankdir === 'LR' }, 'Left → Right'),
);
const srcSel = h('select', { title: 'source frame' });
const dstSel = h('select', { title: 'target frame' });
const lookupOut = h('span', { class: 'mono', style: 'font-size: 12px' });
for (const s of [srcSel, dstSel])
  s.addEventListener('change', () => {
    ui.source = srcSel.value;
    ui.target = dstSel.value;
    save();
    lookup();
  });
const statusText = h('span', { class: 'muted' });
const cyBox = h('div', { class: 'canvas-box grow' });
const side = h('div', { class: 'scroll hidden', style: 'flex: 0 0 300px; border-left: 1px solid var(--border); padding: 8px 10px; background: var(--bg2)' });
app.append(
  statusBanner(),
  h(
    'div',
    { class: 'toolbar' },
    dirSel,
    h('button', { class: 'secondary', onclick: () => cy.fit(undefined, 30) }, '⤢ Fit'),
    h('button', { class: 'secondary', title: 'Copy the tree as text', onclick: () => copyTree() }, 'Copy'),
    h('span', { class: 'sep' }),
    h('span', { class: 'muted' }, 'lookup'),
    dstSel,
    h('span', { class: 'muted' }, '←'),
    srcSel,
    lookupOut,
    h('span', { class: 'grow' }),
    statusText,
  ),
  h('div', { class: 'row grow', style: 'align-items: stretch; gap: 0' }, cyBox, side),
);

function tfStyle(): cytoscape.Stylesheet[] {
  const P = graphPalette();
  return [
    {
      selector: 'node',
      style: {
        label: 'data(id)',
        shape: 'round-rectangle',
        'corner-radius': '14',
        'background-color': P.nodeFill,
        'border-width': 1.5,
        'border-color': P.accent,
        color: P.fg,
        'font-family': P.mono,
        'font-size': 12,
        'font-weight': 600,
        'text-valign': 'center',
        width: 'label',
        height: 'label',
        'padding-left': '13px',
        'padding-right': '13px',
        'padding-top': '7px',
        'padding-bottom': '7px',
      } as unknown as cytoscape.Css.Node,
    },
    { selector: 'node.root', style: { 'background-color': mix(P.bg, P.ok, 0.22), 'border-color': P.ok } },
    { selector: 'node.stale', style: { 'background-color': P.dupFill, 'border-color': P.warn } },
    {
      selector: 'node:selected',
      style: { 'underlay-color': P.accent, 'underlay-opacity': 0.25, 'underlay-padding': 5, 'underlay-shape': 'round-rectangle' } as unknown as cytoscape.Css.Node,
    },
    {
      selector: 'edge',
      style: {
        width: 1.3,
        'line-color': P.edge,
        'target-arrow-color': P.edge,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.8,
        'curve-style': 'round-taxi',
        'taxi-direction': ui.rankdir === 'LR' ? 'horizontal' : 'vertical',
        'taxi-turn': '50%',
        'taxi-radius': 8,
        label: 'data(label)',
        'font-family': P.mono,
        'font-size': 10,
        color: P.muted,
        'text-background-color': P.bg,
        'text-background-opacity': 0.9,
        'text-background-padding': '2px',
        'text-background-shape': 'roundrectangle',
      } as unknown as cytoscape.Css.Edge,
    },
    { selector: 'edge.static', style: { 'line-style': 'dashed' } },
  ];
}
const cy = cytoscape({ container: cyBox, wheelSensitivity: 0.25, style: tfStyle() });
onThemeChange(() => cy.style(tfStyle()));
new ResizeObserver(() => cy.resize()).observe(cyBox);
// test hook
(window as unknown as { __cy: cytoscape.Core }).__cy = cy;

function layout(): void {
  cy.layout({ name: 'dagre', rankDir: ui.rankdir, nodeSep: 20, rankSep: 60, fit: true, padding: 30 } as cytoscape.LayoutOptions).run();
  if (cy.zoom() > 1.3) {
    cy.zoom(1.3);
    cy.center();
  }
}

function render(): void {
  const fr = frames();
  const names = new Set<string>(Object.keys(fr));
  for (const f of Object.values(fr)) if (f.parent) names.add(f.parent);
  const sig = [...names].sort().join('|') + '#' + Object.entries(fr).map(([c, f]) => `${f.parent}>${c}`).sort().join('|');
  if (sig !== structureSig) {
    structureSig = sig;
    const els: cytoscape.ElementDefinition[] = [];
    for (const n of names) els.push({ group: 'nodes', data: { id: n } });
    for (const [child, f] of Object.entries(fr)) if (f.parent) els.push({ group: 'edges', data: { id: `${f.parent}>${child}`, source: f.parent, target: child, label: '' } });
    cy.batch(() => {
      cy.elements().remove();
      cy.add(els);
    });
    layout();
    updateLookupOptions([...names].sort());
  }
  cy.batch(() => {
    cy.nodes().forEach((n) => {
      const f = fr[n.id()];
      n.toggleClass('root', !f);
      n.toggleClass('missing', false);
      n.toggleClass('stale', !!f && !f.isStatic && (f.age ?? 0) > 2);
    });
    cy.edges().forEach((e) => {
      const f = fr[e.target().id()];
      e.toggleClass('static', !!f?.isStatic);
      e.data('label', f && !f.isStatic ? `${fmtHz(f.hz)} Hz` : '');
    });
  });
  const roots = cy.nodes('.root').length;
  statusText.textContent = `dashed = static · ${names.size} frames · ${roots} root${roots === 1 ? '' : 's'}${roots > 1 ? ' (disconnected trees!)' : ''}`;
  if (selected) showInfo(selected);
  lookup();
}

// ---- transforms -----------------------------------------------------------
type Vec = [number, number, number];
type Quat = [number, number, number, number];
interface Tf {
  t: Vec;
  q: Quat;
}
const ID: Tf = { t: [0, 0, 0], q: [0, 0, 0, 1] };
function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
function qrot(q: Quat, v: Vec): Vec {
  const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]);
  return [p[0], p[1], p[2]];
}
function compose(a: Tf, b: Tf): Tf {
  const r = qrot(a.q, b.t);
  return { t: [a.t[0] + r[0], a.t[1] + r[1], a.t[2] + r[2]], q: qmul(a.q, b.q) };
}
function inverse(a: Tf): Tf {
  const qi: Quat = [-a.q[0], -a.q[1], -a.q[2], a.q[3]];
  const t = qrot(qi, a.t);
  return { t: [-t[0], -t[1], -t[2]], q: qi };
}
function rpy(q: Quat): Vec {
  const [x, y, z, w] = q;
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const sp = 2 * (w * y - z * x);
  const pitch = Math.abs(sp) >= 1 ? (Math.sign(sp) * Math.PI) / 2 : Math.asin(sp);
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return [roll, pitch, yaw];
}
/** Transform of `frame` expressed in its tree root, plus the root name. */
function toRoot(frame: string, fr: Record<string, Frame>): { tf: Tf; root: string } {
  let tf = ID;
  let cur = frame;
  const seen = new Set<string>();
  while (fr[cur] && fr[cur].t && fr[cur].q && !seen.has(cur)) {
    seen.add(cur);
    tf = compose({ t: fr[cur].t!, q: fr[cur].q! }, tf);
    cur = fr[cur].parent;
  }
  return { tf, root: cur };
}
const fix = (x: number, d: number) => (Math.abs(x) < 0.5 * 10 ** -d ? 0 : x).toFixed(d);
const f3 = (v: number[]) => v.map((x) => fix(x, 4)).join(', ');
const deg = (v: number[]) => v.map((x) => fix((x * 180) / Math.PI, 2)).join(', ');

function lookup(): void {
  const src = srcSel.value;
  const dst = dstSel.value;
  if (!src || !dst) {
    lookupOut.textContent = '';
    return;
  }
  const fr = frames();
  const a = toRoot(src, fr);
  const b = toRoot(dst, fr);
  if (a.root !== b.root) {
    lookupOut.textContent = '✗ frames are not connected';
    lookupOut.className = 'mono err';
    return;
  }
  const rel = compose(inverse(b.tf), a.tf);
  lookupOut.className = 'mono';
  lookupOut.textContent = `t [${f3(rel.t)}]  rpy° [${deg(rpy(rel.q))}]`;
  lookupOut.title = `q [${f3(rel.q)}]`;
}

function updateLookupOptions(names: string[]): void {
  for (const [sel, val] of [
    [srcSel, ui.source],
    [dstSel, ui.target],
  ] as [HTMLSelectElement, string][]) {
    clear(sel);
    sel.append(h('option', { value: '' }, sel === srcSel ? 'source' : 'target'));
    for (const n of names) sel.append(h('option', { value: n, selected: n === val }, n));
  }
}

// ---- info -----------------------------------------------------------------
function showInfo(name: string): void {
  selected = name;
  const fr = frames();
  const f = fr[name];
  side.classList.remove('hidden');
  clear(side);
  const children = Object.entries(fr)
    .filter(([, x]) => x.parent === name)
    .map(([c]) => c);
  side.append(h('button', { class: 'icon', style: 'float: right', onclick: () => ((selected = ''), side.classList.add('hidden')) }, '✕'), h('h3', { class: 'mono', style: 'margin: 4px 0' }, name));
  const kv = h('div', { class: 'kv' });
  const add = (k: string, v: string) => kv.append(h('span', null, k), h('span', { class: 'mono' }, v));
  if (!f) add('role', 'root (no parent)');
  else {
    add('parent', f.parent);
    add('type', f.isStatic ? 'static' : 'dynamic');
    if (!f.isStatic) add('rate', `${fmtHz(f.hz)} Hz`);
    add('updates', String(f.count));
    if (f.age !== null && !f.isStatic) add('last update', `${fmtSec(f.age)} ago`);
    if (f.t) add('translation', f3(f.t));
    if (f.q) {
      add('rotation (xyzw)', f3(f.q));
      add('rpy (deg)', deg(rpy(f.q)));
    }
    const root = toRoot(name, fr);
    add(`in ${root.root}`, `t [${f3(root.tf.t)}]`);
  }
  add('children', children.join(', ') || '—');
  side.append(kv);
}

cy.on('tap', 'node', (e) => showInfo(e.target.id()));
cy.on('tap', (e) => {
  if (e.target === cy) {
    selected = '';
    side.classList.add('hidden');
  }
});

function copyTree(): void {
  const fr = frames();
  const kids = new Map<string, string[]>();
  for (const [c, f] of Object.entries(fr)) (kids.get(f.parent) ?? kids.set(f.parent, []).get(f.parent)!).push(c);
  const roots = cy.nodes('.root').map((n) => n.id());
  const lines: string[] = [];
  const walk = (n: string, ind: string) => {
    const f = fr[n];
    lines.push(`${ind}${n}${f ? (f.isStatic ? '  (static)' : `  (${fmtHz(f.hz)} Hz)`) : ''}`);
    for (const c of (kids.get(n) ?? []).sort()) walk(c, ind + '  ');
  };
  for (const r of roots) walk(r, '');
  ros.copy(lines.join('\n'));
  toast('Copied TF tree', 'ok');
}

ros.on('init', () => {
  for (const [topic, store] of [
    ['/tf', dynamicFrames],
    ['/tf_static', staticFrames],
  ] as [string, Record<string, Frame>][]) {
    ros.subscribe(
      topic,
      'tf',
      {},
      (ev) => {
        if (ev.ev !== 'tf') return;
        Object.assign(store, ev.frames as Record<string, Frame>);
        render();
      },
      'tf2_msgs/msg/TFMessage',
    );
  }
  statusText.textContent = 'waiting for /tf and /tf_static…';
});
ros.start();
