import * as fs from 'fs';
import * as path from 'path';
import type { SpawnSpec } from './backend';

export interface BackendConfig {
  /** Absolute path of python/ros_backend.py. */
  scriptPath: string;
  pythonPath: string;
  setupScripts: string[];
  workspaceFolders: string[];
  autoSourceWorkspace: boolean;
  domainId: number | null;
  rmwImplementation: string;
  graphPollInterval: number;
  jpegQuality?: number;
  env?: NodeJS.ProcessEnv;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function expandVars(p: string, workspaceFolders: string[]): string {
  const ws = workspaceFolders[0] ?? '';
  return p
    .replace(/\$\{workspaceFolder\}/g, ws)
    .replace(/^~(?=\/|$)/, process.env.HOME ?? '~')
    .replace(/\$\{env:([A-Za-z0-9_]+)\}/g, (_, n: string) => process.env[n] ?? '');
}

/** Picks /opt/ros/<distro>/setup.bash, preferring $ROS_DISTRO, else the newest. */
export function detectRosSetup(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = '/opt/ros';
  if (!fs.existsSync(root)) return undefined;
  const distros = fs
    .readdirSync(root)
    .filter((d) => fs.existsSync(path.join(root, d, 'setup.bash')))
    .sort();
  if (!distros.length) return undefined;
  const pick = env.ROS_DISTRO && distros.includes(env.ROS_DISTRO) ? env.ROS_DISTRO : distros[distros.length - 1];
  return path.join(root, pick, 'setup.bash');
}

export function resolvePython(cfg: Pick<BackendConfig, 'pythonPath'>): string {
  if (cfg.pythonPath) return cfg.pythonPath;
  // Conda/venv python on PATH usually cannot import the system rclpy build.
  if (process.platform === 'linux' && fs.existsSync('/usr/bin/python3')) return '/usr/bin/python3';
  return process.platform === 'win32' ? 'python' : 'python3';
}

export function buildSpawnSpec(cfg: BackendConfig): SpawnSpec {
  const baseEnv = { ...(cfg.env ?? process.env) };
  const python = resolvePython(cfg);
  const scripts = cfg.setupScripts.map((s) => expandVars(s, cfg.workspaceFolders)).filter(Boolean);
  if (!scripts.length && !baseEnv.AMENT_PREFIX_PATH) {
    const rosSetup = detectRosSetup(baseEnv);
    if (rosSetup) scripts.push(rosSetup);
  }
  if (cfg.autoSourceWorkspace) {
    for (const ws of cfg.workspaceFolders) {
      const s = path.join(ws, 'install', 'setup.bash');
      if (fs.existsSync(s) && !scripts.includes(s)) scripts.push(s);
    }
  }
  const env: NodeJS.ProcessEnv = { ...baseEnv, PYTHONUNBUFFERED: '1', ROS_VIS_GRAPH_POLL: String(cfg.graphPollInterval) };
  if (cfg.jpegQuality !== undefined) env.ROS_VIS_JPEG_QUALITY = String(Math.round(cfg.jpegQuality));
  if (cfg.domainId !== null && cfg.domainId !== undefined) env.ROS_DOMAIN_ID = String(cfg.domainId);
  if (cfg.rmwImplementation) env.RMW_IMPLEMENTATION = cfg.rmwImplementation;
  // conda activation can leak a PYTHONHOME that breaks the system interpreter
  if (python.startsWith('/usr/')) delete env.PYTHONHOME;

  const missing = scripts.filter((s) => !fs.existsSync(s));
  if (missing.length) throw new Error(`setup script not found: ${missing.join(', ')}`);

  if (scripts.length && process.platform !== 'win32') {
    const sourcing = scripts.map((s) => `source ${shellQuote(s)}`).join(' && ');
    const cmd = `${sourcing} && exec ${shellQuote(python)} -u ${shellQuote(cfg.scriptPath)}`;
    return {
      command: 'bash',
      args: ['-c', cmd],
      env,
      description: `${scripts.join(' + ')} -> ${python}`,
    };
  }
  return { command: python, args: ['-u', cfg.scriptPath], env, description: python };
}
