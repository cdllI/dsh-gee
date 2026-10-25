/**
 * Google Earth Engine tools for DeepSeek Harness.
 *
 * Earth Engine's Node client cannot authenticate with the refresh-token
 * credentials `earthengine authenticate` writes, and it ignores HTTP proxies,
 * so this bundle owns a long-lived Python worker (`worker.py`) instead: the
 * official `earthengine-api` honors both the stored credentials and the
 * HTTPS_PROXY of a proxied network.
 */

import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-gee';
export const inject = ['tools', 'attachments', 'webServer'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_EVAL_CHARS = 24_000;

/**
 * Machine-local settings live beside the plugin in `gee.config.json`, outside the
 * repository, so installing the bundle never requires editing its committed
 * patch with someone else's absolute paths. A Loader `config` row still wins.
 */
function readLocalConfig() {
  try {
    return JSON.parse(fsSync.readFileSync(path.join(HERE, 'gee.config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function settings(config) {
  const raw = { ...readLocalConfig(), ...(config ?? {}) };
  return {
    python: typeof raw.python === 'string' && raw.python.trim() ? raw.python.trim() : 'python',
    home: typeof raw.home === 'string' ? raw.home.trim() : '',
    project: typeof raw.project === 'string' ? raw.project.trim() : '',
    proxy: typeof raw.proxy === 'string' ? raw.proxy.trim() : '',
    timeoutMs: Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : 120_000,
    approval: raw.approval === 'off' ? 'off' : 'ask',
    outDir: typeof raw.outDir === 'string' ? raw.outDir.trim() : '',
  };
}

function truncateJson(value) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text === undefined) return { text: 'null', truncated: false };
  if (text.length <= MAX_EVAL_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_EVAL_CHARS)}…`, truncated: true };
}

export function apply(ctx, config) {
  const cfg = settings(config);
  const workerScript = path.join(HERE, 'worker.py');

  /**
   * Runtime output must not live in the install directory: a bundle installed
   * into a profile sits outside the agent's workspace, where the sandboxed
   * worker cannot write. The session working directory is the only reliable
   * root, so it is resolved per call; `outDir` overrides it and temp is the
   * last resort.
   */
  function outRootFor(exec) {
    let cwd = '';
    try {
      cwd =
        (exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd) ||
        '';
    } catch {
      cwd = '';
    }
    for (const dir of [cfg.outDir, cwd]) {
      if (typeof dir !== 'string' || dir === '') continue;
      try {
        fsSync.mkdirSync(dir, { recursive: true });
        fsSync.accessSync(dir, fsSync.constants.W_OK);
        return dir;
      } catch {
        // try the next candidate
      }
    }
    return os.tmpdir();
  }

  let child;
  let buffer = '';
  let sequence = 0;
  let stderrTail = '';
  const pending = new Map();

  function settle(line) {
    let reply;
    try {
      reply = JSON.parse(line);
    } catch {
      return;
    }
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.ok) entry.resolve(reply.result);
    else entry.reject(new Error(reply.error ?? 'Earth Engine worker failed'));
  }

  function ensureWorker() {
    if (child && child.exitCode === null && !child.killed) return child;
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' };
    if (cfg.home) {
      // Earth Engine stores its refresh token under ~/.config/earthengine, so a
      // workspace-local HOME keeps the credential inside a writable directory.
      env.USERPROFILE = cfg.home;
      env.HOME = cfg.home;
    }
    if (cfg.proxy) {
      env.HTTPS_PROXY = cfg.proxy;
      env.HTTP_PROXY = cfg.proxy;
      env.ALL_PROXY = cfg.proxy;
    }
    child = spawn(cfg.python, [workerScript], {
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) settle(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });
    child.on('error', (error) => {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
    });
    child.on('exit', (code) => {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(
          new Error(`Earth Engine worker exited (code ${code})${stderrTail ? `: ${stderrTail.trim().slice(-500)}` : ''}`),
        );
      }
      pending.clear();
      child = undefined;
      buffer = '';
    });
    return child;
  }

  function call(op, args, signal) {
    const worker = ensureWorker();
    const id = String(++sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // A timed-out computation keeps the worker busy, so every later call
        // would queue behind it. Kill it and let the next call spawn a fresh one.
        stderrTail = '';
        if (child) {
          try {
            child.kill();
          } catch {
            // already gone
          }
          child = undefined;
        }
        buffer = '';
        reject(new Error(`Earth Engine worker timed out after ${cfg.timeoutMs} ms during ${op}`));
      }, cfg.timeoutMs);
      pending.set(id, { resolve, reject, timer });
      if (signal) {
        if (signal.aborted) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new Error('aborted'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            const entry = pending.get(id);
            if (!entry) return;
            pending.delete(id);
            clearTimeout(entry.timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      }
      worker.stdin.write(`${JSON.stringify({ id, op, args })}\n`, (error) => {
        if (!error) return;
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /**
   * Persist the exact snippet a tool is about to run, so every result has a
   * rerunnable file behind it and the user can review the code afterwards.
   */
  async function recordScript(kind, code, meta, exec) {
    try {
      return await writeScript(kind, code, meta, exec);
    } catch {
      // The audit file is best effort: a read-only workspace must not fail the call.
      return undefined;
    }
  }

  async function writeScript(kind, code, meta, exec) {
    const dir = path.join(outRootFor(exec), 'scripts');
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const header = [
      `# dsh-gee ${kind} - ${new Date().toISOString()}`,
      `# project: ${cfg.project || '(default)'}`,
      meta && meta.region ? `# region: ${JSON.stringify(meta.region)}` : '',
      meta && meta.scale ? `# scale: ${meta.scale}` : '',
      meta && meta.name ? `# layer/task: ${meta.name}` : '',
      '# Exact snippet executed by the dsh-gee worker.',
      '',
    ].filter(Boolean).join('\n');
    const file = path.join(dir, `gee-${stamp}-${kind}.py`);
    await fs.writeFile(file, `${header}${String(code).trim()}\n`);
    return file;
  }

  /**
   * Gate a side-effecting call behind the session approval seam. Fail closed:
   * without the service, or with anything but `allowed-once`, the call refuses.
   */
  async function confirm(exec, action) {
    if (cfg.approval === 'off') return;
    const approval = ctx.get('approval');
    if (!approval) throw new Error(`Refusing ${action}: no approval service in this profile.`);
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      reason: `${action} (dsh-gee)`,
      signal: exec.signal,
    });
    if (outcome !== 'allowed-once') {
      throw new Error(
        `Refusing ${action}: approval ${outcome}. Switch the session permission preset to one that asks ` +
          '(approval policy "ask"), or set approval: "off" in this plugin config.',
      );
    }
  }

  ctx.tools.register({
    name: 'gee_status',
    description:
      'Verify local Earth Engine credentials and inspect plugin state: credential file, Cloud project, proxy, worker ' +
      'interpreter, Earth Engine version, and whether a trivial server-side computation succeeds. Call this when any ' +
      'gee_* tool fails.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          python: { type: 'string' },
          ee_version: { type: 'string' },
          credentials: { type: 'string' },
          has_credentials: { type: 'boolean' },
          project: { type: 'string' },
          proxy: { type: 'string' },
          init: { type: 'boolean' },
          error: { type: 'string' },
        },
        required: ['credentials', 'has_credentials', 'project', 'proxy'],
      },
      render: (_args, value) => {
        const lines = [
          `python: ${value.python ?? 'unknown'}`,
          `earthengine-api: ${value.ee_version ?? 'missing'}`,
          `credentials: ${value.credentials} (${value.has_credentials ? 'present' : 'missing'})`,
          `project: ${value.project || '(default)'}`,
          `proxy: ${value.proxy || '(none)'}`,
        ];
        if (value.init === true) lines.push('server round-trip: ok');
        else if (value.init === false) lines.push('server round-trip: failed');
        if (value.error) lines.push(`error: ${value.error}`);
        lines.push(`webServer.register: ${value.web_server ?? 'undefined'}`);
        lines.push(`origin: ${value.origin || '(none)'}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(_args, exec) {
      const value = await call('status', { project: cfg.project }, exec.signal);
      return {
        ...value,
        project: cfg.project || value.project || '',
        web_server: typeof ctx.webServer?.register,
        origin: (() => {
          try {
            return ctx.webServer?.getOrigin?.() ?? '';
          } catch {
            return '';
          }
        })(),
      };
    },
  });

  ctx.tools.register({
    name: 'gee_eval',
    description:
      'Run Python code against Google Earth Engine and return the JSON value left in `result`. The code executes in a ' +
      'persistent worker whose only prelude is `import ee`; assign Earth Engine objects or plain values to `result` and ' +
      'the worker serializes them. Use it for catalog lookups, collection filtering, reduceRegion statistics, and asset ' +
      'metadata.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'Python statements with `ee` available. Set `result`, for example: `col = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterDate("2024-06-01", "2024-07-01")` then `result = col.size()`',
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          result: { type: 'string' },
          truncated: { type: 'boolean' },
          script: { type: 'string' },
          images: { type: 'array', items: { type: 'object' } },
        },
        required: ['result', 'truncated'],
      },
      render: (_args, value) => {
        const blocks = [
          {
            type: 'text',
            text:
              (value.truncated ? `${value.result}\n\n(truncated)` : value.result) +
              (value.script ? `\n\nscript: ${value.script}` : ''),
          },
        ];
        for (const image of value.images ?? []) blocks.push({ type: 'image', attachment: image });
        return blocks;
      },
    },
    async execute(args, exec) {
      const code = String(args.code ?? '');
      const script = await recordScript('eval', code, {}, exec);
      const value = await call(
        'eval',
        { code, project: cfg.project, cache: path.join(outRootFor(exec), '.gee-cache') },
        exec.signal,
      );
      const { text, truncated } = truncateJson(value.json);
      const images = [];
      for (const figure of value.figures ?? []) {
        try {
          const bytes = await fs.readFile(figure);
          images.push(
            await ctx.attachments.saveImage({ data: new Uint8Array(bytes), mediaType: 'image/png', name: 'gee-plot.png' }),
          );
        } catch {
          // a figure that cannot be read is not worth failing the call
        }
        await fs.rm(figure, { force: true }).catch(() => {});
      }
      return {
        result: text,
        truncated,
        ...(script ? { script } : {}),
        ...(images.length > 0 ? { images } : {}),
      };
    },
  });

  ctx.tools.register({
    name: 'gee_preview',
    description:
      'Render an Earth Engine image as a PNG and show it in the conversation. The Python snippet must leave an ' +
      'ee.Image in `result`; call `.mosaic()` or `.first()` on an ImageCollection first. Returns the image, its ' +
      'dimensions, and the thumbnail URL.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'Python statements leaving an ee.Image in `result`. Example: `result = ee.Image("LANDSAT/LC09/C02/T1_L2/LC09_123032_20240601").select(["SR_B4","SR_B3","SR_B2"]).multiply(0.0000275).add(-0.2)`',
        },
        bands: {
          type: 'array',
          items: { type: 'string' },
          description: 'Bands to render, in RGB order. Omit to use the image defaults.',
        },
        min: { type: 'number', description: 'Lower stretch bound.' },
        max: { type: 'number', description: 'Upper stretch bound.' },
        palette: {
          type: 'array',
          items: { type: 'string' },
          description: 'Palette for a single-band image, for example NDVI colors or a terrain ramp.',
        },
        region: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional [west, south, east, north] in degrees to crop the preview.',
        },
        dimensions: { type: 'integer', description: 'Longest side in pixels, 64-2048. Default 768.' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          url: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
          path: { type: 'string' },
          script: { type: 'string' },
          attachment: { type: 'object' },
        },
        required: ['url', 'width', 'height', 'bytes', 'path', 'attachment'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `Rendered ${value.width}x${value.height} PNG (${Math.max(1, Math.round(value.bytes / 1024))} KiB) → ${value.path ?? value.url}` +
            (value.script ? `\nscript: ${value.script}` : ''),
        },
        { type: 'image', attachment: value.attachment },
      ],
      presentationMeta: (_args, value) => ({ path: value.path, url: value.url }),
    },
    presentResult: (_args, result) => ({
      card: 'generic',
      title: 'Earth Engine preview',
      content: result.content,
    }),
    async execute(args, exec) {
      const script = await recordScript('preview', String(args.code ?? ''), {
        region: Array.isArray(args.region) ? args.region : undefined,
      }, exec);
      const preview = await call(
        'preview',
        {
          code: String(args.code ?? ''),
          project: cfg.project,
          cache: path.join(outRootFor(exec), '.gee-cache'),
          bands: Array.isArray(args.bands) ? args.bands : undefined,
          min: Number.isFinite(args.min) ? args.min : undefined,
          max: Number.isFinite(args.max) ? args.max : undefined,
          palette: Array.isArray(args.palette) ? args.palette : undefined,
          region: Array.isArray(args.region) ? args.region : undefined,
          dimensions: Number.isFinite(args.dimensions) ? args.dimensions : undefined,
        },
        exec.signal,
      );
      try {
        const bytes = await fs.readFile(preview.path);
        const attachment = await ctx.attachments.saveImage({
          data: new Uint8Array(bytes),
          mediaType: 'image/png',
          name: 'gee-preview.png',
        });
        const previews = path.join(outRootFor(exec), 'previews');
        await fs.mkdir(previews, { recursive: true });
        const file = path.join(previews, `gee-${Date.now()}.png`);
        await fs.writeFile(file, bytes);
        return {
          url: preview.url,
          width: attachment.width,
          height: attachment.height,
          bytes: attachment.bytes,
          path: file,
          ...(script ? { script } : {}),
          attachment,
        };
      } finally {
        await fs.rm(preview.path, { force: true }).catch(() => {});
      }
    },
  });

  ctx.tools.register({
    name: 'gee_catalog',
    description:
      'Search the Earth Engine STAC data catalog for dataset ids. Match keywords against dataset id, title, and ' +
      'keywords; use it before writing analysis code instead of guessing collection names. The first call builds a ' +
      'cached index of every published dataset (about 60-90 s); later calls are instant for 7 days.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords to match, e.g. "sentinel-2 surface reflectance" or "landsat 8". Omit to list datasets.',
        },
        limit: { type: 'integer', description: 'Maximum matches to return, 1-50. Default 20.' },
        type: {
          type: 'string',
          enum: ['image_collection', 'image', 'table'],
          description: 'Only return datasets of this Earth Engine type.',
        },
        refresh: { type: 'boolean', description: 'Rebuild the cached catalog index even if it is still fresh.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          total: { type: 'integer' },
          returned: { type: 'integer' },
          catalog_size: { type: 'integer' },
          rebuilt: { type: 'boolean' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                type: { type: 'string' },
                keywords: { type: 'array', items: { type: 'string' } },
                summary: { type: 'string' },
                deprecated: { type: 'boolean' },
              },
            },
          },
        },
        required: ['total', 'returned', 'matches'],
      },
      render: (_args, value) => {
        const header = `${value.returned}/${value.total} matches (catalog ${value.catalog_size} datasets${value.rebuilt ? ', rebuilt' : ''})`;
        const rows = (value.matches ?? []).map((item) => {
          const tags = [item.type, item.deprecated ? 'deprecated' : null].filter(Boolean).join(', ');
          return `- ${item.id}${tags ? ` [${tags}]` : ''}\n  ${item.title}\n  ${item.summary ?? ''}`;
        });
        return [{ type: 'text', text: [header, ...rows].join('\n') }];
      },
    },
    async execute(args, exec) {
      return call(
        'catalog',
        {
          query: String(args.query ?? ''),
          limit: Number.isFinite(args.limit) ? args.limit : undefined,
          type: typeof args.type === 'string' ? args.type : undefined,
          refresh: Boolean(args.refresh),
          cache: path.join(outRootFor(exec), '.gee-cache'),
        },
        exec.signal,
      );
    },
  });

  ctx.tools.register({
    name: 'gee_export',
    description:
      'Start a batch export of an Earth Engine image to Google Drive or to an Earth Engine asset. The Python snippet ' +
      'must leave an ee.Image in `result`. Returns a task id immediately; the export runs on Earth Engine servers, so ' +
      'poll it with gee_tasks.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Python statements leaving an ee.Image in `result`, for example `result = img.select(["B4","B3","B2"])`.',
        },
        description: { type: 'string', description: 'Task description shown in the Earth Engine task list.' },
        destination: {
          type: 'string',
          enum: ['drive', 'asset'],
          description: 'Where to write: a Google Drive folder or an Earth Engine asset.',
        },
        region: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional [west, south, east, north] to export; omit for the image footprint.',
        },
        scale: { type: 'number', description: 'Output resolution in metres per pixel.' },
        maxPixels: { type: 'integer', description: 'Maximum pixels to export. Default 1e10.' },
        folder: { type: 'string', description: 'Drive folder name (destination "drive").' },
        fileNamePrefix: { type: 'string', description: 'Drive file name prefix (destination "drive").' },
        assetId: {
          type: 'string',
          description: 'Destination asset id, e.g. projects/<project>/assets/<name> (destination "asset").',
        },
      },
      required: ['code', 'description', 'destination'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          task_id: { type: 'string' },
          destination: { type: 'string' },
          status: { type: 'object', additionalProperties: true },
        },
        required: ['task_id', 'destination'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Export task ${value.task_id} started → ${value.destination} (state: ${value.status?.state ?? 'unknown'}). Poll with gee_tasks.`,
        },
      ],
    },
    async execute(args, exec) {
      await confirm(exec, `export to ${args.destination === 'asset' ? 'asset' : 'drive'}: ${args.description || 'unnamed'}`);
      await recordScript('export', String(args.code ?? ''), {
        region: Array.isArray(args.region) ? args.region : undefined,
        scale: Number.isFinite(args.scale) ? args.scale : undefined,
        name: typeof args.description === 'string' ? args.description : undefined,
      }, exec);
      return call(
        'export',
        {
          code: String(args.code ?? ''),
          description: String(args.description ?? 'dsh-gee-export'),
          destination: args.destination === 'asset' ? 'asset' : 'drive',
          project: cfg.project,
          region: Array.isArray(args.region) ? args.region : undefined,
          scale: Number.isFinite(args.scale) ? args.scale : undefined,
          maxPixels: Number.isFinite(args.maxPixels) ? args.maxPixels : undefined,
          folder: typeof args.folder === 'string' ? args.folder : undefined,
          fileNamePrefix: typeof args.fileNamePrefix === 'string' ? args.fileNamePrefix : undefined,
          assetId: typeof args.assetId === 'string' ? args.assetId : undefined,
        },
        exec.signal,
      );
    },
  });

  ctx.tools.register({
    name: 'gee_tasks',
    description:
      'List Earth Engine batch tasks, read one task status, or cancel a running task. Use it after gee_export to see ' +
      'whether the export finished, and to clean up tasks that are stuck.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'status', 'cancel'], description: 'Operation to perform.' },
        task_id: { type: 'string', description: 'Task id for action "status" or "cancel".' },
        limit: { type: 'integer', description: 'Maximum tasks to list, 1-100. Default 20.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
          count: { type: 'integer' },
          id: { type: 'string' },
          status: { type: 'object', additionalProperties: true },
          cancelled: { type: 'boolean' },
        },
        required: [],
      },
      render: (_args, value) => {
        if (Array.isArray(value.tasks)) {
          const rows = value.tasks.map(
            (task) => `- ${task.id} ${task.state ?? '?'} ${task.description ?? ''}${task.error ? ` (${task.error})` : ''}`,
          );
          return [{ type: 'text', text: [`${value.tasks.length} of ${value.count ?? value.tasks.length} tasks`, ...rows].join('\n') }];
        }
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    },
    async execute(args, exec) {
      return call(
        'tasks',
        {
          action: typeof args.action === 'string' ? args.action : 'list',
          task_id: typeof args.task_id === 'string' ? args.task_id : undefined,
          limit: Number.isFinite(args.limit) ? args.limit : undefined,
          project: cfg.project,
        },
        exec.signal,
      );
    },
  });

  ctx.tools.register({
    name: 'gee_assets',
    description:
      'Work with Earth Engine assets: list a folder, inspect one asset, move/rename it, or delete it. Paths look like ' +
      'projects/<project>/assets/<name>. Deleting is irreversible — confirm the asset id first.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'info', 'move', 'delete'], description: 'Operation to perform.' },
        path: {
          type: 'string',
          description: 'Folder to list, defaulting to projects/<project>/assets.',
        },
        asset_id: { type: 'string', description: 'Asset id for "info", "move", or "delete".' },
        destination: { type: 'string', description: 'New asset id for "move".' },
        limit: { type: 'integer', description: 'Maximum assets to list, 1-1000. Default 100.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          parent: { type: 'string' },
          assets: { type: 'array', items: { type: 'object', additionalProperties: true } },
          next_page_token: { type: 'string' },
          asset: { type: 'object', additionalProperties: true },
          deleted: { type: 'string' },
          moved: { type: 'string' },
          destination: { type: 'string' },
        },
        required: [],
      },
      render: (_args, value) => {
        if (Array.isArray(value.assets)) {
          const rows = value.assets.map((asset) => {
            const size = asset.size_bytes ? ` ${Math.round(Number(asset.size_bytes) / 1024)} KiB` : '';
            return `- ${asset.name} [${asset.type ?? '?'}]${size}`;
          });
          const footer = value.next_page_token ? '\n(more available; raise limit)' : '';
          return [{ type: 'text', text: [`${value.parent}`, ...rows].join('\n') + footer }];
        }
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    },
    async execute(args, exec) {
      if (args.action === 'delete' || args.action === 'move') {
        await confirm(exec, `${args.action} ${args.asset_id || ''}`);
      }
      return call(
        'assets',
        {
          action: typeof args.action === 'string' ? args.action : 'list',
          path: typeof args.path === 'string' ? args.path : undefined,
          asset_id: typeof args.asset_id === 'string' ? args.asset_id : undefined,
          destination: typeof args.destination === 'string' ? args.destination : undefined,
          limit: Number.isFinite(args.limit) ? args.limit : undefined,
          project: cfg.project,
        },
        exec.signal,
      );
    },
  });

  ctx.tools.register({
    name: 'gee_download',
    description:
      'Download a bounded Earth Engine image straight into the workspace as a GeoTIFF, with no Google Drive or Cloud Storage ' +
      'involved. Earth Engine caps one synchronous download at roughly 32 MB, so use gee_export for province-wide 10 m ' +
      'imagery; 500 m MODIS or a few Sentinel-2 scenes fit comfortably.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python statements leaving an ee.Image in `result`.' },
        name: { type: 'string', description: 'File name stem under exports/. Defaults to gee-export.' },
        region: { type: 'array', items: { type: 'number' }, description: 'Optional [west, south, east, north].' },
        scale: { type: 'number', description: 'Metres per pixel. Default 500.' },
        bands: { type: 'array', items: { type: 'string' }, description: 'Bands to write.' },
        crs: { type: 'string', description: 'Optional target CRS, for example EPSG:32649.' },
        clipAsset: {
          type: 'string',
          description:
            'Optional Earth Engine table asset id used as a boundary: pixels outside it become nodata. Clipping happens locally because Earth Engine drops clip() masks on GeoTIFF download.',
        },
        nodata: { type: 'number', description: 'Fill value for pixels outside clipAsset. Default -32768.' },
        chunked: {
          type: 'boolean',
          description: 'Split the region into a grid, download each tile, and mosaic them locally. Required for regions whose single download would exceed ~32 MB.',
        },
        chunkPixels: {
          type: 'integer',
          description: 'Edge length of one chunk tile in pixels when chunked is true. Default 2048 (~4M pixels per request).',
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string' },
          bytes: { type: 'integer' },
          url: { type: 'string' },
          chunks: { type: 'integer' },
          bands: { type: 'integer' },
          inside_fraction: { type: 'number' },
          script: { type: 'string' },
        },
        required: ['path', 'bytes'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `Saved ${(value.bytes / 1048576).toFixed(2)} MiB GeoTIFF -> ${value.path}` +
            (value.script ? `\nscript: ${value.script}` : ''),
        },
      ],
    },
    async execute(args, exec) {
      const chunked = Boolean(args.chunked);
      if (chunked && typeof args.clipAsset === 'string') {
        throw new Error('clipAsset is not supported with chunked downloads yet; download the bbox and clip it locally, or download without chunking');
      }
      if (chunked) await confirm(exec, `chunked download ${args.name || 'gee-export'}`);
      const script = await recordScript('download', String(args.code ?? ''), {
        region: Array.isArray(args.region) ? args.region : undefined,
        scale: Number.isFinite(args.scale) ? args.scale : 500,
        name: typeof args.name === 'string' ? args.name : undefined,
      }, exec);
      const downloaded = await call(
        chunked ? 'download_grid' : 'download',
        {
          code: String(args.code ?? ''),
          project: cfg.project,
          region: Array.isArray(args.region) ? args.region : undefined,
          scale: Number.isFinite(args.scale) ? args.scale : undefined,
          bands: Array.isArray(args.bands) ? args.bands : undefined,
          crs: typeof args.crs === 'string' ? args.crs : undefined,
          chunkPixels: Number.isFinite(args.chunkPixels) ? args.chunkPixels : undefined,
          clipAsset: typeof args.clipAsset === 'string' ? args.clipAsset : undefined,
          nodata: Number.isFinite(args.nodata) ? args.nodata : undefined,
          cache: path.join(outRootFor(exec), '.gee-cache'),
        },
        exec.signal,
      );
      const exportsDir = path.join(outRootFor(exec), 'exports');
      await fs.mkdir(exportsDir, { recursive: true });
      const stem = (typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'gee-export').replace(/[^\w.-]+/g, '-');
      const target = path.join(exportsDir, `${stem}-${Date.now()}.tif`);
      await fs.copyFile(downloaded.path, target);
      await fs.rm(downloaded.path, { force: true }).catch(() => {});
      const result = { path: target, bytes: downloaded.bytes, ...(script ? { script } : {}) };
      if (typeof downloaded.url === 'string') result.url = downloaded.url;
      if (Number.isFinite(downloaded.chunks)) result.chunks = downloaded.chunks;
      if (Number.isFinite(downloaded.bands)) result.bands = downloaded.bands;
      if (Number.isFinite(downloaded.inside_fraction)) result.inside_fraction = downloaded.inside_fraction;
      return result;
    },
  });

  // ---- interactive map: a session-wide layer stack served to the Web panel ----

  const layers = [];
  let layerSeq = 0;

  const publicLayer = (layer) => ({ id: layer.id, name: layer.name, url: layer.url, kind: layer.kind });

  function tileTemplate(mapName) {
    return `https://earthengine.googleapis.com/v1/${mapName}/tiles/{z}/{x}/{y}`;
  }

  function visual(args) {
    const vis = {};
    if (Array.isArray(args.bands) && args.bands.length > 0) vis.bands = args.bands.slice(0, 3);
    if (Number.isFinite(args.min)) vis.min = args.min;
    if (Number.isFinite(args.max)) vis.max = args.max;
    if (Array.isArray(args.palette) && args.palette.length > 0) vis.palette = args.palette.slice(0, 64);
    return vis;
  }

  function sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  }

  ctx.tools.register({
    name: 'gee_layer',
    description:
      'Add an Earth Engine image to the interactive map in the "GEE" panel as a layer, remove one layer, clear the ' +
      'stack, or list layers. The Python snippet must leave an ee.Image in `result`. Layers stay for the whole app ' +
      'session and render as tiles in the browser. Call it for every spatial result, not only when the user asks ' +
      'for a map: a preview PNG cannot be panned or blended.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove', 'clear', 'list'], description: 'Operation to perform.' },
        name: { type: 'string', description: 'Layer name shown in the panel (action "add").' },
        code: { type: 'string', description: 'Python statements leaving an ee.Image in `result` (action "add").' },
        bands: { type: 'array', items: { type: 'string' }, description: 'RGB bands for "add".' },
        min: { type: 'number', description: 'Lower stretch bound for "add".' },
        max: { type: 'number', description: 'Upper stretch bound for "add".' },
        palette: { type: 'array', items: { type: 'string' }, description: 'Palette for a single-band layer.' },
        layer_id: { type: 'string', description: 'Layer id for "remove".' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          layers: { type: 'array', items: { type: 'object', additionalProperties: true } },
          layer: { type: 'object', additionalProperties: true },
          removed: { type: 'string' },
        },
        required: ['layers'],
      },
      render: (_args, value) => {
        if (value.layer) {
          return [{ type: 'text', text: `Layer "${value.layer.name}" added as ${value.layer.id}; ${value.layers.length} layers on the map.` }];
        }
        if (value.removed) return [{ type: 'text', text: `Removed ${value.removed}; ${value.layers.length} layers left.` }];
        const names = value.layers.map((layer) => `${layer.id}=${layer.name}`).join(', ');
        return [{ type: 'text', text: names ? `${value.layers.length} layers: ${names}` : 'The map has no layers.' }];
      },
    },
    async execute(args, exec) {
      const action = typeof args.action === 'string' ? args.action : 'list';
      if (action === 'add') {
        if (typeof args.name !== 'string' || typeof args.code !== 'string') throw new Error('add needs name and code');
        const mapped = await call(
          'map',
          { code: args.code, project: cfg.project, ...visual(args) },
          exec.signal,
        );
        const layer = { id: `l${++layerSeq}`, name: args.name, url: tileTemplate(mapped.map), kind: 'tool' };
        layers.push(layer);
        return { layer: publicLayer(layer), layers: layers.map(publicLayer) };
      }
      if (action === 'remove') {
        const index = layers.findIndex((layer) => layer.id === args.layer_id);
        if (index < 0) throw new Error(`no layer with id ${args.layer_id}`);
        const [removed] = layers.splice(index, 1);
        return { removed: removed.id, layers: layers.map(publicLayer) };
      }
      if (action === 'clear') {
        layers.length = 0;
        return { layers: [] };
      }
      return { layers: layers.map(publicLayer) };
    },
  });

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/gee',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        try {
          if (pathname === '/gee/state') {
            return sendJson(res, 200, { layers: layers.map(publicLayer) });
          }
          if (pathname === '/gee/assets') {
            const page = await call('assets', {
              action: 'list',
              path: url.searchParams.get('path') || undefined,
              project: cfg.project,
              limit: 200,
            });
            return sendJson(res, 200, page);
          }
          if (pathname === '/gee/asset-layer') {
            const asset = url.searchParams.get('name');
            if (!asset) return sendJson(res, 400, { error: 'name is required' });
            const mapped = await call('asset_layer', { asset, project: cfg.project });
            const layer = {
              id: `l${++layerSeq}`,
              name: asset.split('/').pop() || asset,
              url: tileTemplate(mapped.map),
              kind: 'asset',
            };
            layers.push(layer);
            return sendJson(res, 200, publicLayer(layer));
          }
          if (pathname === '/gee/layer/remove') {
            const id = url.searchParams.get('id');
            const index = layers.findIndex((layer) => layer.id === id);
            if (index >= 0) layers.splice(index, 1);
            return sendJson(res, 200, { layers: layers.map(publicLayer) });
          }
          if (pathname.startsWith('/gee/vendor/')) {
            const name = pathname.slice('/gee/vendor/'.length);
            if (name !== 'leaflet.js' && name !== 'leaflet.css') {
              return sendJson(res, 404, { error: 'not found' });
            }
            const file = await fs.readFile(path.join(HERE, 'vendor', name));
            res.statusCode = 200;
            res.setHeader('content-type', name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
            res.setHeader('cache-control', 'max-age=3600');
            res.end(file);
            return undefined;
          }
          return sendJson(res, 404, { error: 'not found' });
        } catch (error) {
          return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    }),
  );

  // Ship a skill so the *user's* agent gets the workflow; AGENTS.md only serves
  // development inside this repository.
  const skills = ctx.get('skills');
  if (skills) {
    try {
      const content = fsSync.readFileSync(path.join(HERE, 'skill.md'), 'utf8');
      ctx.effect(() =>
        skills.register({
          name: 'earth-engine',
          description:
            'Google Earth Engine workflows: choose a dataset, run Python analysis, render a preview, download or export, manage assets.',
          whenToUse:
            'Any task involving Earth Engine or satellite rasters: NDVI, DEM, land cover, imagery, provincial or county statistics.',
          content,
          source: 'runtime',
        }),
      );
    } catch {
      // The skill is optional; the tools still work without it.
    }
  }
}
