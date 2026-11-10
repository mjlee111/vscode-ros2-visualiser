import * as vscode from 'vscode';
import type { GraphNode, RosGraph } from '../../shared/protocol';
import type { Hub } from '../core/hub';

export const IMAGE_TYPES = ['sensor_msgs/msg/Image', 'sensor_msgs/msg/CompressedImage', 'nav_msgs/msg/OccupancyGrid'];
export const CLOUD_TYPES = ['sensor_msgs/msg/PointCloud2', 'sensor_msgs/msg/LaserScan'];

type Section = 'nodes' | 'topics' | 'services' | 'actions';
type Group = 'pubs' | 'subs' | 'srvs' | 'clients' | 'actionServers' | 'actionClients';

export type ExplorerItem =
  | { kind: 'section'; section: Section }
  | { kind: 'node'; node: GraphNode }
  | { kind: 'group'; node: GraphNode; group: Group }
  | { kind: 'topic'; name: string; types: string[]; parent?: string }
  | { kind: 'service'; name: string; types: string[]; parent?: string }
  | { kind: 'action'; name: string; types: string[]; parent?: string }
  | { kind: 'message'; text: string };

const GROUP_LABEL: Record<Group, string> = {
  pubs: 'Publishers',
  subs: 'Subscribers',
  srvs: 'Services',
  clients: 'Service Clients',
  actionServers: 'Action Servers',
  actionClients: 'Action Clients',
};

const GROUP_KIND: Record<Group, 'topic' | 'service' | 'action'> = {
  pubs: 'topic',
  subs: 'topic',
  srvs: 'service',
  clients: 'service',
  actionServers: 'action',
  actionClients: 'action',
};

function topicContext(types: string[]): string {
  let ctx = 'named typed topic';
  if (types.some((t) => IMAGE_TYPES.includes(t))) ctx += ' image';
  if (types.some((t) => CLOUD_TYPES.includes(t))) ctx += ' cloud';
  return ctx;
}

function shortType(types: string[]): string {
  return types.map((t) => t.replace('/msg/', '/').replace('/srv/', '/').replace('/action/', '/')).join(', ');
}

export class ExplorerProvider implements vscode.TreeDataProvider<ExplorerItem> {
  private readonly emitter = new vscode.EventEmitter<ExplorerItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly hub: Hub) {
    hub.onGraph(() => this.emitter.fire(undefined));
    hub.backend.on('status', () => this.emitter.fire(undefined));
  }

  private get graph(): RosGraph | undefined {
    return this.hub.graph;
  }

  private visibleNodes(): GraphNode[] {
    return (this.graph?.nodes ?? []).filter((n) => !n.self);
  }

  getChildren(el?: ExplorerItem): ExplorerItem[] {
    const g = this.graph;
    if (!el) {
      if (this.hub.status.state !== 'ready') {
        const s = this.hub.status;
        const text =
          s.state === 'starting' ? 'Starting ROS backend…' : s.state === 'error' ? `Backend error: ${s.error ?? ''}` : 'Backend stopped';
        return [{ kind: 'message', text }];
      }
      return (['nodes', 'topics', 'services', 'actions'] as Section[]).map((section) => ({ kind: 'section', section }));
    }
    if (!g) return [];
    switch (el.kind) {
      case 'section':
        if (el.section === 'nodes') return this.visibleNodes().map((node) => ({ kind: 'node', node }));
        if (el.section === 'topics') return g.topics.map((t) => ({ kind: 'topic', name: t.name, types: t.types }));
        if (el.section === 'services')
          return g.services.filter((s) => !isParamService(s.name)).map((s) => ({ kind: 'service', name: s.name, types: s.types }));
        return g.actions.map((a) => ({ kind: 'action', name: a.name, types: a.types }));
      case 'node': {
        const out: ExplorerItem[] = [];
        for (const group of Object.keys(GROUP_LABEL) as Group[]) {
          if ((el.node[group] ?? []).length) out.push({ kind: 'group', node: el.node, group });
        }
        return out;
      }
      case 'group': {
        const kind = GROUP_KIND[el.group];
        return (el.node[el.group] ?? []).map(([name, types]) => ({ kind, name, types, parent: `${el.node.fqn}/${el.group}` }));
      }
      default:
        return [];
    }
  }

  getTreeItem(el: ExplorerItem): vscode.TreeItem {
    const g = this.graph;
    switch (el.kind) {
      case 'message': {
        const it = new vscode.TreeItem(el.text);
        it.iconPath = new vscode.ThemeIcon(this.hub.status.state === 'error' ? 'error' : 'loading~spin');
        it.command = { command: 'rosVis.showOutput', title: 'Show log' };
        return it;
      }
      case 'section': {
        const count =
          el.section === 'nodes'
            ? this.visibleNodes().length
            : el.section === 'topics'
              ? g?.topics.length
              : el.section === 'services'
                ? g?.services.filter((s) => !isParamService(s.name)).length
                : g?.actions.length;
        const label = { nodes: 'Nodes', topics: 'Topics', services: 'Services', actions: 'Actions' }[el.section];
        const it = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        it.id = `section:${el.section}`;
        it.description = String(count ?? 0);
        it.iconPath = new vscode.ThemeIcon(
          { nodes: 'circuit-board', topics: 'radio-tower', services: 'call-outgoing', actions: 'rocket' }[el.section],
        );
        return it;
      }
      case 'node': {
        const n = el.node;
        const it = new vscode.TreeItem(n.fqn, vscode.TreeItemCollapsibleState.Collapsed);
        it.id = `node:${n.fqn}`;
        const dup = (n.count ?? 1) > 1;
        it.description = `${dup ? `×${n.count} same name · ` : ''}${n.pubs.length} pub · ${n.subs.length} sub · ${n.srvs.length} srv`;
        it.iconPath = dup ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground')) : new vscode.ThemeIcon('circuit-board');
        it.contextValue = 'named node';
        it.tooltip = dup ? `${n.fqn}\n${n.count} nodes share this exact name (stale processes or duplicate launches?)` : n.fqn;
        return it;
      }
      case 'group': {
        const it = new vscode.TreeItem(GROUP_LABEL[el.group], vscode.TreeItemCollapsibleState.Collapsed);
        it.id = `group:${el.node.fqn}:${el.group}`;
        it.description = String(el.node[el.group].length);
        it.iconPath = new vscode.ThemeIcon(
          { pubs: 'arrow-up', subs: 'arrow-down', srvs: 'server', clients: 'call-outgoing', actionServers: 'rocket', actionClients: 'rocket' }[
            el.group
          ],
        );
        return it;
      }
      case 'topic': {
        const it = new vscode.TreeItem(el.name);
        it.id = `topic:${el.parent ?? ''}:${el.name}`;
        const t = g?.topics.find((x) => x.name === el.name);
        const counts = t ? ` · ${t.pubs.length}↑ ${t.subs.length}↓` : '';
        it.description = shortType(el.types) + counts;
        it.tooltip = new vscode.MarkdownString(
          `**${el.name}**\n\n\`${el.types.join(', ')}\`` +
            (t ? `\n\nPublishers: ${t.pubs.join(', ') || '—'}\n\nSubscribers: ${t.subs.join(', ') || '—'}` : ''),
        );
        it.contextValue = topicContext(el.types);
        it.iconPath = new vscode.ThemeIcon(
          el.types.some((x) => IMAGE_TYPES.includes(x)) ? 'file-media' : el.types.some((x) => CLOUD_TYPES.includes(x)) ? 'globe' : 'symbol-event',
        );
        it.command = { command: 'rosVis.openTopics', title: 'Monitor', arguments: [el] };
        return it;
      }
      case 'service': {
        const it = new vscode.TreeItem(el.name);
        it.id = `service:${el.parent ?? ''}:${el.name}`;
        it.description = shortType(el.types);
        it.contextValue = 'named typed service';
        it.iconPath = new vscode.ThemeIcon('server');
        it.command = { command: 'rosVis.openService', title: 'Call', arguments: [el] };
        return it;
      }
      case 'action': {
        const it = new vscode.TreeItem(el.name);
        it.id = `action:${el.parent ?? ''}:${el.name}`;
        it.description = shortType(el.types);
        it.contextValue = 'named typed action';
        it.iconPath = new vscode.ThemeIcon('rocket');
        return it;
      }
    }
  }
}

export function isParamService(name: string): boolean {
  return /\/(describe_parameters|get_parameter_types|get_parameters|list_parameters|set_parameters|set_parameters_atomically|get_type_description)$/.test(
    name,
  );
}

interface Tool {
  label: string;
  command: string;
  icon: string;
  detail: string;
}

export const TOOLS: Tool[] = [
  { label: 'Node Graph', command: 'rosVis.openGraph', icon: 'type-hierarchy', detail: 'rqt_graph' },
  { label: 'Topic Monitor', command: 'rosVis.openTopics', icon: 'pulse', detail: 'rqt_topic · Hz / BW / echo' },
  { label: 'Image View', command: 'rosVis.openImage', icon: 'file-media', detail: 'rqt_image_view' },
  { label: '3D / Point Cloud', command: 'rosVis.openPointCloud', icon: 'globe', detail: 'PointCloud2 · LaserScan' },
  { label: 'Plot', command: 'rosVis.openPlot', icon: 'graph-line', detail: 'rqt_plot' },
  { label: 'Service Caller', command: 'rosVis.openService', icon: 'call-outgoing', detail: 'rqt_service_caller' },
  { label: 'Publisher', command: 'rosVis.openPublisher', icon: 'broadcast', detail: 'rqt_publisher' },
  { label: 'Parameters', command: 'rosVis.openParams', icon: 'settings', detail: 'rqt_reconfigure' },
  { label: 'Console', command: 'rosVis.openConsole', icon: 'output', detail: 'rqt_console · /rosout' },
  { label: 'TF Tree', command: 'rosVis.openTf', icon: 'list-tree', detail: 'rqt_tf_tree' },
  { label: 'URDF Viewer', command: 'rosVis.openUrdf', icon: 'hubot', detail: 'robot model · joint states' },
];

export class ToolsProvider implements vscode.TreeDataProvider<Tool> {
  getChildren(el?: Tool): Tool[] {
    return el ? [] : TOOLS;
  }

  getTreeItem(t: Tool): vscode.TreeItem {
    const it = new vscode.TreeItem(t.label);
    it.description = t.detail;
    it.iconPath = new vscode.ThemeIcon(t.icon);
    it.command = { command: t.command, title: t.label };
    return it;
  }
}
