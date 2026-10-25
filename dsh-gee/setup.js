/**
 * First-run setup for the Earth Engine tools.
 *
 * DeepSeek Harness already ships a Python runtime (resources/runtime/…), so the
 * only thing a new machine lacks is `earthengine-api` and friends. This module
 * finds that interpreter, builds a private virtual environment, installs from a
 * local wheelhouse when one exists (offline) or from an index otherwise, writes
 * the machine-local config, and runs the OAuth flow.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PACKAGES = ['earthengine-api', 'tifffile', 'matplotlib'];
const DEFAULT_INDEX = 'https://mirrors.aliyun.com/pypi/simple';

function venvPython(dir) {
  return process.platform === 'win32' ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python');
}

function venvBin(dir, name) {
  return process.platform === 'win32' ? path.join(dir, 'Scripts', `${name}.exe`) : path.join(dir, 'bin', name);
}

/** Ask one interpreter for its version; undefined when it cannot even start. */
function probe(python) {
  const result = spawnSync(python, ['-c', 'import sys; print(sys.version.split()[0])'], { timeout: 20_000 });
  if (result.status !== 0) return undefined;
  return result.stdout.toString().trim();
}

/** A bare command name is the plugin's fallback default, not a real preference. */
function isBareCommand(value) {
  return typeof value === 'string' && value.length > 0 && !/[\\/]/.test(value);
}

/** Ordered candidates: configured, the runtime DSH ships, its per-home copies, PATH. */
function candidates(cfg) {
  const list = [];
  if (cfg.python && !isBareCommand(cfg.python)) list.push({ python: cfg.python, source: 'config' });
  try {
    if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
      list.push({
        python: path.join(process.resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'python', 'python.exe'),
        source: 'harness-runtime',
      });
    }
  } catch {
    // not running inside Electron
  }
  const home = process.env.DSH_HOME;
  if (typeof home === 'string' && home) {
    const runtimes = path.join(home, 'dsh-runtimes');
    try {
      for (const name of fs.readdirSync(runtimes)) {
        list.push({
          python: path.join(runtimes, name, 'dependencies', 'python', 'python.exe'),
          source: `dsh-runtimes/${name}`,
        });
      }
    } catch {
      // no provisioned runtimes
    }
  }
  // The runtime DSH ships is the one this plugin was built against, so it wins
  // over whatever "python" happens to be first on PATH (often a conda install).
  if (cfg.python && isBareCommand(cfg.python)) {
    list.push({ python: cfg.python, source: 'PATH (configured)' });
  }
  list.push({ python: 'python', source: 'PATH' });
  return list;
}

function run(command, args, { env, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, { env: env ?? process.env, windowsHide: true });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-8000);
    });
    child.stderr.on('data', (chunk) => {
      output = (output + chunk).slice(-8000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${output}\n${error.message}` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });
}

function credentialsPath(home) {
  const base = home || process.env.USERPROFILE || process.env.HOME || '';
  return path.join(base, '.config', 'earthengine', 'credentials');
}

export function createSetup({ cfg, here, outRootFor }) {
  let authChild;

  function workerEnv(exec, extra) {
    const env = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      ...(extra ?? {}),
    };
    const home = extra?.home ?? cfg.home;
    if (home) {
      env.USERPROFILE = home;
      env.HOME = home;
    }
    const proxy = extra?.proxy ?? cfg.proxy;
    if (proxy) {
      env.HTTPS_PROXY = proxy;
      env.HTTP_PROXY = proxy;
    }
    // The Harness temp root is not always writable by a child process, and pip
    // and venv both need one, so pin it inside the workspace.
    try {
      const tmp = path.join(outRootFor(exec), '.gee-tmp');
      fs.mkdirSync(tmp, { recursive: true });
      env.TEMP = tmp;
      env.TMP = tmp;
      env.TMPDIR = tmp;
    } catch {
      // leave the inherited temp alone
    }
    return env;
  }

  function resolvePython() {
    for (const candidate of candidates(cfg)) {
      if (candidate.python === 'python') {
        const version = probe('python');
        if (version) return { ...candidate, version };
        continue;
      }
      if (!fs.existsSync(candidate.python)) continue;
      const version = probe(candidate.python);
      if (version) return { ...candidate, version };
    }
    return undefined;
  }

  function readConfigFile() {
    try {
      return JSON.parse(fs.readFileSync(path.join(here, 'gee.config.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  function writeConfigFile(values) {
    const file = path.join(here, 'gee.config.json');
    const next = { ...readConfigFile(), ...values };
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    return file;
  }

  /** The interpreter the tools should use: explicit venv, config, then the default. */
  function interpreterFor(exec, args) {
    if (args.venv) return venvPython(args.venv);
    const configured = readConfigFile().python || cfg.python || '';
    if (configured && !isBareCommand(configured)) return configured;
    return venvPython(path.join(outRootFor(exec), '.gee-venv'));
  }

  function wheelDir(exec) {
    const candidatesDir = [path.join(here, 'wheels'), path.join(outRootFor(exec), 'wheels')];
    return candidatesDir.find((dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
  }

  async function state(exec, args) {
    const found = resolvePython();
    const interpreter = interpreterFor(exec, args);
    const venv = path.dirname(path.dirname(interpreter));
    const venvReady = fs.existsSync(interpreter);
    let depsReady = false;
    let haveEe = false;
    if (venvReady) {
      const check = spawnSync(interpreter, ['-c', 'import ee, numpy, tifffile; import matplotlib'], { timeout: 60_000 });
      depsReady = check.status === 0;
      haveEe = true;
    }
    const credentials = credentialsPath(args.home || cfg.home);
    return {
      python: found?.python ?? '',
      pythonSource: found?.source ?? '',
      pythonVersion: found?.version ?? '',
      venv,
      venvReady,
      depsReady,
      haveEe,
      credentials,
      credentialsReady: fs.existsSync(credentials),
      project: args.project || cfg.project || '',
      proxy: args.proxy || cfg.proxy || '',
      wheels: wheelDir(exec) ?? '',
    };
  }

  return {
    name: 'gee_setup',
    description:
      'First-run setup for Earth Engine: find the Python runtime that DeepSeek Harness ships, build a private ' +
      'virtual environment, install earthengine-api/tifffile/matplotlib (offline when a wheels directory is ' +
      'present), write the machine-local config, and run the browser login. Use action=check first, then ' +
      'install, auth, and verify.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['check', 'install', 'auth', 'verify'],
          description: 'check reports what is missing; install builds the environment; auth starts the OAuth flow; verify proves it works.',
        },
        project: {
          type: 'string',
          description: 'Earth Engine Cloud project id. Written to gee.config.json by install/auth/verify.',
        },
        proxy: { type: 'string', description: 'HTTPS proxy for the worker, for example http://127.0.0.1:7890.' },
        home: {
          type: 'string',
          description: 'Directory that holds .config/earthengine, when the real home is not writable.',
        },
        venv: { type: 'string', description: 'Override the virtual environment location. Default <workspace>/.gee-venv.' },
        indexUrl: { type: 'string', description: 'Package index used when no local wheels directory exists.' },
        port: { type: 'integer', description: 'Local port for the OAuth callback. Default 8085.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          phase: { type: 'string' },
          python: { type: 'string' },
          pythonSource: { type: 'string' },
          venv: { type: 'string' },
          venvReady: { type: 'boolean' },
          depsReady: { type: 'boolean' },
          credentials: { type: 'string' },
          credentialsReady: { type: 'boolean' },
          project: { type: 'string' },
          url: { type: 'string' },
          log: { type: 'string' },
          next: { type: 'string' },
        },
        required: ['phase'],
      },
      render: (_args, value) => {
        const lines = [`phase: ${value.phase}`];
        for (const key of ['python', 'pythonSource', 'venv', 'credentials', 'project']) {
          if (value[key]) lines.push(`${key}: ${value[key]}`);
        }
        for (const key of ['venvReady', 'depsReady', 'credentialsReady']) {
          if (typeof value[key] === 'boolean') lines.push(`${key}: ${value[key] ? 'yes' : 'no'}`);
        }
        if (value.url) lines.push(`open this URL to authorize: ${value.url}`);
        if (value.log) lines.push('', value.log.trim().split('\n').slice(-8).join('\n'));
        if (value.next) lines.push('', `next: ${value.next}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const action = typeof args.action === 'string' ? args.action : 'check';

      if (action === 'check') {
        const current = await state(exec, args);
        const next = !current.python
          ? 'no usable Python found: install DeepSeek Harness (it ships one) or set `python` in gee.config.json'
          : !current.venvReady
            ? 'run action=install'
            : !current.depsReady
              ? 'run action=install again: the environment exists but the packages are incomplete'
              : !current.credentialsReady
                ? 'run action=auth'
                : !current.project
                  ? 'set project, then run action=verify'
                  : 'run action=verify';
        return { phase: 'check', ...current, next };
      }

      if (action === 'install') {
        const found = resolvePython();
        if (!found) throw new Error('no usable Python found; install DeepSeek Harness or set `python`');
        const venv = args.venv || path.join(outRootFor(exec), '.gee-venv');
        const python = venvPython(venv);
        if (!fs.existsSync(python)) {
          const created = await run(found.python, ['-m', 'venv', venv], { env: workerEnv(exec, args) });
          if (created.code !== 0) throw new Error(`venv creation failed:\n${created.output.slice(-600)}`);
        }
        const wheels = wheelDir(exec);
        const pipArgs = ['-m', 'pip', 'install', '--no-cache-dir', '--progress-bar', 'off'];
        if (wheels) pipArgs.push('--no-index', '--find-links', wheels);
        else pipArgs.push('-i', typeof args.indexUrl === 'string' ? args.indexUrl : DEFAULT_INDEX);
        pipArgs.push(...PACKAGES);
        const installed = await run(python, pipArgs, { env: workerEnv(exec, args) });
        const configFile = writeConfigFile({
          python,
          ...(args.project ? { project: args.project } : {}),
          ...(args.proxy ? { proxy: args.proxy } : {}),
          ...(args.home ? { home: args.home } : {}),
        });
        if (installed.code !== 0) {
          return {
            phase: 'install-failed',
            venv,
            log: installed.output,
            next: `pip failed; fix the index or drop a wheels/ directory next to the plugin, then retry (config kept at ${configFile})`,
          };
        }
        const current = await state(exec, args);
        return {
          phase: 'installed',
          ...current,
          log: installed.output,
          next: current.credentialsReady
            ? 'run action=verify'
            : 'reload the plugin so the worker uses the new interpreter, then run action=auth',
        };
      }

      if (action === 'auth') {
        const python = interpreterFor(exec, args);
        const venv = path.dirname(path.dirname(python));
        const cli = venvBin(venv, 'earthengine');
        const exec0 = fs.existsSync(cli) ? cli : python;
        const port = Number.isFinite(args.port) ? args.port : 8085;
        const authArgs = fs.existsSync(cli)
          ? ['authenticate', '--auth_mode', `localhost:${port}`, '--force']
          : ['-m', 'ee.cli.eecli', 'authenticate', '--auth_mode', `localhost:${port}`, '--force'];
        if (authChild) {
          try {
            authChild.kill();
          } catch {
            // already gone
          }
        }
        const env = workerEnv(exec, args);
        let buffer = '';
        const url = await new Promise((resolve, reject) => {
          authChild = spawn(exec0, authArgs, { env, windowsHide: true });
          const timer = setTimeout(() => resolve(''), 25_000);
          const onData = (chunk) => {
            buffer += chunk;
            const match = buffer.match(/https:\/\/accounts\.google\.com\/[^\s]+/);
            if (match) {
              clearTimeout(timer);
              resolve(match[0]);
            }
          };
          authChild.stdout.on('data', onData);
          authChild.stderr.on('data', onData);
          authChild.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          authChild.on('exit', () => {
            clearTimeout(timer);
            resolve('');
          });
        });
        const credentials = credentialsPath(args.home || cfg.home);
        if (!url) {
          return {
            phase: 'auth-no-url',
            credentials,
            log: buffer,
            next: 'the CLI printed no URL; run `earthengine authenticate --auth_mode localhost` manually and check the venv',
          };
        }
        return {
          phase: 'awaiting-browser',
          url,
          credentials,
          next: 'open the URL, approve, then run action=verify',
        };
      }

      if (action === 'verify') {
        const python = interpreterFor(exec, args);
        const project = args.project || cfg.project || readConfigFile().project || '';
        if (!project) throw new Error('verify needs a project id (argument or gee.config.json)');
        const script = 'import ee,sys; ee.Initialize(project=sys.argv[1]); print("round-trip", ee.Number(1).add(1).getInfo())';
        const result = await run(python, ['-c', script, project], { env: workerEnv(exec, args), timeoutMs: 180_000 });
        const credentials = credentialsPath(args.home || cfg.home);
        return {
          phase: result.code === 0 ? 'verified' : 'verify-failed',
          credentials,
          credentialsReady: fs.existsSync(credentials),
          project,
          log: result.output,
          next:
            result.code === 0
              ? 'reload the plugin (set_bundle) so the running worker uses this interpreter, then call gee_status'
              : 'check that the project id is registered for Earth Engine and that the proxy reaches Google',
        };
      }

      throw new Error(`unknown action ${action}`);
    },
  };
}
