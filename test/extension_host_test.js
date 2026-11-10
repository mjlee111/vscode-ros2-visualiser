// Runs dist/extension.js against a stubbed `vscode` module and the real backend.
//   ROS_DOMAIN_ID=87 ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST node test/extension_host_test.js
'use strict';
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');
const commands = new Map();
const panels = [];
const opened = [];
const treeViews = {};
const statusItems = [];
const errors = [];

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (fn) => {
      this.listeners.push(fn);
      return { dispose() {} };
    };
  }
  fire(v) {
    for (const l of this.listeners) l(v);
  }
}
class Uri {
  constructor(p) {
    this.fsPath = p;
    this.path = p;
  }
  toString() {
    return `file://${this.fsPath}`;
  }
  static file(p) {
    return new Uri(p);
  }
  static joinPath(u, ...parts) {
    return new Uri(path.join(u.fsPath, ...parts));
  }
}
const saveEmitter = new EventEmitter();
class TreeItem {
  constructor(label, state) {
    this.label = label;
    this.collapsibleState = state;
  }
}
function makePanel(viewType, title) {
  const recv = new EventEmitter();
  const disposeEv = new EventEmitter();
  const panel = {
    viewType,
    title,
    posted: [],
    revealed: 0,
    webview: {
      html: '',
      options: {},
      cspSource: 'vscode-resource:',
      asWebviewUri: (u) => `vscode-resource:${u.fsPath}`,
      postMessage: async (m) => {
        panel.posted.push(m);
        return true;
      },
      onDidReceiveMessage: recv.event,
    },
    send: (m) => recv.fire(m),
    reveal() {
      panel.revealed++;
    },
    onDidDispose: disposeEv.event,
    onDidChangeViewState: () => ({ dispose() {} }),
    dispose() {
      disposeEv.fire();
    },
  };
  panels.push(panel);
  return panel;
}
const vscode = {
  EventEmitter,
  Uri,
  TreeItem,
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  MarkdownString: class {
    constructor(v) {
      this.value = v;
    }
  },
  Position: class {
    constructor(l, c) {
      this.line = l;
      this.character = c;
    }
  },
  Range: class {
    constructor(a, b) {
      this.start = a;
      this.end = b;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1 },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => ({ appendLine: (l) => process.env.VERBOSE && console.log('[out]', l), show() {}, dispose() {} }),
    createTreeView: (id, opts) => {
      treeViews[id] = opts.treeDataProvider;
      return { dispose() {} };
    },
    createStatusBarItem: () => {
      const it = { text: '', show() {}, dispose() {} };
      statusItems.push(it);
      return it;
    },
    showErrorMessage: async (m) => {
      errors.push(m);
    },
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showSaveDialog: async () => undefined,
    showTextDocument: async () => undefined,
    createWebviewPanel: (viewType, title) => makePanel(viewType, title),
    registerWebviewPanelSerializer: () => ({ dispose() {} }),
  },
  commands: {
    registerCommand: (id, fn) => {
      commands.set(id, fn);
      return { dispose() {} };
    },
    executeCommand: async (id, ...args) => commands.get(id)?.(...args),
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (_k, d) => d }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidSaveTextDocument: (fn) => saveEmitter.event(fn),
    openTextDocument: async (o) => {
      opened.push(o);
      return o;
    },
    fs: { writeFile: async () => undefined },
  },
  env: { clipboard: { writeText: async () => undefined } },
};

const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return vscode;
  return origLoad.call(this, req, ...rest);
};

const fails = [];
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : `  -> ${JSON.stringify(detail)?.slice(0, 300)}`}`);
  if (!cond) fails.push(name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  return undefined;
}

(async () => {
  const ext = require(path.join(root, 'dist', 'extension.js'));
  const ctx = { subscriptions: [], extensionPath: root, extensionUri: Uri.file(root) };
  ext.activate(ctx);
  check('commands registered', ['rosVis.openGraph', 'rosVis.openTopics', 'rosVis.openImage', 'rosVis.openTf', 'rosVis.showInterface'].every((c) => commands.has(c)), [...commands.keys()]);
  const status = statusItems[0];
  check('backend ready (status bar)', !!(await until(() => /ROS jazzy/.test(status.text) && / \d+ topics/.test(status.text))), status.text);
  // tree view
  const explorer = treeViews['rosVis.explorer'];
  await until(() => {
    const secs = explorer.getChildren();
    return secs.length === 4 && explorer.getChildren(secs[1]).some((t) => t.name === '/demo/points') && explorer.getChildren(secs[2]).some((t) => t.name === '/demo/add_two_ints');
  }, 15000);
  console.log('     status:', status.text);
  const sections = explorer.getChildren();
  check('explorer sections', sections.length === 4, sections);
  const topics = explorer.getChildren(sections[1]);
  const points = topics.find((t) => t.name === '/demo/points');
  check('topic items', !!points, topics.map((t) => t.name));
  const ti = explorer.getTreeItem(points);
  check('cloud context value', /cloud/.test(ti.contextValue) && /topic/.test(ti.contextValue), ti.contextValue);
  const img = topics.find((t) => t.name === '/demo/camera/image_raw');
  check('image context value', /image/.test(explorer.getTreeItem(img).contextValue));
  const nodes = explorer.getChildren(sections[0]);
  check('self node hidden', nodes.every((n) => !n.node.self) && nodes.some((n) => n.node.fqn === '/demo/demo_sensors'), nodes.map((n) => n.node.fqn));
  const groups = explorer.getChildren(nodes.find((n) => n.node.fqn === '/demo/demo_sensors'));
  check('node groups', groups.some((g) => g.group === 'pubs') && groups.some((g) => g.group === 'srvs'), groups.map((g) => g.group));
  const services = explorer.getChildren(sections[2]);
  check('param services filtered', services.every((s) => !/list_parameters/.test(s.name)) && services.some((s) => s.name === '/demo/add_two_ints'), services.map((s) => s.name));
  for (const s of sections) for (const c of explorer.getChildren(s)) explorer.getTreeItem(c);
  check('tools view', treeViews['rosVis.tools'].getChildren().length === 11);

  // panels
  await vscode.commands.executeCommand('rosVis.openTopics', topics.find((t) => t.name === '/demo/pose'));
  const tp = panels[0];
  check('topics panel created', tp && tp.viewType === 'rosVis.topics', tp && tp.viewType);
  check('webview html has CSP + script', /Content-Security-Policy/.test(tp.webview.html) && /topics\.js/.test(tp.webview.html) && /nonce-/.test(tp.webview.html));
  tp.send({ type: 'ready' });
  const init = tp.posted.find((m) => m.type === 'init');
  check('init message', init && init.view === 'topics' && init.args.topic === '/demo/pose' && init.graph && init.status.state === 'ready', init && init.args);
  tp.send({ type: 'subscribe', subId: 'pose1', topic: '/demo/pose', mode: 'json', opts: { maxRate: 10 } });
  check('json events routed', !!(await until(() => tp.posted.some((m) => m.type === 'event' && m.event.subId === 'pose1' && m.event.ev === 'msg'))));
  check('stats broadcast', !!(await until(() => tp.posted.some((m) => m.type === 'stats' && m.stats['/demo/pose']), 4000)));
  tp.send({ type: 'request', id: 7, op: 'callService', params: { service: '/demo/add_two_ints', request: { a: 20, b: 22 } } });
  const resp = await until(() => tp.posted.find((m) => m.type === 'response' && m.id === 7));
  check('request/response', resp && resp.ok && resp.result.response.sum === 42, resp);
  tp.send({ type: 'request', id: 8, op: 'nonsense' });
  const bad = await until(() => tp.posted.find((m) => m.type === 'response' && m.id === 8));
  check('error response', bad && !bad.ok, bad);

  // singleton reuse + args forwarding
  await vscode.commands.executeCommand('rosVis.openTopics', '/demo/sine');
  check('topics panel reused', panels.length === 1 && tp.revealed === 1 && tp.posted.some((m) => m.type === 'args' && m.args.topic === '/demo/sine'));

  // image: one panel per topic
  await vscode.commands.executeCommand('rosVis.openImage', img);
  await vscode.commands.executeCommand('rosVis.openImage', { topic: '/demo/camera/image_raw' });
  await vscode.commands.executeCommand('rosVis.openImage', { topic: '/demo/camera/depth' });
  const imgPanels = panels.filter((p) => p.viewType === 'rosVis.image');
  check('image panels per topic', imgPanels.length === 2, imgPanels.map((p) => p.title));
  const ip = imgPanels[0];
  ip.send({ type: 'ready' });
  ip.send({ type: 'subscribe', subId: 'img1', topic: '/demo/camera/image_raw', mode: 'image', opts: {} });
  const frame = await until(() => ip.posted.find((m) => m.type === 'event' && m.event.subId === 'img1' && m.payload));
  check('binary payload delivered as Uint8Array', frame && frame.payload instanceof Uint8Array && frame.payload.byteOffset === 0 && frame.payload[0] === 0xff, frame && frame.event);
  ip.send({ type: 'ack', subId: 'img1' });
  await sleep(300);
  const nFrames = ip.posted.filter((m) => m.type === 'event' && m.event.subId === 'img1').length;
  check('flow control (acked frames only)', nFrames <= 3, nFrames);

  // command forwarding from webview, restricted to rosVis.*
  let forwarded = 0;
  const origExec = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async (id, ...a) => {
    forwarded++;
    if (id === 'workbench.action.quit') throw new Error('must not forward');
    return origExec(id, ...a);
  };
  tp.send({ type: 'command', command: 'workbench.action.quit', args: [] });
  tp.send({ type: 'command', command: 'rosVis.openPlot', args: [{ topic: '/demo/sine', field: 'data' }] });
  await sleep(50);
  vscode.commands.executeCommand = origExec;
  check('only rosVis.* commands forwarded', forwarded === 1, forwarded);
  check('plot panel opened from webview', panels.some((p) => p.viewType === 'rosVis.plot'));

  // publisher ownership: closing the panel stops its publishers
  await vscode.commands.executeCommand('rosVis.openPublisher');
  const pp = panels.find((p) => p.viewType === 'rosVis.publisher');
  pp.send({ type: 'ready' });
  pp.send({ type: 'request', id: 1, op: 'startPublisher', params: { pubId: 'p-test', topic: '/vis_test/x', type: 'std_msgs/msg/Int32', msg: { data: 5 }, rate: 10 } });
  check('publisher started', !!(await until(() => pp.posted.find((m) => m.type === 'response' && m.id === 1 && m.ok))));
  check('pubStatus routed to owner', !!(await until(() => pp.posted.some((m) => m.type === 'event' && m.event.pubId === 'p-test'), 3000)));
  pp.dispose();
  await sleep(1500);
  tp.send({ type: 'request', id: 9, op: 'graph' });
  const g = await until(() => tp.posted.find((m) => m.type === 'response' && m.id === 9));
  const xt = g.result.topics.find((t) => t.name === '/vis_test/x');
  check('publisher removed when panel closed', !xt, xt);

  // unsubscribe on dispose
  ip.dispose();
  await sleep(300);
  const before = ip.posted.length;
  await sleep(700);
  check('no events after dispose', ip.posted.length === before, ip.posted.length - before);

  // interface document
  await vscode.commands.executeCommand('rosVis.showInterface', 'sensor_msgs/msg/Image');
  check('showInterface document', opened.length === 1 && /std_msgs\/Header header/.test(opened[0].content), opened[0] && opened[0].content.slice(0, 200));

  // URDF viewer: explorer/editor command with a Uri, reuse per file, reload on save
  const urdfFile = '/opt/ros/jazzy/share/robot_state_publisher/urdf/test-desc.urdf';
  await vscode.commands.executeCommand('rosVis.openUrdfFile', Uri.file(urdfFile));
  const up = panels.find((p) => p.viewType === 'rosVis.urdf');
  check('urdf panel from file Uri', up && /test-desc\.urdf/.test(up.title), up && up.title);
  up.send({ type: 'ready' });
  const uinit = up.posted.find((m) => m.type === 'init');
  check('urdf init carries file', uinit && uinit.args.file === urdfFile, uinit && uinit.args);
  await vscode.commands.executeCommand('rosVis.openUrdfFile', Uri.file(urdfFile));
  check('urdf panel reused for same file', panels.filter((p) => p.viewType === 'rosVis.urdf').length === 1 && up.revealed === 1);
  await vscode.commands.executeCommand('rosVis.openUrdfFile', Uri.file('/tmp/not-a-robot.txt'));
  check('non-urdf file rejected', panels.filter((p) => p.viewType === 'rosVis.urdf').length === 1);
  saveEmitter.fire({ fileName: '/ws/src/robot/urdf/arm.xacro' });
  check('save of .xacro triggers reload', up.posted.some((m) => m.type === 'args' && typeof m.args.reload === 'number'));
  const before2 = up.posted.length;
  saveEmitter.fire({ fileName: '/ws/src/main.cpp' });
  check('save of unrelated file ignored', up.posted.length === before2);
  up.send({ type: 'request', id: 51, op: 'loadUrdf', params: { path: urdfFile } });
  const ur = await until(() => up.posted.find((m) => m.type === 'response' && m.id === 51));
  check('loadUrdf through hub', ur && ur.ok && /<robot/.test(ur.result.urdf), ur && ur.error);

  check('no error notifications', errors.length === 0, errors);
  ext.deactivate();
  const t0 = Date.now();
  const children = () => {
    try {
      return require('child_process').execFileSync('pgrep', ['-a', '-P', String(process.pid)]).toString().trim();
    } catch {
      return '';
    }
  };
  let kids = children();
  while (kids && Date.now() - t0 < 5000) {
    await sleep(100);
    kids = children();
  }
  console.log(`     backend exit took ${Date.now() - t0} ms`);
  check('backend process exited on deactivate', kids === '', kids);
  console.log(`\n${fails.length} failure(s)`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
