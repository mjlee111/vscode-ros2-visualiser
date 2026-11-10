import './common/base.css';
import { newId, ros } from './common/ros';
import { clear, h, statusBanner, toast } from './common/ui';

interface PubDef {
  id: string;
  topic: string;
  type: string;
  rate: number;
  msg: string;
  autoStamp: boolean;
  reliability: 'reliable' | 'best_effort';
  durability: 'volatile' | 'transient_local';
}
interface Ui {
  pubs: PubDef[];
}
const ui = ros.loadState<Ui>({ pubs: [] });
const save = () => ros.saveState(ui);

interface Card {
  def: PubDef;
  el: HTMLElement;
  state: 'stopped' | 'running' | 'open';
  count: HTMLElement;
  startBtn: HTMLButtonElement;
  editor: HTMLTextAreaElement;
  setState(s: Card['state']): void;
}
const cards = new Map<string, Card>();
let msgTypes: string[] = [];

// ---- layout ---------------------------------------------------------------
const app = document.getElementById('app')!;
const topicIn = h('input', { list: 'pub-topics', placeholder: '/topic', style: 'width: 220px' });
const topicsDl = h('datalist', { id: 'pub-topics' });
const typeIn = h('input', { list: 'pub-types', placeholder: 'pkg/msg/Type', style: 'width: 260px' });
const typesDl = h('datalist', { id: 'pub-types' });
const rateIn = h('input', { type: 'number', min: '0', step: 'any', value: '1', title: 'Hz (0 = only "Send once")', style: 'width: 64px' });
topicIn.addEventListener('change', () => {
  const t = ros.topicTypes(topicIn.value.trim())[0];
  if (t) typeIn.value = t;
});
const warn = h('div', { class: 'status-banner', style: 'background: var(--vscode-inputValidation-warningBackground, #352a05)' });
const list = h('div', { class: 'scroll grow', style: 'padding: 8px' });

app.append(
  statusBanner(),
  warn,
  h(
    'div',
    { class: 'toolbar' },
    topicIn,
    topicsDl,
    typeIn,
    typesDl,
    h('label', null, 'rate', rateIn, 'Hz'),
    h('button', { onclick: () => void addFromInputs() }, '+ Add publisher'),
    h('span', { class: 'grow' }),
    h('button', { class: 'danger', title: 'Stop every publisher of this panel', onclick: () => stopAll() }, '■ Stop all'),
  ),
  list,
);

function renderWarn(): void {
  const info = ros.status.info;
  warn.textContent = info
    ? `⚠ Messages are published on ROS_DOMAIN_ID=${info.domainId} (${info.rmw}) and reach every node on that domain, including real hardware. Publishers stop when this panel closes.`
    : '⚠ Messages reach every node on the current ROS domain.';
}

async function addFromInputs(): Promise<void> {
  const topic = topicIn.value.trim();
  const type = typeIn.value.trim();
  if (!topic.startsWith('/') || !type) {
    toast('Enter an absolute topic name and a message type', 'error');
    return;
  }
  await addPub({ topic, type, rate: Math.max(0, Number(rateIn.value) || 0) });
}

async function addPub(p: Partial<PubDef> & { topic: string; type: string }): Promise<void> {
  let msg = p.msg;
  if (!msg) {
    try {
      const info = await ros.request<{ default: unknown }>('interface', { type: p.type });
      msg = JSON.stringify(info.default, null, 2);
    } catch (e) {
      toast(`Unknown type ${p.type}: ${(e as Error).message}`, 'error');
      return;
    }
  }
  const def: PubDef = {
    id: p.id ?? newId('pub'),
    topic: p.topic,
    type: p.type,
    rate: p.rate ?? 1,
    msg,
    autoStamp: p.autoStamp ?? /"header"/.test(msg),
    reliability: p.reliability ?? 'reliable',
    durability: p.durability ?? 'volatile',
  };
  if (!ui.pubs.some((x) => x.id === def.id)) ui.pubs.push(def);
  save();
  renderCard(def);
}

function parseMsg(card: Card): unknown | undefined {
  try {
    return JSON.parse(card.editor.value || '{}');
  } catch (e) {
    toast(`${card.def.topic}: invalid JSON (${(e as Error).message})`, 'error');
    return undefined;
  }
}

function startParams(card: Card, rate: number): Record<string, unknown> | undefined {
  const msg = parseMsg(card);
  if (msg === undefined) return undefined;
  const d = card.def;
  return { pubId: d.id, topic: d.topic, type: d.type, msg, rate, autoStamp: d.autoStamp, qos: { reliability: d.reliability, durability: d.durability, depth: 10 } };
}

async function start(card: Card): Promise<void> {
  if (!(card.def.rate > 0)) {
    toast('Set a rate > 0 to publish periodically, or use "Send once"', 'error');
    return;
  }
  const params = startParams(card, card.def.rate);
  if (!params) return;
  try {
    await ros.request('startPublisher', params);
    card.setState('running');
  } catch (e) {
    toast(`Start failed: ${(e as Error).message}`, 'error');
  }
}

async function stop(card: Card): Promise<void> {
  try {
    await ros.request('stopPublisher', { pubId: card.def.id });
  } catch {
    /* already gone */
  }
  card.setState('stopped');
}

async function sendOnce(card: Card): Promise<void> {
  try {
    if (card.state === 'stopped') {
      const params = startParams(card, 0);
      if (!params) return;
      await ros.request('startPublisher', params);
      card.setState('open');
    } else {
      const msg = parseMsg(card);
      if (msg === undefined) return;
      await ros.request('updatePublisher', { pubId: card.def.id, msg, autoStamp: card.def.autoStamp });
      await ros.request('publishOnce', { pubId: card.def.id });
    }
  } catch (e) {
    toast(`Publish failed: ${(e as Error).message}`, 'error');
  }
}

async function apply(card: Card): Promise<void> {
  const msg = parseMsg(card);
  if (msg === undefined) return;
  if (card.state === 'stopped') {
    toast('Saved. Start the publisher to send it.');
    return;
  }
  try {
    await ros.request('updatePublisher', { pubId: card.def.id, msg, autoStamp: card.def.autoStamp });
    toast('Message updated', 'ok');
  } catch (e) {
    toast(`Update failed: ${(e as Error).message}`, 'error');
  }
}

function stopAll(): void {
  for (const c of cards.values()) if (c.state !== 'stopped') void stop(c);
}

function renderCard(def: PubDef): void {
  cards.get(def.id)?.el.remove();
  const count = h('span', { class: 'muted mono' }, '0 sent');
  const stateBadge = h('span', { class: 'badge' }, 'stopped');
  const editor = h('textarea', { rows: Math.min(16, def.msg.split('\n').length + 1), style: 'width: 100%', spellcheck: false });
  editor.value = def.msg;
  const card: Card = {
    def,
    el: h('div'),
    state: 'stopped',
    count,
    editor,
    startBtn: h('button', { onclick: () => void (card.state === 'running' ? stop(card) : start(card)) }, '▶ Start'),
    setState(s) {
      card.state = s;
      stateBadge.textContent = s === 'running' ? `publishing ${def.rate} Hz` : s === 'open' ? 'advertised' : 'stopped';
      stateBadge.className = `badge ${s === 'running' ? 'ok' : s === 'open' ? 'info' : ''}`;
      card.startBtn.textContent = s === 'running' ? '■ Stop' : '▶ Start';
      card.startBtn.className = s === 'running' ? 'danger' : '';
      stopBtn.classList.toggle('hidden', s !== 'open');
    },
  };
  const stopBtn = h('button', { class: 'secondary hidden', title: 'Remove the advertised publisher', onclick: () => void stop(card) }, '■ Close');
  editor.addEventListener('input', () => {
    def.msg = editor.value;
    save();
  });
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void apply(card);
    }
  });
  const rate = h('input', { type: 'number', min: '0', step: 'any', value: String(def.rate), style: 'width: 64px' });
  rate.addEventListener('change', () => {
    def.rate = Math.max(0, Number(rate.value) || 0);
    save();
    if (card.state === 'running') void start(card);
  });
  const stampCb = h('input', {
    type: 'checkbox',
    checked: def.autoStamp,
    onchange: () => {
      def.autoStamp = stampCb.checked;
      save();
    },
  });
  const relSel = h(
    'select',
    {
      onchange: () => {
        def.reliability = relSel.value as PubDef['reliability'];
        save();
      },
    },
    h('option', { value: 'reliable', selected: def.reliability === 'reliable' }, 'reliable'),
    h('option', { value: 'best_effort', selected: def.reliability === 'best_effort' }, 'best effort'),
  );
  const durSel = h(
    'select',
    {
      onchange: () => {
        def.durability = durSel.value as PubDef['durability'];
        save();
      },
    },
    h('option', { value: 'volatile', selected: def.durability === 'volatile' }, 'volatile'),
    h('option', { value: 'transient_local', selected: def.durability === 'transient_local' }, 'transient local'),
  );
  card.el = h(
    'div',
    { style: 'border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; margin-bottom: 10px; background: var(--bg2)' },
    h(
      'div',
      { class: 'row', style: 'flex-wrap: wrap' },
      h('b', { class: 'mono' }, def.topic),
      h('span', { class: 'badge' }, def.type),
      stateBadge,
      count,
      h('span', { class: 'grow' }),
      h(
        'button',
        {
          class: 'icon',
          title: 'Remove',
          onclick: () => {
            if (card.state !== 'stopped') void stop(card);
            card.el.remove();
            cards.delete(def.id);
            ui.pubs = ui.pubs.filter((x) => x.id !== def.id);
            save();
          },
        },
        '✕',
      ),
    ),
    h(
      'div',
      { class: 'row', style: 'flex-wrap: wrap; margin: 6px 0' },
      card.startBtn,
      h('label', null, rate, 'Hz'),
      h('button', { class: 'secondary', onclick: () => void sendOnce(card) }, 'Send once'),
      stopBtn,
      h('button', { class: 'secondary', title: 'Apply edited message to the running publisher (Ctrl+Enter)', onclick: () => void apply(card) }, 'Apply'),
      h('label', { title: 'Set header.stamp to now on every publish' }, stampCb, 'stamp header'),
      relSel,
      durSel,
    ),
    editor,
  );
  cards.set(def.id, card);
  list.append(card.el);
}

ros.on('pub', (ev) => {
  const card = cards.get(String(ev.pubId));
  if (!card) return;
  if (ev.ev === 'pubStatus') card.count.textContent = `${ev.count} sent`;
  if (ev.ev === 'pubStopped') {
    card.setState('stopped');
    toast(`${card.def.topic}: stopped (${ev.reason})`, 'error');
  }
});
ros.on('graph', (g) => {
  clear(topicsDl);
  for (const t of g.topics) topicsDl.append(h('option', { value: t.name }, t.types[0]));
});
ros.on('status', (s) => {
  renderWarn();
  if (s.state === 'ready' && !msgTypes.length) {
    void ros.request<{ msgs: string[] }>('listInterfaces').then((r) => {
      msgTypes = r.msgs;
      clear(typesDl);
      for (const t of msgTypes) typesDl.append(h('option', { value: t }));
    });
  }
});
ros.on('init', (args) => {
  renderWarn();
  for (const d of ui.pubs) renderCard(d);
  if (!ui.pubs.length) list.append(h('div', { class: 'empty', id: 'pub-empty' }, 'Add a publisher above. Message contents are edited as JSON (same structure as `ros2 topic pub`).'));
  if (typeof args.topic === 'string') {
    topicIn.value = args.topic;
    typeIn.value = (args.type as string) ?? ros.topicTypes(args.topic)[0] ?? '';
  }
});
ros.on('args', (args) => {
  if (typeof args.topic === 'string') {
    topicIn.value = args.topic;
    typeIn.value = (args.type as string) ?? ros.topicTypes(args.topic)[0] ?? '';
  }
});
const obs = new MutationObserver(() => {
  if (cards.size) document.getElementById('pub-empty')?.remove();
});
obs.observe(list, { childList: true });
ros.start();
