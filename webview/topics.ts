import './common/base.css';
import type { GraphTopic, TopicStats } from '../shared/protocol';
import { MsgTree, toYaml } from './common/msgtree';
import { ros, Subscription } from './common/ros';
import { clear, fmtBw, fmtBytes, fmtHz, fmtSec, h, isCloudType, isImageType, statusBanner, toast } from './common/ui';

interface Ui {
  monitored: string[];
  filter: string;
  arrayLimit: number;
  rate: number;
  sort: 'name' | 'type' | 'hz' | 'bw';
  hideHidden: boolean;
}
const ui = ros.loadState<Ui>({ monitored: [], filter: '', arrayLimit: 64, rate: 10, sort: 'name', hideHidden: false });
const save = () => ros.saveState(ui);

interface Row {
  tr: HTMLTableRowElement;
  cb: HTMLInputElement;
  hz: HTMLTableCellElement;
  bw: HTMLTableCellElement;
  size: HTMLTableCellElement;
  pubs: HTMLTableCellElement;
  subs: HTMLTableCellElement;
}

const rows = new Map<string, Row>();
const statsSubs = new Map<string, Subscription>();
let selected = '';
let echoSub: Subscription | undefined;
let paused = false;
let lastMsg: unknown;
let msgCount = 0;

// ---- layout ---------------------------------------------------------------
const app = document.getElementById('app')!;
const filterInput = h('input', {
  type: 'search',
  placeholder: 'Filter topics (substring or /regex/)',
  value: ui.filter,
  style: 'width: 260px',
  oninput: () => {
    ui.filter = filterInput.value;
    save();
    applyFilter();
  },
});
const countLabel = h('span', { class: 'muted' });
const monitorAll = h('button', { class: 'secondary', title: 'Measure Hz/bandwidth of all visible topics', onclick: () => setAllMonitored(true) }, 'Monitor all');
const monitorNone = h('button', { class: 'secondary', onclick: () => setAllMonitored(false) }, 'None');
const hideHiddenCb = h('input', {
  type: 'checkbox',
  checked: ui.hideHidden,
  onchange: () => {
    ui.hideHidden = hideHiddenCb.checked;
    save();
    renderTable();
  },
});

const tbody = h('tbody');
const thead = h(
  'thead',
  null,
  h(
    'tr',
    null,
    h('th', { title: 'Monitor (Hz / bandwidth)' }, '◉'),
    sortTh('Topic', 'name'),
    sortTh('Type', 'type'),
    h('th', { class: 'num' }, 'Pub'),
    h('th', { class: 'num' }, 'Sub'),
    sortTh('Hz', 'hz', true),
    sortTh('Bandwidth', 'bw', true),
    h('th', { class: 'num' }, 'Size'),
  ),
);
const table = h('table', { class: 'grid' }, thead, tbody);
const left = h('div', { class: 'scroll', style: 'flex: 0 0 55%; min-width: 280px' }, table);
const detail = h('div', { class: 'scroll grow', style: 'padding: 8px 12px' });
const splitter = h('div', { class: 'splitter' });
const body = h('div', { class: 'row grow', style: 'align-items: stretch; gap: 0' }, left, splitter, detail);

app.append(
  statusBanner(),
  h(
    'div',
    { class: 'toolbar' },
    filterInput,
    monitorAll,
    monitorNone,
    h('label', { title: 'Hide topics without any publisher or subscriber besides the visualiser' }, hideHiddenCb, 'Hide inactive'),
    h('span', { class: 'grow' }),
    countLabel,
  ),
  body,
);
initSplitter();
renderDetailEmpty();

function sortTh(label: string, key: Ui['sort'], num = false): HTMLTableCellElement {
  return h(
    'th',
    {
      class: `sortable${num ? ' num' : ''}`,
      onclick: () => {
        ui.sort = key;
        save();
        renderTable();
      },
    },
    label,
  );
}

function initSplitter(): void {
  let dragging = false;
  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const r = body.getBoundingClientRect();
    const pct = Math.min(85, Math.max(20, ((e.clientX - r.left) / r.width) * 100));
    left.style.flex = `0 0 ${pct}%`;
  });
  window.addEventListener('mouseup', () => (dragging = false));
}

// ---- table ----------------------------------------------------------------
function matches(name: string, type: string): boolean {
  const f = ui.filter.trim();
  if (!f) return true;
  if (f.length > 2 && f.startsWith('/') && f.endsWith('/')) {
    try {
      return new RegExp(f.slice(1, -1)).test(name);
    } catch {
      return true;
    }
  }
  const lf = f.toLowerCase();
  return name.toLowerCase().includes(lf) || type.toLowerCase().includes(lf);
}

function applyFilter(): void {
  let shown = 0;
  for (const [name, r] of rows) {
    const vis = matches(name, r.tr.dataset.type ?? '');
    r.tr.classList.toggle('hidden', !vis);
    if (vis) shown++;
  }
  countLabel.textContent = `${shown} / ${rows.size} topics`;
}

function sortedTopics(): GraphTopic[] {
  let topics = [...(ros.graph?.topics ?? [])];
  if (ui.hideHidden) topics = topics.filter((t) => t.pubs.length + t.subs.length > 0);
  const st = ros.stats;
  switch (ui.sort) {
    case 'type':
      return topics.sort((a, b) => (a.types[0] ?? '').localeCompare(b.types[0] ?? '') || a.name.localeCompare(b.name));
    case 'hz':
      return topics.sort((a, b) => (st[b.name]?.hz ?? -1) - (st[a.name]?.hz ?? -1));
    case 'bw':
      return topics.sort((a, b) => (st[b.name]?.bw ?? -1) - (st[a.name]?.bw ?? -1));
    default:
      return topics.sort((a, b) => a.name.localeCompare(b.name));
  }
}

function renderTable(): void {
  rows.clear();
  clear(tbody);
  for (const t of sortedTopics()) {
    const cb = h('input', {
      type: 'checkbox',
      checked: statsSubs.has(t.name) || ui.monitored.includes(t.name),
      onclick: (e: Event) => e.stopPropagation(),
      onchange: () => setMonitored(t.name, cb.checked),
    });
    const r: Row = {
      tr: h('tr', { onclick: () => select(t.name) }),
      cb,
      hz: h('td', { class: 'num' }, '—'),
      bw: h('td', { class: 'num' }, '—'),
      size: h('td', { class: 'num' }, '—'),
      pubs: h('td', { class: 'num' }, String(t.pubs.length)),
      subs: h('td', { class: 'num' }, String(t.subs.length)),
    };
    r.tr.dataset.type = t.types.join(',');
    r.tr.append(
      h('td', null, cb),
      h('td', { class: 'mono', title: t.name }, t.name),
      h('td', { class: 'muted ellipsis', title: t.types.join(', ') }, t.types.map((x) => x.replace('/msg/', '/')).join(', ')),
      r.pubs,
      r.subs,
      r.hz,
      r.bw,
      r.size,
    );
    if (t.name === selected) r.tr.classList.add('selected');
    rows.set(t.name, r);
    tbody.append(r.tr);
  }
  applyFilter();
  updateStats(ros.stats);
}

function updateStats(stats: Record<string, TopicStats>): void {
  for (const [name, r] of rows) {
    const s = stats[name];
    r.hz.textContent = s ? fmtHz(s.hz) : '—';
    r.bw.textContent = s ? fmtBw(s.bw) : '—';
    r.size.textContent = s && s.size ? fmtBytes(s.size) : '—';
    r.hz.classList.toggle('warn', !!s && !!s.stale);
  }
  if (selected) renderStats(stats[selected]);
}

function setMonitored(topic: string, on: boolean): void {
  const cur = statsSubs.get(topic);
  if (on && !cur) {
    statsSubs.set(topic, ros.subscribe(topic, 'stats', {}, () => undefined));
    if (!ui.monitored.includes(topic)) ui.monitored.push(topic);
  } else if (!on && cur) {
    cur.close();
    statsSubs.delete(topic);
    ui.monitored = ui.monitored.filter((t) => t !== topic);
  }
  const r = rows.get(topic);
  if (r) r.cb.checked = on;
  save();
}

function setAllMonitored(on: boolean): void {
  for (const [name, r] of rows) {
    if (!r.tr.classList.contains('hidden') || !on) setMonitored(name, on);
  }
}

// ---- detail ---------------------------------------------------------------
let statsBox: HTMLElement | undefined;
let infoBox: HTMLElement | undefined;
let msgMeta: HTMLElement | undefined;
const tree = new MsgTree({
  leafActionTitle: 'Plot this field',
  onLeaf: (path) => ros.command('rosVis.openPlot', { topic: selected, field: path, type: ros.topicTypes(selected)[0] }),
});

function renderDetailEmpty(): void {
  clear(detail);
  detail.append(h('div', { class: 'empty' }, 'Select a topic to see publishers, subscribers, statistics and live messages.'));
}

function select(topic: string): void {
  if (topic === selected) return;
  rows.get(selected)?.tr.classList.remove('selected');
  selected = topic;
  rows.get(topic)?.tr.classList.add('selected');
  ros.args.topic = topic;
  save();
  echoSub?.close();
  echoSub = undefined;
  lastMsg = undefined;
  msgCount = 0;
  paused = false;
  tree.clear();
  renderDetail();
  startEcho();
}

function startEcho(): void {
  echoSub?.close();
  if (!selected) return;
  echoSub = ros.subscribe(
    selected,
    'json',
    { maxRate: ui.rate, arrayLimit: ui.arrayLimit },
    (ev) => {
      if (ev.ev === 'subError') {
        msgMeta && (msgMeta.textContent = `Error: ${ev.error}`);
        return;
      }
      if (ev.ev === 'subInfo') {
        void refreshInfo();
        return;
      }
      if (ev.ev !== 'msg') return;
      msgCount++;
      lastMsg = ev.msg;
      if (paused) return;
      tree.set(ev.msg);
      if (msgMeta) msgMeta.textContent = `received ${msgCount} (display ≤ ${ui.rate} Hz)`;
    },
    ros.topicTypes(selected)[0],
  );
}

function renderDetail(): void {
  clear(detail);
  const types = ros.topicTypes(selected);
  const type = types[0] ?? '?';
  const pauseBtn = h(
    'button',
    {
      class: 'secondary',
      onclick: () => {
        paused = !paused;
        pauseBtn.textContent = paused ? 'Resume' : 'Pause';
        if (!paused && lastMsg !== undefined) tree.set(lastMsg);
      },
    },
    'Pause',
  );
  const rateSel = h(
    'select',
    {
      title: 'Display rate',
      onchange: () => {
        ui.rate = Number(rateSel.value);
        save();
        echoSub?.update({ maxRate: ui.rate });
      },
    },
    ...[1, 2, 5, 10, 30, 0].map((r) => h('option', { value: String(r), selected: r === ui.rate }, r ? `${r} Hz` : 'all')),
  );
  const limitIn = h('input', {
    type: 'number',
    min: '1',
    value: String(ui.arrayLimit),
    title: 'Max array items shown',
    style: 'width: 64px',
    onchange: () => {
      ui.arrayLimit = Math.max(1, Number(limitIn.value) || 64);
      save();
      echoSub?.update({ arrayLimit: ui.arrayLimit });
    },
  });
  const actions = h(
    'div',
    { class: 'row', style: 'flex-wrap: wrap; margin: 6px 0' },
    isImageType(types) ? h('button', { onclick: () => ros.command('rosVis.openImage', { topic: selected }) }, '🖼 Image view') : null,
    isCloudType(types) ? h('button', { onclick: () => ros.command('rosVis.openPointCloud', { topic: selected }) }, '🌐 3D view') : null,
    h('button', { class: 'secondary', onclick: () => ros.command('rosVis.openPlot', { topic: selected, type }) }, '📈 Plot'),
    h('button', { class: 'secondary', onclick: () => ros.command('rosVis.openPublisher', { topic: selected, type }) }, '📤 Publish'),
    h('button', { class: 'secondary', onclick: () => ros.command('rosVis.showInterface', type) }, '{ } Definition'),
  );
  statsBox = h('div', { class: 'kv' });
  infoBox = h('div');
  msgMeta = h('span', { class: 'muted' }, 'waiting for messages…');
  detail.append(
    h('div', { class: 'row', style: 'flex-wrap: wrap' }, h('h3', { class: 'mono', style: 'margin: 4px 0' }, selected), h('span', { class: 'badge' }, type)),
    actions,
    h('div', { class: 'section-title' }, 'Statistics'),
    statsBox,
    infoBox,
    h('div', { class: 'section-title' }, 'Message'),
    h(
      'div',
      { class: 'row', style: 'flex-wrap: wrap; margin-bottom: 6px' },
      pauseBtn,
      rateSel,
      h('label', null, 'array items', limitIn),
      h('button', { class: 'icon', title: 'Expand all', onclick: () => tree.expandAll(true) }, '⊞'),
      h('button', { class: 'icon', title: 'Collapse all', onclick: () => tree.expandAll(false) }, '⊟'),
      h(
        'button',
        {
          class: 'icon',
          title: 'Copy as YAML',
          onclick: () => {
            if (lastMsg === undefined) return;
            ros.copy(toYaml(lastMsg));
            toast('Copied YAML', 'ok');
          },
        },
        'YAML',
      ),
      h(
        'button',
        {
          class: 'icon',
          title: 'Copy as JSON',
          onclick: () => {
            if (lastMsg === undefined) return;
            ros.copy(JSON.stringify(lastMsg, null, 2));
            toast('Copied JSON', 'ok');
          },
        },
        'JSON',
      ),
      msgMeta,
    ),
    tree.el,
  );
  renderStats(ros.stats[selected]);
  void refreshInfo();
}

function renderStats(s: TopicStats | undefined): void {
  if (!statsBox) return;
  clear(statsBox);
  const kv = (k: string, v: string, cls = '') => statsBox!.append(h('span', null, k), h('span', { class: `mono ${cls}` }, v));
  if (!s) {
    kv('Rate', 'waiting…');
    return;
  }
  kv('Rate', s.stale ? `${fmtHz(s.hz)} Hz (no recent messages)` : `${fmtHz(s.hz)} Hz`, s.stale ? 'warn' : '');
  kv('Period', s.mean !== undefined ? `mean ${fmtSec(s.mean)} · min ${fmtSec(s.min)} · max ${fmtSec(s.max)} · σ ${fmtSec(s.std)}` : '—');
  kv('Bandwidth', `${fmtBw(s.bw)} · avg msg ${fmtBytes(s.size)}`);
  if (s.delay !== undefined) kv('Delay (now − header.stamp)', `${fmtSec(s.delay)} · avg ${fmtSec(s.delayAvg)}`);
  kv('Received', `${s.count} msgs${s.age !== null ? ` · last ${fmtSec(s.age)} ago` : ''}`);
}

interface EndpointInfo {
  node: string;
  type: string;
  self: boolean;
  qos: { reliability: string; durability: string; history: string; depth: number };
}

async function refreshInfo(): Promise<void> {
  if (!selected || !infoBox) return;
  const topic = selected;
  try {
    const info = await ros.request<{ publishers: EndpointInfo[]; subscribers: EndpointInfo[] }>('topicInfo', { topic });
    if (topic !== selected || !infoBox) return;
    clear(infoBox);
    const list = (title: string, eps: EndpointInfo[]) => {
      const others = eps.filter((e) => !e.self);
      infoBox!.append(h('div', { class: 'section-title' }, `${title} (${others.length})`));
      if (!others.length) infoBox!.append(h('div', { class: 'muted' }, 'none'));
      const t = h('table', { class: 'grid' });
      for (const e of others) {
        t.append(
          h(
            'tr',
            null,
            h('td', { class: 'mono' }, e.node),
            h('td', { class: 'muted' }, [e.qos.reliability, e.qos.durability, e.qos.history !== 'unknown' ? `${e.qos.history}(${e.qos.depth})` : ''].filter(Boolean).join(' · ')),
          ),
        );
      }
      if (others.length) infoBox!.append(t);
    };
    list('Publishers', info.publishers);
    list('Subscribers', info.subscribers);
  } catch (e) {
    infoBox.textContent = `topic info failed: ${(e as Error).message}`;
  }
}

// ---- wiring ---------------------------------------------------------------
ros.on('init', (args) => {
  for (const t of ui.monitored) setMonitored(t, true);
  renderTable();
  if (typeof args.topic === 'string') select(args.topic);
});
ros.on('args', (args) => {
  if (typeof args.topic === 'string') {
    select(args.topic);
    rows.get(args.topic)?.tr.scrollIntoView({ block: 'center' });
  }
});
let graphSig = '';
ros.on('graph', (g) => {
  const sig = g.topics.map((t) => `${t.name}:${t.pubs.length}:${t.subs.length}`).join('|');
  if (sig === graphSig) return;
  graphSig = sig;
  renderTable();
  if (selected) void refreshInfo();
});
ros.on('stats', (s) => updateStats(s));
ros.start();
