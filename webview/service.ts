import './common/base.css';
import type { GraphEntity } from '../shared/protocol';
import { MsgTree, toYaml } from './common/msgtree';
import { ros } from './common/ros';
import { clear, fmtSec, fmtStamp, h, statusBanner, toast } from './common/ui';

interface Ui {
  filter: string;
  showParamSrv: boolean;
  timeout: number;
  requests: Record<string, string>;
}
const ui = ros.loadState<Ui>({ filter: '', showParamSrv: false, timeout: 5, requests: {} });
const save = () => ros.saveState(ui);

interface HistoryEntry {
  t: number;
  service: string;
  type: string;
  request: string;
  ok: boolean;
  elapsed?: number;
  response?: unknown;
  error?: string;
}
const history: HistoryEntry[] = [];
let selected: GraphEntity | undefined;

const PARAM_SRV = /\/(describe_parameters|get_parameter_types|get_parameters|list_parameters|set_parameters|set_parameters_atomically|get_type_description)$/;

// ---- layout ---------------------------------------------------------------
const app = document.getElementById('app')!;
const filterIn = h('input', {
  type: 'search',
  placeholder: 'Filter services',
  value: ui.filter,
  style: 'width: 100%',
  oninput: () => {
    ui.filter = filterIn.value;
    save();
    renderList();
  },
});
const paramCb = h('input', {
  type: 'checkbox',
  checked: ui.showParamSrv,
  onchange: () => {
    ui.showParamSrv = paramCb.checked;
    save();
    renderList();
  },
});
const list = h('div', { class: 'scroll grow' });
const left = h(
  'div',
  { class: 'col', style: 'flex: 0 0 320px; border-right: 1px solid var(--border); padding: 8px; min-height: 0' },
  filterIn,
  h('label', { class: 'muted' }, paramCb, 'show parameter services'),
  list,
);
const right = h('div', { class: 'scroll grow', style: 'padding: 8px 14px' });
app.append(statusBanner(), h('div', { class: 'row grow', style: 'align-items: stretch; gap: 0' }, left, right));

function renderList(): void {
  clear(list);
  const f = ui.filter.toLowerCase();
  const items = (ros.graph?.services ?? []).filter(
    (s) => (ui.showParamSrv || !PARAM_SRV.test(s.name)) && (!f || s.name.toLowerCase().includes(f) || s.types.join().toLowerCase().includes(f)),
  );
  if (!items.length) list.append(h('div', { class: 'muted', style: 'padding: 8px' }, 'No services'));
  for (const s of items) {
    const row = h(
      'div',
      {
        style: 'padding: 3px 6px; cursor: pointer; border-radius: 2px',
        class: selected?.name === s.name ? 'sel-row' : '',
        onclick: () => select(s.name, s.types[0]),
      },
      h('div', { class: 'mono', style: 'font-size: 12px' }, s.name),
      h('div', { class: 'muted', style: 'font-size: 11px' }, s.types.join(', ')),
    );
    if (selected?.name === s.name) row.style.background = 'var(--sel)';
    list.append(row);
  }
}

// ---- detail ---------------------------------------------------------------
async function select(name: string, type?: string): Promise<void> {
  type = type ?? ros.graph?.services.find((s) => s.name === name)?.types[0];
  selected = { name, types: type ? [type] : [] };
  ros.args.service = name;
  ros.args.type = type;
  save();
  renderList();
  clear(right);
  right.append(h('h3', { class: 'mono', style: 'margin: 4px 0' }, name), h('span', { class: 'badge' }, type ?? 'unknown type'));
  if (!type) {
    right.append(h('div', { class: 'err' }, 'Service type unknown (service not available?)'));
    return;
  }
  let info: { definition: string; request: unknown; path?: string };
  try {
    info = await ros.request('interface', { type });
  } catch (e) {
    right.append(h('div', { class: 'err' }, `Cannot load ${type}: ${(e as Error).message}`));
    return;
  }
  if (selected?.name !== name) return;
  const key = `${name}|${type}`;
  const defaultReq = JSON.stringify(info.request, null, 2);
  const editor = h('textarea', { rows: Math.min(18, Math.max(4, defaultReq.split('\n').length + 1)), style: 'width: 100%', spellcheck: false });
  editor.value = ui.requests[key] ?? defaultReq;
  editor.addEventListener('input', () => {
    ui.requests[key] = editor.value;
    save();
  });
  const timeoutIn = h('input', { type: 'number', min: '0.1', step: '0.5', value: String(ui.timeout), style: 'width: 64px' });
  timeoutIn.addEventListener('change', () => {
    ui.timeout = Math.max(0.1, Number(timeoutIn.value) || 5);
    save();
  });
  const callBtn = h('button', { onclick: () => void call() }, '▶ Call');
  const result = h('div');
  const tree = new MsgTree({ autoExpandDepth: 4 });
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void call();
    }
  });

  async function call(): Promise<void> {
    let req: unknown;
    try {
      req = JSON.parse(editor.value || '{}');
    } catch (e) {
      toast(`Request is not valid JSON: ${(e as Error).message}`, 'error');
      return;
    }
    callBtn.disabled = true;
    callBtn.textContent = 'Calling…';
    clear(result);
    const entry: HistoryEntry = { t: Date.now() / 1000, service: name, type: type!, request: editor.value, ok: false };
    try {
      const res = await ros.request<{ response: unknown; elapsed: number }>('callService', { service: name, type, request: req, timeout: ui.timeout });
      entry.ok = true;
      entry.elapsed = res.elapsed;
      entry.response = res.response;
      showResponse(entry);
    } catch (e) {
      entry.error = (e as Error).message;
      showResponse(entry);
    } finally {
      callBtn.disabled = false;
      callBtn.textContent = '▶ Call';
      history.unshift(entry);
      history.splice(30);
      renderHistory();
    }
  }

  function showResponse(e: HistoryEntry): void {
    clear(result);
    if (!e.ok) {
      result.append(h('div', { class: 'err mono', style: 'white-space: pre-wrap' }, `✗ ${e.error}`));
      return;
    }
    tree.set(e.response);
    result.append(
      h(
        'div',
        { class: 'row', style: 'margin-bottom: 4px' },
        h('span', { class: 'ok' }, `✓ ${fmtSec(e.elapsed)}`),
        h('button', { class: 'icon', onclick: () => (ros.copy(toYaml(e.response)), toast('Copied YAML', 'ok')) }, 'YAML'),
        h('button', { class: 'icon', onclick: () => (ros.copy(JSON.stringify(e.response, null, 2)), toast('Copied JSON', 'ok')) }, 'JSON'),
      ),
      tree.el,
    );
  }

  const histBox = h('div');
  function renderHistory(): void {
    clear(histBox);
    const mine = history.filter((x) => x.service === name);
    if (!mine.length) return;
    histBox.append(h('div', { class: 'section-title' }, 'History'));
    const t = h('table', { class: 'grid' });
    for (const e of mine) {
      t.append(
        h(
          'tr',
          {
            style: 'cursor: pointer',
            title: 'Click to restore request and response',
            onclick: () => {
              editor.value = e.request;
              showResponse(e);
            },
          },
          h('td', { class: 'mono' }, fmtStamp(e.t)),
          h('td', { class: e.ok ? 'ok' : 'err' }, e.ok ? 'ok' : 'error'),
          h('td', { class: 'num' }, e.elapsed !== undefined ? fmtSec(e.elapsed) : ''),
          h('td', { class: 'mono muted', style: 'max-width: 420px; overflow: hidden; text-overflow: ellipsis' }, e.request.replace(/\s+/g, ' ')),
        ),
      );
    }
    histBox.append(t);
  }

  right.append(
    h('details', null, h('summary', { class: 'muted', style: 'cursor: pointer; margin-top: 6px' }, 'Definition'), h('pre', { class: 'mono', style: 'white-space: pre-wrap' }, info.definition)),
    h('div', { class: 'section-title' }, 'Request (JSON)'),
    editor,
    h(
      'div',
      { class: 'row', style: 'margin: 6px 0' },
      callBtn,
      h('label', null, 'timeout', timeoutIn, 's'),
      h(
        'button',
        {
          class: 'secondary',
          onclick: () => {
            editor.value = defaultReq;
            delete ui.requests[key];
            save();
          },
        },
        'Reset',
      ),
      h('span', { class: 'muted' }, 'Ctrl+Enter to call'),
    ),
    h('div', { class: 'section-title' }, 'Response'),
    result,
    histBox,
  );
  renderHistory();
}

ros.on('graph', () => renderList());
ros.on('init', (args) => {
  renderList();
  if (typeof args.service === 'string') void select(args.service, args.type as string | undefined);
  else right.append(h('div', { class: 'empty' }, 'Select a service on the left.'));
});
ros.on('args', (args) => {
  if (typeof args.service === 'string') void select(args.service, args.type as string | undefined);
});
ros.start();
