import './common/base.css';
import { ros } from './common/ros';
import { clear, h, statusBanner, toast } from './common/ui';

interface Param {
  name: string;
  type: number;
  value: unknown;
  description: string;
  readOnly: boolean;
  constraints: string;
  dynamicTyping: boolean;
  range?: [number, number, number];
}
interface Ui {
  nodeFilter: string;
  paramFilter: string;
  showHidden: boolean;
}
const ui = ros.loadState<Ui>({ nodeFilter: '', paramFilter: '', showHidden: false });
const save = () => ros.saveState(ui);
const TYPE_NAMES = ['not set', 'bool', 'int', 'double', 'string', 'byte[]', 'bool[]', 'int[]', 'double[]', 'string[]'];

let node = '';
let params: Param[] = [];

const app = document.getElementById('app')!;
const nodeFilter = h('input', {
  type: 'search',
  placeholder: 'Filter nodes',
  value: ui.nodeFilter,
  style: 'width: 100%',
  oninput: () => {
    ui.nodeFilter = nodeFilter.value;
    save();
    renderNodes();
  },
});
const hiddenCb = h('input', {
  type: 'checkbox',
  checked: ui.showHidden,
  onchange: () => {
    ui.showHidden = hiddenCb.checked;
    save();
    renderNodes();
  },
});
const nodeList = h('div', { class: 'scroll grow' });
const paramFilter = h('input', {
  type: 'search',
  placeholder: 'Filter parameters',
  value: ui.paramFilter,
  style: 'width: 220px',
  oninput: () => {
    ui.paramFilter = paramFilter.value;
    save();
    renderParams();
  },
});
const title = h('b', { class: 'mono' });
const tableBox = h('div', { class: 'scroll grow' });
app.append(
  statusBanner(),
  h(
    'div',
    { class: 'row grow', style: 'align-items: stretch; gap: 0' },
    h('div', { class: 'col', style: 'flex: 0 0 280px; border-right: 1px solid var(--border); padding: 8px; min-height: 0' }, nodeFilter, h('label', { class: 'muted' }, hiddenCb, 'show hidden nodes'), nodeList),
    h(
      'div',
      { class: 'col grow', style: 'gap: 0' },
      h(
        'div',
        { class: 'toolbar' },
        title,
        h('span', { class: 'grow' }),
        paramFilter,
        h('button', { class: 'secondary', onclick: () => void load() }, '⟳ Refresh'),
        h('button', { class: 'secondary', title: 'Copy as ros2 param dump YAML', onclick: () => copyYaml() }, 'Copy YAML'),
      ),
      tableBox,
    ),
  ),
);

function renderNodes(): void {
  clear(nodeList);
  const f = ui.nodeFilter.toLowerCase();
  for (const n of ros.graph?.nodes ?? []) {
    if (n.self) continue;
    if (!ui.showHidden && (n.name.startsWith('_') || n.fqn.includes('/_'))) continue;
    if (f && !n.fqn.toLowerCase().includes(f)) continue;
    const row = h('div', { class: 'mono', style: 'padding: 3px 6px; cursor: pointer; font-size: 12px; border-radius: 2px', onclick: () => select(n.fqn) }, n.fqn);
    if (n.fqn === node) row.style.background = 'var(--sel)';
    nodeList.append(row);
  }
}

function select(fqn: string): void {
  node = fqn;
  ros.args.node = fqn;
  save();
  renderNodes();
  void load();
}

async function load(): Promise<void> {
  if (!node) {
    clear(tableBox);
    tableBox.append(h('div', { class: 'empty' }, 'Select a node to list its parameters.'));
    return;
  }
  title.textContent = node;
  clear(tableBox);
  tableBox.append(h('div', { class: 'empty' }, 'Loading…'));
  const target = node;
  try {
    const res = await ros.request<Param[]>('params.list', { node: target, timeout: 3 });
    if (target !== node) return;
    params = res;
    renderParams();
  } catch (e) {
    if (target !== node) return;
    clear(tableBox);
    tableBox.append(h('div', { class: 'empty err' }, `Cannot list parameters: ${(e as Error).message}`));
  }
}

function parseValue(type: number, raw: string): unknown {
  switch (type) {
    case 1:
      return raw === 'true';
    case 2:
      if (!/^-?\d+$/.test(raw.trim())) throw new Error('integer expected');
      return parseInt(raw, 10);
    case 3: {
      const v = Number(raw);
      if (!Number.isFinite(v)) throw new Error('number expected');
      return v;
    }
    case 4:
      return raw;
    default: {
      const v = JSON.parse(raw);
      if (!Array.isArray(v)) throw new Error('JSON array expected');
      return v;
    }
  }
}

async function setParam(p: Param, value: unknown, input?: HTMLElement): Promise<void> {
  try {
    const r = await ros.request<{ successful: boolean; reason: string }>('params.set', { node, name: p.name, type: p.type, value });
    if (r.successful) {
      p.value = value;
      input?.classList.remove('err');
      toast(`${p.name} = ${JSON.stringify(value)}`, 'ok', 2000);
    } else {
      toast(`Rejected: ${r.reason || 'no reason given'}`, 'error');
      void load();
    }
  } catch (e) {
    toast(`Set failed: ${(e as Error).message}`, 'error');
  }
}

function editor(p: Param): HTMLElement {
  if (p.readOnly) return h('span', { class: 'mono muted', title: 'read-only' }, `🔒 ${JSON.stringify(p.value)}`);
  if (p.type === 1) {
    const cb = h('input', { type: 'checkbox', checked: !!p.value });
    cb.addEventListener('change', () => void setParam(p, cb.checked));
    return cb;
  }
  if ((p.type === 2 || p.type === 3) && p.range && p.range[1] > p.range[0]) {
    const [lo, hi, step] = p.range;
    const st = step > 0 ? step : p.type === 2 ? 1 : (hi - lo) / 1000;
    const num = h('input', { type: 'number', min: String(lo), max: String(hi), step: String(st), value: String(p.value), style: 'width: 90px' });
    const slider = h('input', { type: 'range', min: String(lo), max: String(hi), step: String(st), value: String(p.value), style: 'width: 180px' });
    slider.addEventListener('input', () => (num.value = slider.value));
    slider.addEventListener('change', () => void setParam(p, parseValue(p.type, slider.value), num));
    num.addEventListener('change', () => {
      try {
        const v = parseValue(p.type, num.value);
        slider.value = num.value;
        void setParam(p, v, num);
      } catch (e) {
        num.classList.add('err');
        toast((e as Error).message, 'error');
      }
    });
    return h('span', { class: 'row' }, slider, num, h('span', { class: 'muted', style: 'font-size: 11px' }, `[${lo}, ${hi}]`));
  }
  const text = p.type >= 5 ? JSON.stringify(p.value) : String(p.value ?? '');
  const inp = h('input', { type: p.type === 2 || p.type === 3 ? 'number' : 'text', step: 'any', value: text, style: 'width: 100%; min-width: 160px' });
  inp.addEventListener('change', () => {
    try {
      void setParam(p, parseValue(p.type, inp.value), inp);
    } catch (e) {
      inp.style.borderColor = 'var(--err)';
      toast(`${p.name}: ${(e as Error).message}`, 'error');
    }
  });
  return inp;
}

function renderParams(): void {
  clear(tableBox);
  const f = ui.paramFilter.toLowerCase();
  const shown = params.filter((p) => !f || p.name.toLowerCase().includes(f));
  if (!params.length) {
    tableBox.append(h('div', { class: 'empty' }, 'This node has no parameters.'));
    return;
  }
  const tbody = h('tbody');
  for (const p of shown) {
    tbody.append(
      h(
        'tr',
        null,
        h('td', { class: 'mono', title: p.description || p.name }, p.name),
        h('td', { style: 'white-space: normal' }, editor(p)),
        h('td', { class: 'muted' }, TYPE_NAMES[p.type] ?? String(p.type)),
        h('td', { class: 'muted', style: 'white-space: normal; font-size: 12px' }, [p.description, p.constraints].filter(Boolean).join(' — ')),
      ),
    );
  }
  tableBox.append(h('table', { class: 'grid' }, h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Value'), h('th', null, 'Type'), h('th', null, 'Description'))), tbody));
}

function copyYaml(): void {
  if (!node || !params.length) return;
  const lines = [`${node}:`, '  ros__parameters:'];
  for (const p of params) lines.push(`    ${p.name}: ${typeof p.value === 'string' ? JSON.stringify(p.value) : JSON.stringify(p.value)}`);
  ros.copy(lines.join('\n'));
  toast('Copied parameters as YAML', 'ok');
}

ros.on('graph', () => renderNodes());
ros.on('init', (args) => {
  renderNodes();
  if (typeof args.node === 'string') select(args.node);
  else void load();
});
ros.on('args', (args) => {
  if (typeof args.node === 'string') select(args.node);
});
ros.start();
