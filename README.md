English | [简体中文](README.zh-CN.md)

# dsh-gee

A Google Earth Engine plugin for DeepSeek Harness (dsh). It gives an agent direct access to Earth
Engine: catalog search, arbitrary Python analysis, interactive map layers, batch exports, asset
management. One long-lived worker owns the Earth Engine session, so authentication and proxies are
handled once rather than per call.


## Quickstart

If you do not have DeepSeek Harness yet, install it first: <https://www.deepseek.com/harness/>.

Then send your agent one line:

> Install the plugin from https://github.com/cdllI/dsh-gee and connect it to my Earth Engine account.

That URL is a **git repository, not an npm package** — a plugin manager cannot consume it directly. It
has to be cloned, and then the `dsh-gee/` directory inside the clone is what gets installed. The agent
does the whole thing:

1. **clone**: `git clone https://github.com/cdllI/dsh-gee`. If this machine reaches GitHub through a
   proxy, export `HTTPS_PROXY` first — git honours it. If the clone fails because the proxy intercepts
   DNS for `github.com`, use the tarball endpoint under [Install](#install)
2. **install the bundle**: `install_bundle` with the absolute path to `<clone>/dsh-gee`. It edits the
   profile, so it needs a full-access approval. Hand-editing `cordis.patch.yml` is not the way — one
   indentation mistake leaves the profile unable to start
3. **environment**: `gee_setup action=install` — finds the Python that DeepSeek Harness ships, builds a
   private virtual environment, and installs `earthengine-api`, `tifffile` and `matplotlib`
4. **authorization**: `gee_setup action=auth` prints a browser link. The `--auth_mode localhost` flow is
   mandatory; the retired out-of-band flow returns `400 invalid_request`
5. **configuration and verification**: pass your Cloud project id to `gee_setup action=verify`, which
   also runs a live round trip through Earth Engine

You do exactly two things: click **Allow** in the browser, and tell it your Cloud project id.

If your agent has no shell access, follow the manual steps under [Install](#install).

## Features

| Tool | What it does |
|---|---|
| `gee_status` | Credentials, project, proxy, worker interpreter, and a server round-trip. Start here when something fails. |
| `gee_eval` | Run Python with `ee` in scope; the value left in `result` comes back as JSON. |
| `gee_preview` | Render an `ee.Image` as a PNG in the conversation, with bands, stretch, palette and region. |
| `gee_catalog` | Keyword search over a cached STAC index of every published dataset (about 1160), so the model stops guessing collection ids. |
| `gee_download` | Download a bounded image straight into the workspace as a GeoTIFF, with no Drive or Cloud Storage involved. Supports `chunked` (grid download plus local mosaic) and `clipAsset` (clip to an asset boundary with a declared nodata value). |
| `gee_export` | Batch export an image to Google Drive or to an Earth Engine asset. Returns a task id. |
| `gee_tasks` | List, inspect, or cancel batch tasks. |
| `gee_assets` | List, inspect, move, or delete assets under `projects/<project>/assets`. |
| `gee_layer` | Add an image to the interactive map panel, remove one, or list the stack. |

The bundle also ships a map panel (left rail, GEE icon): a Leaflet map with the layer stack and an asset
browser that walks `projects/<project>/assets` and adds image assets as layers.

## Requirements

- DeepSeek Harness with the plugin manager.
- Python 3.10+ with `earthengine-api`, `numpy` and `tifffile` installed, reachable from the Harness process.
  `numpy` and `tifffile` are only needed by `clipAsset` and `chunked`; the bootstrap scripts install all
  three.
- A Google Cloud project with Earth Engine enabled and registered for your account.
- On networks where Google is blocked: an HTTPS proxy reachable from the same machine.

The Earth Engine Node client is deliberately not used. It cannot authenticate with the refresh-token
file that `earthengine authenticate` writes, and it ignores `HTTPS_PROXY`. A Python worker is the only
path that handles both, and it exposes the full batch and asset API.

## Install

### One-step setup (Windows)

DeepSeek Harness already ships a Python 3.12 runtime, so nothing has to be installed by hand. Send the
agent one line:

> Run `gee_setup` for this plugin: check, install, auth, verify.

It finds the Harness runtime, builds a private virtual environment, installs `earthengine-api`, `tifffile`
and `matplotlib` (offline when a `wheels/` directory sits next to the plugin), writes `gee.config.json`,
and returns the browser link. You only approve the consent screen and give it your project id.

To install with no network access at all, download `wheels-win-x64.zip` from the
[releases page](https://github.com/cdllI/dsh-gee/releases) and unpack it so that `wheels/*.whl` sits next
to `index.js`; `gee_setup` installs from those files instead of a package index.

The manual steps below are for debugging, or for platforms without a published wheelhouse.

### 1. Get a Python with Earth Engine

```bash
python -m venv .venv
.venv/bin/pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple earthengine-api
# Windows: .venv\Scripts\pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple earthengine-api
```

**Do not route pip through your proxy.** A proxied PyPI download is the slowest part of setup: the same
wheel takes about 12 s to even reach the index directly versus under 1 s through a domestic mirror, and a
full dependency install goes from roughly ten minutes to seconds. The helper scripts do the venv and the
mirror install for you:

```bash
sh tools/bootstrap.sh        # Windows: powershell -File tools\bootstrap.ps1
```

### 2. Authenticate

```bash
.venv/bin/earthengine authenticate --auth_mode localhost
# Windows: .venv\Scripts\earthengine.exe authenticate --auth_mode localhost
```

**`--auth_mode localhost` is not optional.** The client's default redirect is `urn:ietf:wg:oauth:2.0:oob`,
an OAuth flow Google retired in 2022; the consent page answers `Error 400: invalid_request`. The localhost
mode starts a local callback server on port 8085 instead, and that is the only flow that still works. Use
`--auth_mode localhost:0` if 8085 is taken.

This writes a refresh token to `~/.config/earthengine/credentials`. The plugin refreshes access tokens
itself, so you do this once. If the token is later revoked, `gee_status` says so and you re-run the
command.

If the Harness runs where your home directory is not writable (containers, sandboxed hosts), point
`home` at a writable directory and authenticate with the same value:

```bash
USERPROFILE=/writable/dir .venv/bin/earthengine authenticate
# Windows: $env:USERPROFILE='D:\writable\dir'; .venv\Scripts\earthengine authenticate
```

The plugin passes `home` to the worker as `USERPROFILE` and `HOME`, so Earth Engine looks for the
credential there instead.

### 3. Configure

Copy `dsh-gee/gee.config.example.json` to `dsh-gee/gee.config.json` and fill it in. That file is
machine-local and git-ignored, so it never needs to match anyone else's paths.

```json
{
  "python": "/path/to/.venv/bin/python",
  "project": "your-earth-engine-project-id",
  "proxy": "http://<host>:<port>",
  "home": "",
  "approval": "ask",
  "timeoutMs": 180000
}
```

| Key | Meaning | Default |
|---|---|---|
| `python` | Interpreter with `earthengine-api`. `gee_setup` writes this for you and prefers the runtime DeepSeek Harness ships. | `python` on `PATH` |
| `project` | Cloud project that owns the Earth Engine quota. Also read from the credential file when present. | none |
| `proxy` | Exported to the worker as `HTTPS_PROXY` and `HTTP_PROXY`. | empty |
| `home` | Sets `USERPROFILE` and `HOME` for the worker so the credential can live outside your real home. | inherit |
| `approval` | `ask` gates exports, asset deletes and moves, and chunked downloads behind the Harness approval seam. `off` runs them without asking. | `ask` |
| `timeoutMs` | Per-call worker timeout. | `120000` |

The bundle's Loader patch stays empty on purpose. A `config` row in your profile still overrides this
file, so nothing in the repository carries local paths.

### 4. Install the bundle

`https://github.com/cdllI/dsh-gee` is a repository, not an npm package — a plugin manager cannot consume
it as-is. Clone it first, then install the `dsh-gee/` directory inside the clone:

```bash
git clone https://github.com/cdllI/dsh-gee
```

If the machine reaches GitHub through a proxy, export `HTTPS_PROXY` before cloning — the address and
port are yours, not this document's: `export HTTPS_PROXY=http://<host>:<port>` (PowerShell:
`$env:HTTPS_PROXY='http://<host>:<port>'`).

If `web_fetch` refuses `github.com` with `URL hostname resolves to a non-public IP address`, the local
proxy is mapping the name to a private address: clone with the proxy as above, or read files through
`api.github.com` and `raw.githubusercontent.com`, which resolve publicly.

#### When `git clone` cannot reach GitHub

Some local proxies answer DNS for `github.com` with `127.0.0.1`, so `git clone` fails outright and the
proxy flag does not help. The tarball endpoint usually still works:

```bash
curl -L -o dsh-gee.tar.gz https://codeload.github.com/cdllI/dsh-gee/tar.gz/refs/heads/main
tar -xzf dsh-gee.tar.gz     # yields dsh-gee-main/ with the same tree, minus the git history
```

Then install the bundle at the absolute path `<clone>/dsh-gee` — plugin manager → **Install bundle** →
path, or `install_bundle` from the agent. This edits the profile, so it needs a full-access approval.

Do not hand-edit `cordis.patch.yml`; a single indentation mistake leaves the profile unable to start.

#### Without a plugin-manager tool

An agent that has only a shell can use the CLI instead (the `web` profile is CLI-manageable; `desktop`
is reserved for the desktop app):

```bash
dsh plugin --profile web add file:/absolute/path/to/dsh-gee-main/dsh-gee
```

That adds the dependency; the bundle also has to be listed in `dsh.profile.bundles` inside
`$DSH_HOME/profiles/web/package.json`:

```json
{ "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@local/dsh-gee"] } } }
```

Prove the composition before restarting — `dsh --profile web --dump-config | grep dsh-gee` should list the
plugin's rows.

Reload the page afterwards so the client half is picked up; the panel appears in the left rail as **GEE**.

### 5. Verify

Ask the agent for `gee_status`. A healthy install reports the credential path, the project, the proxy,
and `server round-trip: ok`.

## Usage

```python
# gee_eval: the value left in `result` is serialised back as JSON
col = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterDate("2024-06-01", "2024-07-01")
result = col.size()
```

Any matplotlib figure left open by the snippet is captured and attached to the reply as an image, which is
how charts (TVDI dry/wet edges, histograms, time series) reach the user. Install `matplotlib` into the same
Python environment to enable it.

```python
# gee_preview: must leave an ee.Image in `result`
result = col.median().select(["B4", "B3", "B2"])
# bands=["B4","B3","B2"], min=0, max=3000, region=[w, s, e, n], dimensions=900
```

```python
# gee_download: GeoTIFF into ./exports, clipped by an asset boundary, nodata declared
result = ee.Image("USGS/SRTMGL1_003").select("elevation").rename("dem")
# region=[...], scale=500, clipAsset="projects/<project>/assets/<table>"
```

```python
# gee_layer: add the same expression to the map panel
result = col.median().select(["B4", "B3", "B2"])
# name="S2 true colour", bands=[...], min=0, max=3000
```

## Permissions and safety

- Every snippet that runs is written to `scripts/gee-<timestamp>-<kind>.py` with a header naming the
  project, region and scale, and the tool result carries its path, so any result can be traced back to
  the exact code that produced it.
- `gee_export`, `gee_assets delete` / `move`, and chunked `gee_download` ask for approval first. The
  gate fails closed: no approval service, or any outcome other than `allowed-once`, refuses the call.
  Set `"approval": "off"` only for unattended batches.
- The worker executes model-authored Python with your Earth Engine credentials and no additional
  sandbox. Treat this plugin as "the agent may do anything your account can do".

## How it works

```
Harness Host (Node)                  Python worker (persistent)            Google
  dsh-gee/index.js  -- JSON lines -->  worker.py  -- earthengine-api -->  Earth Engine API
    tools, layer stack, HTTP routes      auth, batch, assets, tiles         (through HTTPS_PROXY)
```

- The Host half registers the tools, keeps the layer stack and serves the map panel's HTTP routes.
- The worker owns one initialised Earth Engine session, so each call skips import and auth.
- Map tiles are fetched by the browser straight from `earthengine.googleapis.com`. The map id is
  unguessable and needs no auth, so the Host never proxies tile bytes.
- The panel polls `GET /gee/state` every two seconds. The layer stack is in memory and resets when the
  app restarts.

## Limitations

- `clipAsset` cannot be combined with `chunked`; it refuses instead of silently ignoring the flag.
- The mosaic uses a mid-latitude degree grid, so it is not pixel identical to Earth Engine's own grid.
- Local files cannot become assets: Earth Engine ingestion only accepts `gs://` URIs.

## Development

Setup, reloading and the traps worth remembering live in [AGENTS.md](AGENTS.md). Check a change with:

```bash
node tools/check-plugin.mjs dsh-gee
```

## License

MIT. Earth Engine usage is subject to Google's terms of service; this project only wraps the public API.
