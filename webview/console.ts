import './common/base.css';
import { ros, Subscription } from './common/ros';
import { clear, h, statusBanner, toast } from './common/ui';

interface LogEntry {
  seq: number;
  stamp: number;
  level: number;
  name: string;
  msg: string;
  file: string;
  func: string;
  line: number;
}
interface Ui {
  levels: Record<string, boolean>;
  include: string;
  exclude: string;
  node: string;
  maxRows: number;
  autoScroll: boolean;
}
const LEVELS: [number, string, string][] = [
  [10, 'DEBUG', 'debug'],
  [20, 'INFO', 'info'],
  [30, 'WARN', 'warn'],
  [40, 'ERROR', 'err'],
  [50, 'FATAL', 'err'],
];
const ui = ros.loadState<Ui>({ levels: { DEBUG: true, INFO: true, WARN: true, ERROR: true, FATAL: true }, include: '', exclude: '', node: '', maxRows: 5000, autoScroll: true });
const save = () => ros.saveState(ui);

const entries: LogEntry[] = [];
const counts = new Map<number, number>();
const nodes = new Set<string>();
let seq = 0;
let paused = false;
let pending: LogEntry[] = [];
let sub: Subscription | undefined;
let selectedSeq = -1;

function levelInfo(l: number): [number, string, string] {
  return LEVELS.find(([v]) => v === l) ?? [l, String(l), 'debug'];
}

// ---- layout ---------------------------------------------------------------
const app = document.getElementById('app')!;
const levelBtns = new Map<string, HTMLButtonElement>();
for (const [, name, cls] of LEVELS) {
  const b = h(
    'button',
    {
      class: 'secondary',
      title: `Toggle ${name}`,
      onclick: () => {
        ui.levels[name] = !ui.levels[name];
        save();
        styleLevelBtn(name);
        rebuild();
      },
    },
    h('span', { class: `badge ${cls}` }, name[0]),
    h('span', { class: 'mono', style: 'margin-left: 4px' }, '0'),
  );
  levelBtns.set(name, b);
}
function styleLevelBtn(name: string): void {
  levelBtns.get(name)!.style.opacity = ui.levels[name] ? '1' : '0.4';
}
const nodeSel = h('select', {
  onchange: () => {
    ui.node = nodeSel.value;
    save();
    rebuild();
  },
});
const incIn = h('input', { type: 'search', placeholder: 'include (text or /regex/)', value: ui.include, style: 'width: 180px' });
const excIn = h('input', { type: 'search', placeholder: 'exclude', value: ui.exclude, style: 'width: 120px' });
for (const el of [incIn, excIn])
  el.addEventListener('input', () => {
    ui.include = incIn.value;
    ui.exclude = excIn.value;
    save();
    rebuild();
  });
const pauseBtn = h(
  'button',
  {
    class: 'secondary',
    onclick: () => {
      paused = !paused;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      if (!paused) flush();
    },
  },
  'Pause',
);
const maxSel = h(
  'select',
  {
    title: 'Rows kept in memory',
    onchange: () => {
      ui.maxRows = Number(maxSel.value);
      save();
      enforceMax();
      rebuild();
    },
  },
  ...[1000, 5000, 20000, 100000].map((n) => h('option', { value: String(n), selected: n === ui.maxRows }, `${n / 1000}k rows`)),
);
const scrollCb = h('input', {
  type: 'checkbox',
  checked: ui.autoScroll,
  onchange: () => {
    ui.autoScroll = scrollCb.checked;
    save();
  },
});
const shownLabel = h('span', { class: 'muted' });
const tbody = h('tbody');
const table = h(
  'table',
  { class: 'grid' },
  h('thead', null, h('tr', null, h('th', { class: 'num' }, '#'), h('th', null, 'Time'), h('th', null, 'Level'), h('th', null, 'Node'), h('th', null, 'Message'), h('th', null, 'Location'))),
  tbody,
);
const tableBox = h('div', { class: 'scroll grow' }, table);
const detailBox = h('div', { class: 'scroll', style: 'flex: 0 0 auto; max-height: 30%; border-top: 1px solid var(--border); padding: 6px 10px; display: none' });

app.append(
  statusBanner(),
  h(
    'div',
    { class: 'toolbar' },
    ...levelBtns.values(),
    h('span', { class: 'sep' }),
    nodeSel,
    incIn,
    excIn,
    h('span', { class: 'sep' }),
    pauseBtn,
    h(
      'button',
      {
        class: 'secondary',
        onclick: () => {
          entries.length = 0;
          counts.clear();
          rebuild();
          updateCounts();
        },
      },
      'Clear',
    ),
    h('button', { class: 'secondary', title: 'Copy filtered rows', onclick: () => copyShown() }, 'Copy'),
    maxSel,
    h('label', null, scrollCb, 'auto-scroll'),
    h('span', { class: 'grow' }),
    shownLabel,
  ),
  tableBox,
  detailBox,
);
for (const [, name] of LEVELS) styleLevelBtn(name);

// ---- filtering / rendering ------------------------------------------------
function textMatcher(s: string): ((x: string) => boolean) | undefined {
  s = s.trim();
  if (!s) return undefined;
  if (s.length > 2 && s.startsWith('/') && s.endsWith('/')) {
    try {
      const re = new RegExp(s.slice(1, -1), 'i');
      return (x) => re.test(x);
    } catch {
      /* fall through */
    }
  }
  const l = s.toLowerCase();
  return (x) => x.toLowerCase().includes(l);
}

function makeFilter(): (e: LogEntry) => boolean {
  const inc = textMatcher(ui.include);
  const exc = textMatcher(ui.exclude);
  return (e) => {
    if (!ui.levels[levelInfo(e.level)[1]]) return false;
    if (ui.node && e.name !== ui.node) return false;
    const text = `${e.name} ${e.msg}`;
    if (inc && !inc(text)) return false;
    if (exc && exc(text)) return false;
    return true;
  };
}

function fmtTime(t: number): string {
  const d = new Date(t * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function row(e: LogEntry): HTMLTableRowElement {
  const [, name, cls] = levelInfo(e.level);
  const tr = h(
    'tr',
    { onclick: () => showDetail(e, tr), ondblclick: () => e.file && ros.post({ type: 'openFile', path: e.file, line: e.line }) },
    h('td', { class: 'num muted' }, String(e.seq)),
    h('td', { class: 'mono' }, fmtTime(e.stamp)),
    h('td', null, h('span', { class: `badge ${cls}` }, name)),
    h('td', { class: 'mono' }, e.name),
    h('td', { class: `mono ${cls === 'err' ? 'err' : cls === 'warn' ? 'warn' : ''}`, style: 'white-space: pre; max-width: 60vw; overflow: hidden; text-overflow: ellipsis' }, e.msg),
    h('td', { class: 'muted mono', style: 'font-size: 11px' }, e.file ? `${e.file.split('/').pop()}:${e.line}` : ''),
  );
  if (e.seq === selectedSeq) tr.classList.add('selected');
  return tr;
}

function showDetail(e: LogEntry, tr: HTMLTableRowElement): void {
  tbody.querySelector('tr.selected')?.classList.remove('selected');
  tr.classList.add('selected');
  selectedSeq = e.seq;
  detailBox.style.display = '';
  clear(detailBox);
  detailBox.append(
    h('div', { class: 'kv' }, h('span', null, 'node'), h('span', { class: 'mono' }, e.name), h('span', null, 'level'), h('span', null, levelInfo(e.level)[1]), h('span', null, 'time'), h('span', { class: 'mono' }, `${fmtTime(e.stamp)} (${e.stamp.toFixed(6)})`), h('span', null, 'location'), h('span', { class: 'mono' }, e.file ? `${e.file}:${e.line} in ${e.func}()` : '—')),
    h('pre', { class: 'mono', style: 'white-space: pre-wrap; margin: 6px 0' }, e.msg),
    e.file ? h('button', { class: 'secondary', onclick: () => ros.post({ type: 'openFile', path: e.file, line: e.line }) }, 'Open source location') : '',
  );
}

function rebuild(): void {
  const f = makeFilter();
  clear(tbody);
  const frag = document.createDocumentFragment();
  let shown = 0;
  for (const e of entries) {
    if (!f(e)) continue;
    frag.append(row(e));
    shown++;
  }
  tbody.append(frag);
  shownLabel.textContent = `${shown} / ${entries.length} messages`;
  if (ui.autoScroll) tableBox.scrollTop = tableBox.scrollHeight;
}

function enforceMax(): void {
  const extra = entries.length - ui.maxRows;
  if (extra > 0) entries.splice(0, extra);
}

function flush(): void {
  if (!pending.length || paused) return;
  const batch = pending;
  pending = [];
  const f = makeFilter();
  const frag = document.createDocumentFragment();
  let added = 0;
  for (const e of batch) {
    entries.push(e);
    if (f(e)) {
      frag.append(row(e));
      added++;
    }
  }
  const before = entries.length;
  enforceMax();
  const removed = before - entries.length;
  if (removed > 0) {
    // drop rows that left the buffer
    const minSeq = entries[0]?.seq ?? 0;
    while (tbody.firstChild && Number((tbody.firstChild as HTMLElement).firstChild?.textContent) < minSeq) tbody.removeChild(tbody.firstChild);
  }
  if (added) tbody.append(frag);
  shownLabel.textContent = `${tbody.childElementCount} / ${entries.length} messages`;
  updateCounts();
  if (ui.autoScroll && added) tableBox.scrollTop = tableBox.scrollHeight;
}

function updateCounts(): void {
  for (const [lvl, name] of LEVELS) {
    const b = levelBtns.get(name)!;
    (b.lastChild as HTMLElement).textContent = String(counts.get(lvl) ?? 0);
  }
}

function updateNodes(): void {
  const sig = [...nodes].sort().join('|');
  if (nodeSel.dataset.sig === sig) return;
  nodeSel.dataset.sig = sig;
  clear(nodeSel);
  nodeSel.append(h('option', { value: '' }, 'all nodes'));
  for (const n of [...nodes].sort()) nodeSel.append(h('option', { value: n, selected: n === ui.node }, n));
}

function copyShown(): void {
  const f = makeFilter();
  const text = entries
    .filter(f)
    .map((e) => `[${levelInfo(e.level)[1]}] [${e.stamp.toFixed(6)}] [${e.name}]: ${e.msg}`)
    .join('\n');
  ros.copy(text);
  toast('Copied log lines', 'ok');
}

setInterval(flush, 100);

ros.on('init', () => {
  updateNodes();
  if (ui.node) nodes.add(ui.node);
  sub = ros.subscribe(
    '/rosout',
    'json',
    { maxRate: 0, arrayLimit: 16 },
    (ev) => {
      if (ev.ev === 'subError') {
        toast(`/rosout: ${ev.error}`, 'error');
        return;
      }
      if (ev.ev !== 'msg') return;
      const m = ev.msg as { stamp: { sec: number; nanosec: number }; level: number; name: string; msg: string; file: string; function: string; line: number };
      const e: LogEntry = {
        seq: ++seq,
        stamp: m.stamp.sec + m.stamp.nanosec * 1e-9,
        level: m.level,
        name: m.name,
        msg: m.msg,
        file: m.file,
        func: m.function,
        line: m.line,
      };
      counts.set(e.level, (counts.get(e.level) ?? 0) + 1);
      if (!nodes.has(e.name)) {
        nodes.add(e.name);
        updateNodes();
      }
      pending.push(e);
    },
    'rcl_interfaces/msg/Log',
  );
});
window.addEventListener('beforeunload', () => sub?.close());
ros.start();
