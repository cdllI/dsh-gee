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

The agent has shell access, so it does the setup end to end:

1. clones the repository and installs the bundle (`install_bundle` with its `dsh-gee/` directory)
2. creates a virtual environment and installs `earthengine-api` into it
3. runs `earthengine authenticate` and gives you the browser link
4. writes `dsh-gee/gee.config.json` — interpreter, project, proxy if your network needs one
5. calls `gee_status` until the server round-trip passes

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
- Python 3.10+ with `earthengine-api` installed, reachable from the Harness process.
- A Google Cloud project with Earth Engine enabled and registered for your account.
- On networks where Google is blocked: an HTTPS proxy reachable from the same machine.

The Earth Engine Node client is deliberately not used. It cannot authenticate with the refresh-token
file that `earthengine authenticate` writes, and it ignores `HTTPS_PROXY`. A Python worker is the only
path that handles both, and it exposes the full batch and asset API.

## Install

### 1. Get a Python with Earth Engine

```bash
python -m venv .venv
.venv/bin/pip install earthengine-api
# Windows: .venv\Scripts\pip install earthengine-api
```

### 2. Authenticate

```bash
.venv/bin/earthengine authenticate
```

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
  "proxy": "http://127.0.0.1:7890",
  "home": "",
  "approval": "ask",
  "timeoutMs": 180000
}
```

| Key | Meaning | Default |
|---|---|---|
| `python` | Interpreter with `earthengine-api`. | `python` on `PATH` |
| `project` | Cloud project that owns the Earth Engine quota. Also read from the credential file when present. | none |
| `proxy` | Exported to the worker as `HTTPS_PROXY` and `HTTP_PROXY`. | empty |
| `home` | Sets `USERPROFILE` and `HOME` for the worker so the credential can live outside your real home. | inherit |
| `approval` | `ask` gates exports, asset deletes and moves, and chunked downloads behind the Harness approval seam. `off` runs them without asking. | `ask` |
| `timeoutMs` | Per-call worker timeout. | `120000` |

The bundle's Loader patch stays empty on purpose. A `config` row in your profile still overrides this
file, so nothing in the repository carries local paths.

### 4. Install the bundle

Install this directory as a bundle through the Harness plugin manager (`install_bundle` with the
absolute path to `dsh-gee/`), or add the equivalent row to your profile patch. Reload the page
afterwards so the client half is picked up.

### 5. Verify

Ask the agent for `gee_status`. A healthy install reports the credential path, the project, the proxy,
and `server round-trip: ok`.

## Usage

```python
# gee_eval: the value left in `result` is serialised back as JSON
col = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterDate("2024-06-01", "2024-07-01")
result = col.size()
```

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
- `gee_export`, `gee_assets delete` and `move`, and chunked `gee_download` ask for approval first. The
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
