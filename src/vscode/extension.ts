import * as path from 'path';
import * as vscode from 'vscode';
import type { BackendStatus, ViewName } from '../../shared/protocol';
import { RosBackend } from '../core/backend';
import { BackendConfig, buildSpawnSpec } from '../core/env';
import { Hub } from '../core/hub';
import { ExplorerItem, ExplorerProvider, TOOLS, ToolsProvider } from './explorer';
import { PanelManager } from './panels';

let backend: RosBackend | undefined;

function readConfig(ctx: vscode.ExtensionContext): BackendConfig {
  const c = vscode.workspace.getConfiguration('rosVis');
  return {
    scriptPath: path.join(ctx.extensionPath, 'python', 'ros_backend.py'),
    pythonPath: c.get<string>('pythonPath', ''),
    setupScripts: c.get<string[]>('setupScripts', []),
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    autoSourceWorkspace: c.get<boolean>('autoSourceWorkspace', true),
    domainId: c.get<number | null>('domainId', null),
    rmwImplementation: c.get<string>('rmwImplementation', ''),
    graphPollInterval: c.get<number>('graphPollInterval', 1.0),
    jpegQuality: c.get<number>('image.jpegQuality', 85),
  };
}

/** Normalises command arguments coming from the tree, the palette or a webview. */
function argsFrom(a: unknown): Record<string, unknown> {
  if (a === undefined || a === null) return {};
  if (a instanceof vscode.Uri) return { file: a.fsPath };
  if (typeof a === 'string') return { topic: a, name: a };
  const item = a as ExplorerItem & Record<string, unknown>;
  if (item.kind === 'topic') return { topic: item.name, type: item.types[0] };
  if (item.kind === 'service') return { service: item.name, type: item.types[0] };
  if (item.kind === 'node') return { node: item.node.fqn };
  if (item.kind === 'action') return { action: item.name, type: item.types[0] };
  return { ...(a as Record<string, unknown>) };
}

export function activate(ctx: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('ROS 2 Visualiser');
  backend = new RosBackend(
    () => buildSpawnSpec(readConfig(ctx)),
    (line) => out.appendLine(line),
  );
  const hub = new Hub(backend);
  const panels = new PanelManager(ctx, hub);
  ctx.subscriptions.push(out, panels, { dispose: () => backend?.dispose() });

  // ---- tree views ------------------------------------------------------
  const explorer = new ExplorerProvider(hub);
  ctx.subscriptions.push(
    vscode.window.createTreeView('rosVis.explorer', { treeDataProvider: explorer, showCollapseAll: true }),
    vscode.window.createTreeView('rosVis.tools', { treeDataProvider: new ToolsProvider() }),
  );

  // ---- status bar ------------------------------------------------------
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'rosVis.quickOpen';
  const renderStatus = (): void => {
    const s: BackendStatus = hub.status;
    if (s.state === 'ready') {
      const g = hub.graph;
      const nodes = g ? g.nodes.filter((n) => !n.self).length : 0;
      const topics = g ? g.topics.length : 0;
      status.text = `$(radio-tower) ROS ${s.info?.distro ?? ''} · D${s.info?.domainId ?? 0} · ${nodes} nodes · ${topics} topics`;
      status.tooltip = `rmw: ${s.info?.rmw}\nbackend node: ${s.info?.node}\npython: ${s.info?.python}\nClick for ROS tools`;
      status.backgroundColor = undefined;
    } else if (s.state === 'starting') {
      status.text = '$(sync~spin) ROS starting…';
      status.tooltip = 'Starting the ROS 2 backend';
      status.backgroundColor = undefined;
    } else {
      status.text = s.state === 'error' ? '$(error) ROS backend error' : '$(circle-slash) ROS stopped';
      status.tooltip = s.error ?? 'Backend not running. Click for options.';
      status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    status.show();
  };
  hub.onGraph(renderStatus);
  backend.on('status', renderStatus);
  ctx.subscriptions.push(status);
  renderStatus();

  let warned = false;
  backend.on('status', (s: BackendStatus) => {
    if (s.state === 'ready') warned = false;
    if (s.state !== 'error' || warned) return;
    warned = true;
    const err = s.error ?? '';
    const hint = /No module named 'rclpy'|rclpy/.test(err)
      ? 'The backend cannot import rclpy. Set "rosVis.pythonPath" to the ROS interpreter (e.g. /usr/bin/python3) or configure "rosVis.setupScripts".'
      : `ROS backend failed: ${err.split('\n').pop()}`;
    void vscode.window.showErrorMessage(hint, 'Open Settings', 'Show Log', 'Restart').then((pick) => {
      if (pick === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'rosVis');
      if (pick === 'Show Log') out.show();
      if (pick === 'Restart') backend?.restart();
    });
  });

  // ---- commands --------------------------------------------------------
  const openCmd: [string, ViewName][] = [
    ['rosVis.openGraph', 'graph'],
    ['rosVis.openTopics', 'topics'],
    ['rosVis.openImage', 'image'],
    ['rosVis.openPointCloud', 'pointcloud'],
    ['rosVis.openPlot', 'plot'],
    ['rosVis.openService', 'service'],
    ['rosVis.openPublisher', 'publisher'],
    ['rosVis.openParams', 'params'],
    ['rosVis.openConsole', 'console'],
    ['rosVis.openTf', 'tf'],
    ['rosVis.openUrdf', 'urdf'],
  ];
  for (const [cmd, view] of openCmd) {
    ctx.subscriptions.push(
      vscode.commands.registerCommand(cmd, (a?: unknown) => {
        if (hub.status.state === 'stopped') backend?.start();
        panels.open(view, argsFrom(a));
      }),
    );
    ctx.subscriptions.push(vscode.window.registerWebviewPanelSerializer(`rosVis.${view}`, panels.serializer(view)));
  }

  ctx.subscriptions.push(
    vscode.commands.registerCommand('rosVis.openUrdfFile', (uri?: vscode.Uri) => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (!target || !/\.(urdf|xacro)$/i.test(target.fsPath)) {
        void vscode.window.showWarningMessage('Select a .urdf or .xacro file.');
        return;
      }
      if (hub.status.state === 'stopped') backend?.start();
      panels.open('urdf', { file: target.fsPath });
    }),
    vscode.commands.registerCommand('rosVis.restartBackend', () => backend?.restart()),
    vscode.commands.registerCommand('rosVis.showOutput', () => out.show()),
    vscode.commands.registerCommand('rosVis.copyName', (a?: unknown) => {
      const item = a as ExplorerItem | undefined;
      const name = item && 'name' in item ? item.name : item?.kind === 'node' ? item.node.fqn : undefined;
      if (name) void vscode.env.clipboard.writeText(name);
    }),
    vscode.commands.registerCommand('rosVis.quickOpen', async () => {
      const items = [
        ...TOOLS.map((t) => ({ label: `$(${t.icon}) ${t.label}`, description: t.detail, command: t.command })),
        { label: '$(debug-restart) Restart ROS backend', description: '', command: 'rosVis.restartBackend' },
        { label: '$(output) Show backend log', description: '', command: 'rosVis.showOutput' },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'ROS 2 tools' });
      if (pick) void vscode.commands.executeCommand(pick.command);
    }),
    vscode.commands.registerCommand('rosVis.showInterface', async (a?: unknown) => {
      let type = typeof a === 'string' ? a : (argsFrom(a).type as string | undefined);
      try {
        if (!type) {
          const list = await hub.backend.request<{ msgs: string[]; srvs: string[] }>('listInterfaces');
          type = await vscode.window.showQuickPick([...list.msgs, ...list.srvs], { placeHolder: 'Interface type' });
          if (!type) return;
        }
        const info = await hub.backend.request<Record<string, unknown>>('interface', { type });
        const sample = info.default ?? { request: info.request, response: info.response };
        const content = `# ${type}\n# ${info.path ?? ''}\n\n${info.definition}\n\n# ---- default value (JSON) ----\n# ${JSON.stringify(sample)}\n`;
        const doc = await vscode.workspace.openTextDocument({ content, language: 'properties' });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (e) {
        void vscode.window.showErrorMessage(`Cannot show interface: ${(e as Error).message}`);
      }
    }),
  );

  // live preview: reload file based URDF viewers when robot description sources are saved
  ctx.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!/\.(urdf|xacro|xml|yaml|yml|sdf)$/i.test(doc.fileName)) return;
      panels.notify('urdf', (args) => typeof args.file === 'string', { reload: Date.now() });
    }),
  );

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        ['pythonPath', 'setupScripts', 'autoSourceWorkspace', 'domainId', 'rmwImplementation', 'graphPollInterval', 'image.jpegQuality'].some((k) =>
          e.affectsConfiguration(`rosVis.${k}`),
        )
      ) {
        out.appendLine('configuration changed; restarting backend');
        backend?.restart();
      }
    }),
  );

  backend.start();
}

export function deactivate(): void {
  backend?.dispose();
  backend = undefined;
}
