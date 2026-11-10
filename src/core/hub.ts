import type {
  BackendEvent,
  BackendStatus,
  RosGraph,
  ToHost,
  ToView,
  TopicStats,
  ViewName,
} from '../../shared/protocol';
import type { RosBackend } from './backend';

/** Host capabilities a client may use (implemented by VS Code or the dev harness). */
export interface HostHooks {
  post(msg: ToView): void;
  command?(command: string, args: unknown[]): void;
  saveFile?(name: string, data: Uint8Array | string, filters?: Record<string, string[]>): void;
  openFile?(path: string, line?: number): void;
  copy?(text: string): void;
  setTitle?(title: string): void;
  setState?(state: unknown): void;
}

interface SubRecord {
  client: HubClient;
  cmd: Record<string, unknown>;
}

/**
 * Routes traffic between the backend and any number of webview clients.
 * Keeps the latest graph/stats, owns subscription bookkeeping, replays
 * subscriptions after a backend restart and cleans up when clients go away.
 */
export class Hub {
  graph: RosGraph | undefined;
  stats: Record<string, TopicStats> = {};
  readonly clients = new Set<HubClient>();
  private subs = new Map<string, SubRecord>();
  private pubOwners = new Map<string, HubClient>();
  private graphListeners = new Set<(g: RosGraph) => void>();

  constructor(readonly backend: RosBackend) {
    backend.on('event', (ev: BackendEvent, payload?: Buffer) => this.onEvent(ev, payload));
    backend.on('status', (s: BackendStatus) => this.onStatus(s));
    backend.on('ready', () => this.onReady());
  }

  get status(): BackendStatus {
    return this.backend.status;
  }

  onGraph(fn: (g: RosGraph) => void): { dispose(): void } {
    this.graphListeners.add(fn);
    return { dispose: () => this.graphListeners.delete(fn) };
  }

  createClient(view: ViewName, args: Record<string, unknown>, hooks: HostHooks): HubClient {
    const c = new HubClient(this, view, args, hooks);
    this.clients.add(c);
    return c;
  }

  /** @internal */
  _subscribe(client: HubClient, cmd: Record<string, unknown>): void {
    const subId = String(cmd.subId);
    this.subs.set(subId, { client, cmd });
    this.backend.send(cmd);
  }

  /** @internal */
  _unsubscribe(subId: string): void {
    if (this.subs.delete(subId)) this.backend.send({ op: 'unsubscribe', subId });
  }

  /** @internal */
  _updateSub(subId: string, opts: Record<string, unknown>): void {
    const rec = this.subs.get(subId);
    if (!rec) return;
    rec.cmd = { ...rec.cmd, opts: { ...((rec.cmd.opts as object) ?? {}), ...opts } };
    this.backend.send({ op: 'updateSub', subId, opts });
  }

  /** @internal */
  _trackPublisher(client: HubClient, pubId: string, active: boolean): void {
    if (active) this.pubOwners.set(pubId, client);
    else this.pubOwners.delete(pubId);
  }

  /** @internal */
  _removeClient(client: HubClient): void {
    this.clients.delete(client);
    for (const [subId, rec] of [...this.subs]) {
      if (rec.client === client) this._unsubscribe(subId);
    }
    for (const [pubId, owner] of [...this.pubOwners]) {
      if (owner === client) {
        this.pubOwners.delete(pubId);
        if (this.backend.running) this.backend.request('stopPublisher', { pubId }).catch(() => undefined);
      }
    }
  }

  private broadcast(msg: ToView): void {
    for (const c of this.clients) c.post(msg);
  }

  private onStatus(s: BackendStatus): void {
    if (s.state !== 'ready') {
      // publishers die with the backend; they are not restarted implicitly
      for (const [pubId, owner] of this.pubOwners) {
        owner.post({ type: 'event', event: { ev: 'pubStopped', pubId, reason: 'backend stopped' } });
      }
      this.pubOwners.clear();
    }
    this.broadcast({ type: 'status', status: s });
  }

  private onReady(): void {
    for (const rec of this.subs.values()) this.backend.send(rec.cmd);
    this.backend
      .request<RosGraph>('graph')
      .then((g) => g && this.setGraph(g))
      .catch(() => undefined);
  }

  private setGraph(g: RosGraph): void {
    this.graph = g;
    this.broadcast({ type: 'graph', graph: g });
    for (const fn of this.graphListeners) fn(g);
  }

  private onEvent(ev: BackendEvent, payload?: Buffer): void {
    switch (ev.ev) {
      case 'graph':
        this.setGraph(ev.graph as RosGraph);
        return;
      case 'stats':
        this.stats = ev.stats as Record<string, TopicStats>;
        this.broadcast({ type: 'stats', stats: this.stats });
        return;
      case 'log':
        return;
    }
    if (ev.subId !== undefined) {
      const rec = this.subs.get(String(ev.subId));
      if (rec) rec.client.post({ type: 'event', event: ev, payload: payload ? new Uint8Array(payload) : undefined });
      return;
    }
    if (ev.pubId !== undefined) {
      this.pubOwners.get(String(ev.pubId))?.post({ type: 'event', event: ev });
    }
  }
}

export class HubClient {
  private disposed = false;

  constructor(
    private readonly hub: Hub,
    readonly view: ViewName,
    public args: Record<string, unknown>,
    private readonly hooks: HostHooks,
  ) {}

  post(msg: ToView): void {
    if (!this.disposed) this.hooks.post(msg);
  }

  /** Send new arguments to an already open view (e.g. focus another topic). */
  setArgs(args: Record<string, unknown>): void {
    this.args = { ...this.args, ...args };
    this.post({ type: 'args', args });
  }

  handle(msg: ToHost): void {
    if (this.disposed) return;
    const hub = this.hub;
    switch (msg.type) {
      case 'ready':
        this.post({
          type: 'init',
          view: this.view,
          args: this.args,
          graph: hub.graph,
          stats: hub.stats,
          status: hub.status,
        });
        return;
      case 'request':
        this.request(msg.id, msg.op, msg.params ?? {});
        return;
      case 'subscribe':
        hub._subscribe(this, {
          op: 'subscribe',
          subId: msg.subId,
          topic: msg.topic,
          type: msg.msgType,
          mode: msg.mode,
          opts: msg.opts ?? {},
        });
        return;
      case 'unsubscribe':
        hub._unsubscribe(msg.subId);
        return;
      case 'updateSub':
        hub._updateSub(msg.subId, msg.opts);
        return;
      case 'ack':
        hub.backend.send({ op: 'ack', subId: msg.subId });
        return;
      case 'command':
        if (typeof msg.command === 'string' && msg.command.startsWith('rosVis.')) {
          this.hooks.command?.(msg.command, msg.args ?? []);
        }
        return;
      case 'setState':
        this.hooks.setState?.(msg.state);
        return;
      case 'saveFile':
        this.hooks.saveFile?.(msg.name, msg.data, msg.filters);
        return;
      case 'openFile':
        this.hooks.openFile?.(msg.path, msg.line);
        return;
      case 'copy':
        this.hooks.copy?.(msg.text);
        return;
      case 'setTitle':
        this.hooks.setTitle?.(msg.title);
        return;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hub._removeClient(this);
  }

  private request(id: number, op: string, params: Record<string, unknown>): void {
    const timeout = typeof params.timeout === 'number' ? (params.timeout as number) * 1000 + 5000 : op === 'loadUrdf' ? 70000 : 20000;
    this.hub.backend
      .requestRaw(op, params, timeout)
      .then(({ result, payload }) => {
        if (op === 'startPublisher') this.hub._trackPublisher(this, String(params.pubId), true);
        if (op === 'stopPublisher') this.hub._trackPublisher(this, String(params.pubId), false);
        this.post({ type: 'response', id, ok: true, result, payload: payload ? new Uint8Array(payload) : undefined });
      })
      .catch((e: Error) => this.post({ type: 'response', id, ok: false, error: e.message }));
  }
}
