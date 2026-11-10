import './common/base.css';
import './common/graph.css';
import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import type { GraphNode, GraphTopic, RosGraph } from '../shared/protocol';
import { ros, Subscription } from './common/ros';
import { graphPalette, GraphPalette, onThemeChange } from './common/theme';
import { clear, debounce, fmtHz, h, isCloudType, isImageType, statusBanner, toast } from './common/ui';

cytoscape.use(dagre);

type Mode = 'nodes' | 'active' | 'all';
interface Ui {
  mode: Mode;
  rankdir: 'LR' | 'TB';
  hideDebug: boolean;
  hideTf: boolean;
  hideDeadSinks: boolean;
  hideLeaf: boolean;
  hideHidden: boolean;
  groupNs: boolean;
  showHz: boolean;
  legend: boolean;
  filter: string;
}
const ui = ros.loadState<Ui>({
  mode: 'all',
  rankdir: 'LR',
  hideDebug: true,
  hideTf: false,
  hideDeadSinks: false,
  hideLeaf: false,
  hideHidden: true,
  groupNs: false,
  showHz: false,
  legend: true,
  filter: '',
});
const save = () => ros.saveState(ui);

const DEBUG_TOPICS = new Set([
  '/rosout',
  '/rosout_agg',
  '/parameter_events',
  '/clock',
  '/statistics',
  '/diagnostics',
  '/diagnostics_agg',
  '/diagnostics_toplevel_state',
]);
const TF_TOPICS = new Set(['/tf', '/tf_static']);
const MODE_LABEL: Record<Mode, [string, string]> = {
  nodes: ['Nodes', 'Nodes only; edges carry the connecting topics'],
  active: ['Active', 'Nodes + topics that have both a publisher and a subscriber'],
  all: ['All topics', 'Nodes + every topic (one-sided topics drawn dashed)'],
};

// ---- toolbar --------------------------------------------------------------
const app = document.getElementById('app')!;
const modeBtns = new Map<Mode, HTMLButtonElement>();
const seg = h('div', { class: 'seg' });
for (const m of ['nodes', 'active', 'all'] as Mode[]) {
  const b = h('button', { title: MODE_LABEL[m][1], onclick: () => setMode(m) }, MODE_LABEL[m][0]);
  modeBtns.set(m, b);
  seg.append(b);
}
const dirBtn = h('button', {
  class: 'tb-btn',
  title: 'Layout direction',
  onclick: () => {
    ui.rankdir = ui.rankdir === 'LR' ? 'TB' : 'LR';
    save();
    renderToolbar();
    applyStyle();
    runLayout(true);
  },
});
const filtersBtn = h('button', { class: 'tb-btn', title: 'Filters and display options' });
const searchIn = h('input', {
  type: 'search',
  placeholder: 'Filter: /ns, -/exclude, regex',
  value: ui.filter,
  style: 'width: 220px',
  title: 'Comma separated terms matched against node and topic names; prefix a term with - to exclude it',
});
searchIn.addEventListener(
  'input',
  debounce(() => {
    ui.filter = searchIn.value;
    save();
    rebuild(true);
  }, 250),
);

const popover = h('div', { class: 'popover hidden' });
function popCheck(key: keyof Ui, label: string, hint: string, after: () => void): HTMLLabelElement {
  const cb = h('input', {
    type: 'checkbox',
    checked: ui[key] as boolean,
    onchange: () => {
      (ui as unknown as Record<string, unknown>)[key] = cb.checked;
      save();
      renderToolbar();
      after();
    },
  });
  return h('label', null, cb, h('span', null, label, h('small', null, hint)));
}
popover.append(
  h('div', { class: 'pop-title' }, 'Hide'),
  popCheck('hideDebug', 'Debug topics', '/rosout, /parameter_events, /clock, diagnostics', () => rebuild(true)),
  popCheck('hideTf', 'TF', '/tf and /tf_static', () => rebuild(true)),
  popCheck('hideDeadSinks', 'Dead sinks', 'topics nobody subscribes to', () => rebuild(true)),
  popCheck('hideLeaf', 'Unfed topics', 'topics nobody publishes', () => rebuild(true)),
  popCheck('hideHidden', 'Hidden nodes', 'names starting with "_" (this visualiser, ros2cli daemon)', () => rebuild(true)),
  h('div', { class: 'pop-title', style: 'margin-top: 6px' }, 'Display'),
  popCheck('groupNs', 'Group by namespace', 'draw namespaces as boxes', () => rebuild(true)),
  popCheck('showHz', 'Topic rates', 'measure Hz of every shown topic (subscribes to them)', () => {
    syncHzSubs();
    updateLabels();
  }),
  popCheck('legend', 'Legend', 'show the legend in the corner', () => (legendChip.style.display = ui.legend ? '' : 'none')),
);
filtersBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = popover.classList.toggle('hidden') === false;
  filtersBtn.classList.toggle('open', open);
  if (open) {
    const r = filtersBtn.getBoundingClientRect();
    popover.style.left = `${r.left}px`;
    popover.style.top = `${r.bottom + 4}px`;
  }
});
document.addEventListener('click', (e) => {
  if (!popover.contains(e.target as Node) && e.target !== filtersBtn) {
    popover.classList.add('hidden');
    filtersBtn.classList.remove('open');
  }
});

function renderToolbar(): void {
  for (const [m, b] of modeBtns) b.classList.toggle('on', m === ui.mode);
  dirBtn.textContent = ui.rankdir === 'LR' ? '⇢ Left to right' : '⇣ Top to bottom';
  const n = [ui.hideDebug, ui.hideTf, ui.hideDeadSinks, ui.hideLeaf, ui.hideHidden, ui.groupNs, ui.showHz].filter(Boolean).length;
  filtersBtn.replaceChildren('Filters', h('span', { class: 'count-badge' }, String(n)), ' ▾');
}

const cyBox = h('div', { class: 'canvas-box grow' });
const statsChip = h('div', { class: 'chip', style: 'left: 10px; bottom: 10px' });
const legendChip = h('div', { class: 'chip', style: 'right: 10px; bottom: 10px' });
const notice = h('div', { class: 'notice hidden' });
const side = h('div', { class: 'side-panel scroll hidden' });
legendChip.style.display = ui.legend ? '' : 'none';
legendChip.append(
  h('span', { class: 'legend-item' }, h('span', { class: 'lg-node' }), 'node'),
  h('span', { class: 'legend-item' }, h('span', { class: 'lg-topic' }), 'topic'),
  h('span', { class: 'legend-item', title: 'topic without publisher or without subscriber' }, h('span', { class: 'lg-topic dashed' }), 'one-sided'),
  h('span', { class: 'legend-item', title: 'several nodes share this exact name' }, h('span', { class: 'lg-dup' }), 'duplicate name'),
);

app.append(
  statusBanner(),
  h(
    'div',
    { class: 'toolbar' },
    seg,
    dirBtn,
    filtersBtn,
    searchIn,
    h('span', { class: 'grow' }),
    h('button', { class: 'tb-btn', title: 'Re-run layout', onclick: () => runLayout(true) }, '⟳ Layout'),
    h('button', { class: 'tb-btn', title: 'Fit to view', onclick: () => fit() }, '⤢ Fit'),
    h('button', { class: 'tb-btn', title: 'Save as PNG', onclick: () => savePng() }, '⤓ PNG'),
  ),
  h('div', { class: 'row grow', style: 'align-items: stretch; gap: 0' }, cyBox, side),
  popover,
);
renderToolbar();

// ---- cytoscape ------------------------------------------------------------
let P: GraphPalette = graphPalette();

function stylesheet(): cytoscape.Stylesheet[] {
  const taxiDir = ui.rankdir === 'LR' ? 'horizontal' : 'vertical';
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'font-family': P.font,
        'font-size': 12,
        color: P.fg,
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': '260px',
        width: 'label',
        height: 'label',
        'min-zoomed-font-size': 5,
      } as cytoscape.Css.Node,
    },
    {
      selector: 'node.rosnode',
      style: {
        shape: 'round-rectangle',
        'corner-radius': '14',
        'background-color': P.nodeFill,
        'border-width': 1.5,
        'border-color': P.accent,
        'font-weight': 600,
        'padding-left': '14px',
        'padding-right': '14px',
        'padding-top': '8px',
        'padding-bottom': '8px',
      } as unknown as cytoscape.Css.Node,
    },
    { selector: 'node.rosnode.dup', style: { 'background-color': P.dupFill, 'border-color': P.warn } },
    {
      selector: 'node.topic',
      style: {
        shape: 'round-rectangle',
        'corner-radius': '3',
        'background-color': P.topicFill,
        'border-width': 1,
        'border-color': P.topicBorder,
        color: P.topicText,
        'font-family': P.mono,
        'font-size': 11,
        'padding-left': '9px',
        'padding-right': '9px',
        'padding-top': '5px',
        'padding-bottom': '5px',
      } as unknown as cytoscape.Css.Node,
    },
    { selector: 'node.topic.onesided', style: { 'border-style': 'dashed', color: P.muted } },
    {
      selector: 'node.ns',
      style: {
        shape: 'round-rectangle',
        'corner-radius': '8',
        'background-color': P.fg,
        'background-opacity': 0.025,
        'border-width': 1,
        'border-style': 'dashed',
        'border-color': P.nsBorder,
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -4,
        'font-family': P.mono,
        'font-size': 11,
        color: P.nsText,
        padding: '16px',
      } as unknown as cytoscape.Css.Node,
    },
    {
      selector: 'edge',
      style: {
        width: 1.3,
        'line-color': P.edge,
        'target-arrow-color': P.edge,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.8,
        'curve-style': ui.mode === 'nodes' ? 'bezier' : 'round-taxi',
        'taxi-direction': taxiDir,
        'taxi-turn': '50%',
        'taxi-radius': 8,
        'source-distance-from-node': 2,
        'target-distance-from-node': 2,
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
    {
      // edges that point against the layout direction (cycles) are drawn as arcs so they do not overlap forward edges
      selector: 'edge.back',
      style: { 'curve-style': 'unbundled-bezier', 'control-point-distances': [70], 'control-point-weights': [0.5] } as unknown as cytoscape.Css.Edge,
    },
    { selector: '.faded', style: { opacity: 0.16 } },
    { selector: 'edge.hl', style: { 'line-color': P.accent, 'target-arrow-color': P.accent, width: 2.2, 'z-index': 10, color: P.fg } },
    {
      selector: 'node.hl',
      style: { 'underlay-color': P.accent, 'underlay-opacity': 0.22, 'underlay-padding': 5, 'underlay-shape': 'round-rectangle' } as unknown as cytoscape.Css.Node,
    },
    { selector: 'node:selected', style: { 'border-width': 2.5, 'border-color': P.highlight } },
  ];
}

const cy = cytoscape({ container: cyBox, wheelSensitivity: 0.25, minZoom: 0.05, maxZoom: 4, style: stylesheet() });
// cytoscape inserts its canvas container into cyBox; append overlays after it so they stay on top
cyBox.append(statsChip, legendChip, notice);

function applyStyle(): void {
  cy.style(stylesheet());
  const root = document.documentElement.style;
  root.setProperty('--lg-accent', P.accent);
  root.setProperty('--lg-node-fill', P.nodeFill);
  root.setProperty('--lg-topic-border', P.topicBorder);
  root.setProperty('--lg-topic-fill', P.topicFill);
  root.setProperty('--lg-warn', P.warn);
  root.setProperty('--lg-dup-fill', P.dupFill);
}
applyStyle();
onThemeChange(() => {
  P = graphPalette();
  applyStyle();
});

let firstLayout = true;
let elementsSig = '';
let selectedId: string | undefined;
let userMoved = false;
const hzSubs = new Map<string, Subscription>();
let visibleTopics: string[] = [];

// ---- graph -> elements ----------------------------------------------------
function isHiddenNode(n: GraphNode): boolean {
  return n.self || n.name.startsWith('_') || n.fqn.includes('/_');
}

function compileFilter(): { inc: RegExp[]; exc: RegExp[] } {
  const inc: RegExp[] = [];
  const exc: RegExp[] = [];
  for (let term of ui.filter.split(',').map((s) => s.trim()).filter(Boolean)) {
    const neg = term.startsWith('-');
    if (neg) term = term.slice(1);
    if (!term) continue;
    let re: RegExp;
    try {
      re = new RegExp(term);
    } catch {
      re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
    (neg ? exc : inc).push(re);
  }
  return { inc, exc };
}

function nsChain(name: string): string[] {
  const parts = name.split('/').filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push('/' + parts.slice(0, i).join('/'));
  return out;
}

interface Built {
  els: cytoscape.ElementDefinition[];
  nodes: number;
  topics: number;
  links: number;
  oneSidedHidden: number;
  totalNodes: number;
}

function buildElements(g: RosGraph): Built {
  const { inc, exc } = compileFilter();
  const pass = (name: string) => (!inc.length || inc.some((r) => r.test(name))) && !exc.some((r) => r.test(name));
  const nodes = g.nodes.filter((n) => !(ui.hideHidden && isHiddenNode(n)) && pass(n.fqn));
  const nodeSet = new Set(nodes.map((n) => n.fqn));
  const totalNodes = g.nodes.filter((n) => !n.self).length;
  const topics: GraphTopic[] = [];
  let oneSidedHidden = 0;
  for (const t of g.topics) {
    if (ui.hideDebug && DEBUG_TOPICS.has(t.name)) continue;
    if (ui.hideTf && TF_TOPICS.has(t.name)) continue;
    if (exc.some((r) => r.test(t.name))) continue;
    const pubs = t.pubs.filter((p) => nodeSet.has(p));
    const subs = t.subs.filter((s) => nodeSet.has(s));
    if (!pubs.length && !subs.length) continue;
    if (ui.hideDeadSinks && !subs.length) continue;
    if (ui.hideLeaf && !pubs.length) continue;
    if (ui.mode === 'active' && (!pubs.length || !subs.length)) {
      oneSidedHidden++;
      continue;
    }
    topics.push({ ...t, pubs, subs });
  }
  visibleTopics = topics.map((t) => t.name);

  const els: cytoscape.ElementDefinition[] = [];
  const nsIds = new Set<string>();
  const parentOf = (name: string): string | undefined => {
    if (!ui.groupNs) return undefined;
    const chain = nsChain(name);
    for (let i = 0; i < chain.length; i++) {
      const id = `ns:${chain[i]}`;
      if (!nsIds.has(id)) {
        nsIds.add(id);
        els.push({ group: 'nodes', data: { id, label: chain[i], parent: i > 0 ? `ns:${chain[i - 1]}` : undefined }, classes: 'ns' });
      }
    }
    return chain.length ? `ns:${chain[chain.length - 1]}` : undefined;
  };
  const nodeEl = (n: GraphNode): cytoscape.ElementDefinition => {
    const dup = (n.count ?? 1) > 1;
    return {
      group: 'nodes',
      data: { id: `n:${n.fqn}`, label: dup ? `${n.fqn}  ×${n.count}` : n.fqn, parent: parentOf(n.fqn), fqn: n.fqn },
      classes: dup ? 'rosnode dup' : 'rosnode',
    };
  };

  let links = 0;
  if (ui.mode === 'nodes') {
    const edges = new Map<string, string[]>();
    for (const t of topics) {
      for (const p of t.pubs)
        for (const s of t.subs) {
          if (p === s) continue;
          const k = `${p}\u0000${s}`;
          (edges.get(k) ?? edges.set(k, []).get(k)!).push(t.name);
        }
    }
    for (const [k, names] of edges) {
      const [p, s] = k.split('\u0000');
      const label = names.length === 1 ? names[0] : `${names.length} topics`;
      els.push({ group: 'edges', data: { id: `e:${k}`, source: `n:${p}`, target: `n:${s}`, label, topics: names } });
    }
    for (const n of nodes) els.push(nodeEl(n));
    return { els, nodes: nodes.length, topics: 0, links: edges.size, oneSidedHidden: 0, totalNodes };
  }
  for (const t of topics) {
    const tid = `t:${t.name}`;
    const oneSided = !t.pubs.length || !t.subs.length;
    els.push({ group: 'nodes', data: { id: tid, label: t.name, parent: parentOf(t.name), topic: t.name }, classes: oneSided ? 'topic onesided' : 'topic' });
    for (const p of t.pubs) els.push({ group: 'edges', data: { id: `e:${p}>${tid}`, source: `n:${p}`, target: tid, label: '' } });
    for (const s of t.subs) els.push({ group: 'edges', data: { id: `e:${tid}>${s}`, source: tid, target: `n:${s}`, label: '' } });
    links += t.pubs.length + t.subs.length;
  }
  for (const n of nodes) els.push(nodeEl(n));
  return { els, nodes: nodes.length, topics: topics.length, links, oneSidedHidden, totalNodes };
}

function setMode(m: Mode): void {
  ui.mode = m;
  save();
  renderToolbar();
  applyStyle();
  rebuild(true);
}

function showNotice(content: (string | Node)[] | undefined, center = false): void {
  notice.classList.toggle('hidden', !content);
  notice.classList.toggle('center', center);
  if (content) notice.replaceChildren(...content);
}

function rebuild(force = false): void {
  const g = ros.graph;
  if (!g) {
    showNotice([h('span', { class: 'muted' }, 'Waiting for the ROS graph…')], true);
    return;
  }
  const b = buildElements(g);
  const ids = b.els
    .map((e) => String(e.data.id))
    .sort()
    .join('\n');
  const sig = ids + '#' + b.els.map((e) => `${e.data.label}|${e.classes ?? ''}`).join('\n');
  if (!force && sig === elementsSig) return;
  const structural = ids !== elementsSig.split('#')[0];
  elementsSig = sig;
  cy.batch(() => {
    cy.elements().remove();
    cy.add(b.els);
  });
  updateLabels();
  syncHzSubs();
  if (structural || force || firstLayout) runLayout(firstLayout || force || !userMoved);
  firstLayout = false;

  statsChip.replaceChildren(
    h('span', null, h('b', null, String(b.nodes)), ' nodes'),
    ui.mode === 'nodes' ? h('span', null, h('b', null, String(b.links)), ' connections') : h('span', null, h('b', null, String(b.topics)), ' topics'),
    ui.mode !== 'nodes' ? h('span', null, h('b', null, String(b.links)), ' links') : '',
    ros.status.info ? h('span', null, 'domain ', h('b', null, String(ros.status.info.domainId))) : '',
  );

  if (!b.totalNodes) {
    showNotice(
      [
        h('b', null, `No ROS nodes discovered${ros.status.info ? ` on domain ${ros.status.info.domainId}` : ''}`),
        h('span', { class: 'muted' }, 'Check ROS_DOMAIN_ID, ROS_AUTOMATIC_DISCOVERY_RANGE and that nodes are running.'),
      ],
      true,
    );
  } else if (!b.els.length) {
    showNotice([h('b', null, 'Nothing matches the current filters'), h('button', { class: 'secondary', onclick: () => resetFilters() }, 'Reset filters')], true);
  } else if (ui.mode === 'active' && b.topics === 0 && b.oneSidedHidden > 0) {
    showNotice([
      h('span', null, `No topic connects two nodes — all ${b.oneSidedHidden} topics have only publishers or only subscribers.`),
      h('button', { onclick: () => setMode('all') }, 'Show all topics'),
    ]);
  } else if (ui.mode === 'nodes' && b.links === 0 && b.nodes > 1) {
    showNotice([h('span', null, 'No topic connects these nodes.'), h('button', { onclick: () => setMode('all') }, 'Show all topics')]);
  } else {
    showNotice(undefined);
  }

  if (selectedId) {
    const el = cy.getElementById(selectedId);
    if (el.nonempty()) showInfo(el);
    else hideInfo();
  }
}

function resetFilters(): void {
  ui.filter = '';
  searchIn.value = '';
  ui.hideDeadSinks = false;
  ui.hideLeaf = false;
  save();
  renderToolbar();
  rebuild(true);
}

// ---- layout: dagre per connected component, components packed in rows ----
function fit(): void {
  if (!cy.elements().length) return;
  cy.fit(undefined, 40);
  if (cy.zoom() > 1.25) {
    cy.zoom(1.25);
    cy.center();
  }
  userMoved = false;
}

function runLayout(doFit: boolean): void {
  const dagreOpts = { name: 'dagre', rankDir: ui.rankdir, nodeSep: 14, rankSep: 60, edgeSep: 8, fit: false, animate: false };
  if (ui.groupNs) {
    cy.layout({ ...dagreOpts, padding: 30 } as cytoscape.LayoutOptions).run();
    markBackEdges();
    if (doFit) fit();
    return;
  }
  const comps = cy.elements().components();
  const multi = comps.filter((c) => c.nodes().length > 1).sort((a, b) => b.nodes().length - a.nodes().length);
  const singles = comps
    .filter((c) => c.nodes().length === 1)
    .map((c) => c.nodes()[0])
    .sort((a, b) => Number(a.hasClass('topic')) - Number(b.hasClass('topic')) || String(a.data('label')).localeCompare(String(b.data('label'))));

  const boxes = multi.map((c) => {
    c.layout(dagreOpts as cytoscape.LayoutOptions).run();
    return { c, bb: c.boundingBox({ includeLabels: true }) };
  });
  const GAP = 56;
  const W = Math.max(cyBox.clientWidth, 400);
  const H = Math.max(cyBox.clientHeight, 300);
  const singleW = singles.length ? Math.max(...singles.map((n) => n.outerWidth())) + 28 : 0;
  const singleH = singles.length ? Math.max(...singles.map((n) => n.outerHeight())) + 18 : 0;
  const area = boxes.reduce((s, b) => s + (b.bb.w + GAP) * (b.bb.h + GAP), 0) + singles.length * singleW * singleH;
  const rowMax = Math.max(Math.sqrt(area * (W / H)) * 1.05, ...boxes.map((b) => b.bb.w), singleW);

  // shelf packing; every row is centred and its components vertically centred
  type Placed = { c: cytoscape.CollectionReturnValue; bb: cytoscape.BoundingBox12 & cytoscape.BoundingBoxWH; x: number };
  const rows: { items: Placed[]; w: number; h: number }[] = [];
  let row = { items: [] as Placed[], w: 0, h: 0 };
  for (const { c, bb } of boxes) {
    if (row.items.length && row.w + GAP + bb.w > rowMax) {
      rows.push(row);
      row = { items: [], w: 0, h: 0 };
    }
    const x = row.items.length ? row.w + GAP : 0;
    row.items.push({ c, bb, x });
    row.w = x + bb.w;
    row.h = Math.max(row.h, bb.h);
  }
  if (row.items.length) rows.push(row);
  const width = Math.max(rowMax, ...rows.map((r) => r.w));
  let y = 0;
  for (const r of rows) {
    const off = (width - r.w) / 2;
    for (const it of r.items) it.c.nodes().shift({ x: off + it.x - it.bb.x1, y: y + (r.h - it.bb.h) / 2 - it.bb.y1 });
    y += r.h + GAP;
  }
  if (singles.length) {
    const cols = Math.max(1, Math.min(singles.length, Math.floor((width + 28) / singleW)));
    const gridRows = Math.ceil(singles.length / cols);
    singles.forEach((n, i) => {
      const r = Math.floor(i / cols);
      const inRow = r === gridRows - 1 ? singles.length - r * cols : cols;
      const off = (width - inRow * singleW) / 2;
      n.position({ x: off + (i % cols) * singleW + singleW / 2, y: y + r * singleH + singleH / 2 });
    });
  }
  markBackEdges();
  if (doFit) fit();
}

function markBackEdges(): void {
  const lr = ui.rankdir === 'LR';
  cy.batch(() => {
    cy.edges().forEach((e) => {
      const s = e.source().position();
      const t = e.target().position();
      e.toggleClass('back', lr ? t.x < s.x - 1 : t.y < s.y - 1);
    });
  });
}

function updateLabels(): void {
  cy.batch(() => {
    cy.nodes('.topic').forEach((n) => {
      const t = n.data('topic') as string;
      const s = ros.stats[t];
      n.data('label', ui.showHz && s ? `${t}\n${fmtHz(s.hz)} Hz` : t);
    });
  });
}

function syncHzSubs(): void {
  const want = new Set(ui.showHz && ui.mode !== 'nodes' ? visibleTopics : []);
  for (const [t, s] of hzSubs) {
    if (!want.has(t)) {
      s.close();
      hzSubs.delete(t);
    }
  }
  for (const t of want) if (!hzSubs.has(t)) hzSubs.set(t, ros.subscribe(t, 'stats', {}, () => undefined));
}

// ---- selection / info panel -----------------------------------------------
function highlight(el: cytoscape.SingularElementReturnValue | undefined): void {
  cy.batch(() => {
    cy.elements().removeClass('faded hl');
    if (!el) return;
    const hood = el.isEdge() ? el.union(el.connectedNodes()) : (el as cytoscape.NodeSingular).closedNeighborhood();
    cy.elements().not(hood).not('.ns').addClass('faded');
    hood.addClass('hl');
  });
}

function hideInfo(): void {
  selectedId = undefined;
  side.classList.add('hidden');
  highlight(undefined);
  cy.elements().unselect();
}

function itemList(title: string, items: [string, string[]][], onClick?: (name: string, types: string[]) => void): HTMLElement {
  const box = h('div', null, h('div', { class: 'section-title' }, `${title} · ${items.length}`));
  if (!items.length) box.append(h('div', { class: 'muted', style: 'font-size: 12px; padding: 2px 4px' }, 'none'));
  for (const [name, types] of items) {
    const row = h('div', { class: 'item', title: types.join(', ') }, name, types.length ? h('div', { class: 't' }, types.join(', ')) : '');
    if (onClick) row.addEventListener('click', () => onClick(name, types));
    else row.style.cursor = 'default';
    box.append(row);
  }
  return box;
}

const PARAM_SRV = /\/(describe_parameters|get_parameter_types|get_parameters|list_parameters|set_parameters|set_parameters_atomically|get_type_description)$/;

function showInfo(el: cytoscape.SingularElementReturnValue): void {
  selectedId = el.id();
  side.classList.remove('hidden');
  clear(side);
  highlight(el);
  const g = ros.graph;
  if (!g) return;
  const close = h('button', { class: 'icon', style: 'float: right', onclick: () => hideInfo() }, '✕');
  const focus = (id: string): boolean => {
    const t = cy.getElementById(id);
    if (t.nonempty()) {
      cy.animate({ center: { eles: t }, duration: 200 });
      showInfo(t);
      return true;
    }
    return false;
  };
  if (el.hasClass('rosnode')) {
    const n = g.nodes.find((x) => x.fqn === el.data('fqn'));
    if (!n) return;
    side.append(
      close,
      h('div', { class: 'kind' }, 'Node'),
      h('h3', null, n.fqn),
      (n.count ?? 1) > 1
        ? h('div', { class: 'warnbox' }, `${n.count} nodes share this exact name — usually stale processes or a node launched twice. Their endpoints are merged here.`)
        : '',
      h('div', { class: 'row', style: 'flex-wrap: wrap; margin: 6px 0' }, h('button', { onclick: () => ros.command('rosVis.openParams', { node: n.fqn }) }, 'Parameters')),
      itemList('Publishes', n.pubs, (t) => {
        if (!focus(`t:${t}`)) ros.command('rosVis.openTopics', { topic: t });
      }),
      itemList('Subscribes', n.subs, (t) => {
        if (!focus(`t:${t}`)) ros.command('rosVis.openTopics', { topic: t });
      }),
      itemList(
        'Services',
        n.srvs.filter(([s]) => !PARAM_SRV.test(s)),
        (s, ty) => ros.command('rosVis.openService', { service: s, type: ty[0] }),
      ),
      n.clients.length ? itemList('Service clients', n.clients) : '',
      n.actionServers.length ? itemList('Action servers', n.actionServers) : '',
      n.actionClients.length ? itemList('Action clients', n.actionClients) : '',
    );
  } else if (el.hasClass('topic')) {
    const t = g.topics.find((x) => x.name === el.data('topic'));
    if (!t) return;
    const s = ros.stats[t.name];
    side.append(
      close,
      h('div', { class: 'kind' }, 'Topic'),
      h('h3', null, t.name),
      h('div', { class: 'badge' }, t.types.join(', ')),
      s ? h('div', { class: 'muted', style: 'margin-top: 4px' }, `${fmtHz(s.hz)} Hz`) : '',
      !t.pubs.length ? h('div', { class: 'warnbox' }, 'No publisher.') : !t.subs.length ? h('div', { class: 'warnbox' }, 'No subscriber.') : '',
      h(
        'div',
        { class: 'row', style: 'flex-wrap: wrap; margin: 8px 0' },
        h('button', { onclick: () => ros.command('rosVis.openTopics', { topic: t.name }) }, 'Monitor'),
        isImageType(t.types) ? h('button', { class: 'secondary', onclick: () => ros.command('rosVis.openImage', { topic: t.name }) }, 'Image') : '',
        isCloudType(t.types) ? h('button', { class: 'secondary', onclick: () => ros.command('rosVis.openPointCloud', { topic: t.name }) }, '3D') : '',
        h('button', { class: 'secondary', onclick: () => ros.command('rosVis.openPlot', { topic: t.name, type: t.types[0] }) }, 'Plot'),
      ),
      itemList('Publishers', t.pubs.map((p) => [p, []]), (p) => void focus(`n:${p}`)),
      itemList('Subscribers', t.subs.map((p) => [p, []]), (p) => void focus(`n:${p}`)),
    );
  } else if (el.isEdge() && el.data('topics')) {
    const names = el.data('topics') as string[];
    side.append(
      close,
      h('div', { class: 'kind' }, 'Connection'),
      h('h3', null, `${el.source().data('fqn')} → ${el.target().data('fqn')}`),
      itemList(
        'Topics',
        names.map((n) => [n, ros.topicTypes(n)]),
        (n) => ros.command('rosVis.openTopics', { topic: n }),
      ),
    );
  } else {
    hideInfo();
  }
}

cy.on('tap', (e) => {
  if (e.target === cy) hideInfo();
  else if (!e.target.hasClass('ns')) showInfo(e.target);
});
cy.on('dbltap', 'node.topic', (e) => ros.command('rosVis.openTopics', { topic: e.target.data('topic') }));
cy.on('dbltap', 'node.rosnode', (e) => ros.command('rosVis.openParams', { node: e.target.data('fqn') }));
cy.on('mouseover', 'node.rosnode, node.topic, edge', (e) => {
  if (!selectedId) highlight(e.target);
  cyBox.style.cursor = 'pointer';
});
cy.on('mouseout', 'node, edge', () => {
  if (!selectedId) highlight(undefined);
  cyBox.style.cursor = '';
});
cy.on('dragfree', 'node', () => (userMoved = true));
cyBox.addEventListener('wheel', () => (userMoved = true), { passive: true });

function savePng(): void {
  const b64 = cy.png({ output: 'base64', full: true, scale: 2, bg: P.bg }) as unknown as string;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  ros.saveFile('ros_graph.png', bytes, { Images: ['png'] });
  toast('Choose where to save the PNG…');
}

new ResizeObserver(() => cy.resize()).observe(cyBox);
// test hook
(window as unknown as { __cy: cytoscape.Core }).__cy = cy;

ros.on('graph', () => rebuild(false));
ros.on('stats', () => {
  if (ui.showHz) updateLabels();
  if (selectedId) {
    const el = cy.getElementById(selectedId);
    if (el.nonempty() && el.hasClass('topic')) showInfo(el);
  }
});
ros.on('status', () => rebuild(false));
ros.on('init', () => rebuild(true));
ros.start();
