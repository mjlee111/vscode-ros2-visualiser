// Types shared by the extension host, the dev harness and the webviews.

export type NamesAndTypes = [string, string[]][];

export interface GraphNode {
  name: string;
  ns: string;
  fqn: string;
  self: boolean;
  /** Number of graph nodes sharing this exact fully qualified name (> 1 = duplicates). */
  count?: number;
  pubs: NamesAndTypes;
  subs: NamesAndTypes;
  srvs: NamesAndTypes;
  clients: NamesAndTypes;
  actionServers: NamesAndTypes;
  actionClients: NamesAndTypes;
}

export interface GraphTopic {
  name: string;
  types: string[];
  pubs: string[];
  subs: string[];
}

export interface GraphEntity {
  name: string;
  types: string[];
}

export interface RosGraph {
  nodes: GraphNode[];
  topics: GraphTopic[];
  services: GraphEntity[];
  actions: GraphEntity[];
  self: string;
}

export interface TopicStats {
  count: number;
  hz: number;
  bw: number;
  size: number;
  age: number | null;
  min?: number;
  max?: number;
  std?: number;
  mean?: number;
  stale?: boolean;
  delay?: number;
  delayAvg?: number;
}

export interface BackendInfo {
  distro: string;
  rmw: string;
  domainId: number;
  node: string;
  pid: number;
  python: string;
  opencv: string | null;
}

export interface BackendStatus {
  state: 'starting' | 'ready' | 'error' | 'stopped';
  info?: BackendInfo;
  error?: string;
}

export type ViewName =
  | 'graph'
  | 'topics'
  | 'image'
  | 'pointcloud'
  | 'plot'
  | 'service'
  | 'publisher'
  | 'params'
  | 'console'
  | 'tf'
  | 'urdf';

export type SubMode = 'stats' | 'json' | 'plot' | 'image' | 'cloud' | 'tf';

/** Messages sent from a webview to the host. */
export type ToHost =
  | { type: 'ready' }
  | { type: 'request'; id: number; op: string; params?: Record<string, unknown> }
  | { type: 'subscribe'; subId: string; topic: string; msgType?: string; mode: SubMode; opts?: Record<string, unknown> }
  | { type: 'unsubscribe'; subId: string }
  | { type: 'updateSub'; subId: string; opts: Record<string, unknown> }
  | { type: 'ack'; subId: string }
  | { type: 'command'; command: string; args?: unknown[] }
  | { type: 'setState'; state: unknown }
  | { type: 'saveFile'; name: string; data: Uint8Array | string; filters?: Record<string, string[]> }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'copy'; text: string }
  | { type: 'setTitle'; title: string };

/** Backend event forwarded to a webview. */
export interface BackendEvent {
  ev: string;
  subId?: string;
  pubId?: string;
  [k: string]: unknown;
}

/** Messages sent from the host to a webview. */
export type ToView =
  | { type: 'init'; view: ViewName; args: Record<string, unknown>; graph?: RosGraph; stats: Record<string, TopicStats>; status: BackendStatus }
  | { type: 'graph'; graph: RosGraph }
  | { type: 'stats'; stats: Record<string, TopicStats> }
  | { type: 'status'; status: BackendStatus }
  | { type: 'response'; id: number; ok: boolean; result?: unknown; error?: string; payload?: Uint8Array }
  | { type: 'event'; event: BackendEvent; payload?: Uint8Array }
  | { type: 'args'; args: Record<string, unknown> };
