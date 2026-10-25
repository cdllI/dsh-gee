# dsh-gee workspace

## Hard rule: tool schemas

`ctx.tools.register()` forwards `parameters` verbatim to the model, so it must be a **complete
object-rooted JSON Schema**, not a property map:

```js
// correct
parameters: {
  type: 'object',
  properties: { code: { type: 'string', description: '...' } },
  required: ['code'],
  additionalProperties: false,
}

// wrong: every request returns 400 INVALID_REQUEST and the session becomes unusable
parameters: { code: { type: 'string', required: true } }
```

Only `defineTool()` accepts the shorthand (it compiles it). `dsh-tools` validates `output.schema` but
not `parameters`, so the failure appears on the first model request, not at load time.

Run before every reload:

```bash
node tools/check-plugin.mjs dsh-gee
```

## Local setup stays out of the repository

`dsh-gee/gee.config.json` is git-ignored and holds whatever is machine-specific: interpreter path,
project id, proxy, `home`. The committed `cordis.patch.yml` deliberately carries no `config` row, so a
fresh clone never inherits someone else's absolute paths. A `config` row in a profile patch still wins
over the file.

`scripts/`, `exports/`, `dsh-gee/previews/` and `dsh-gee/.cache/` are runtime output and git-ignored too.

## Reloading

- `index.js`, `client.js`, `cordis.patch.yml` → re-apply the bundle, then reload the page for the client
  half.
- `worker.py` → stop the running worker process (the interpreter from `python`) so the next call spawns
  the new code; the Host half does not need a reload for worker-only changes.
- `skill.md` → read once in `apply()`, so the content only changes after the plugin is re-applied.
  `set_bundle` on an already-enabled bundle does not re-run `apply`; toggle it off and on.

## Traps worth remembering

- **Prefix routes must not end with `/`.** `register({kind:'prefix', path:'/gee'})` matches
  `/gee/state`; `/gee/` matches nothing, because matching is `pathname.startsWith(prefix + '/')`.
- **`getDownloadURL` ignores `crsTransform`.** It silently returns a downsampled view of the whole image.
  Use `region` + `scale`, or `ee.data.computePixels` when you need an explicit affine.
- **Per-chunk `region` + `scale` does not tile.** Earth Engine derives a grid per request, so tiles differ
  by fractions of a pixel and a mosaic develops seams. `computePixels` with one shared
  `affineTransform` and per-tile translations is the only reliable way.
- **`image.clip(geometry)` loses its mask on GeoTIFF download.** The file comes back with real values
  outside the polygon. Download `ee.Image().paint(fc, 1)` on the same grid and mask locally.
- **Every GeoTIFF the plugin writes must declare `GDAL_NODATA`.** Without it viewers stretch from the fill
  value and the real data looks blown out.
- **The output validator rejects `null`.** Optional fields must be omitted, not set to `null`; a stray
  `undefined` in a result fails with "value is not lossless JSON".
- **`package.json` must be UTF-8 without BOM.** A BOM fails bundle loading with "Unexpected token".
- **`computePixels` out-of-bounds pixels come back as 0**, not nodata; mask them yourself if the image
  does not cover the requested grid.
## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ee.Initialize: no project found` | `project` missing in both `gee.config.json` and the credential file. |
| `Please authorize access ... earthengine authenticate` | No usable refresh token. Re-run the auth step and check `home`. |
| `400 invalid_request` with `flowName=GeneralOAuthFlow` | `authenticate` ran without `--auth_mode localhost`, so it used the retired out-of-band redirect. |
| `token exchange failed (400)` | Refresh token revoked. Re-authenticate. |
| Every call times out | Proxy wrong or unreachable; `gee_status` shows the value the worker actually received. |
| Layers listed but the map is blank | The browser cannot reach `earthengine.googleapis.com`; the Host side is fine. |
| A clipped GeoTIFF looks white in QGIS | No `GDAL_NODATA` in the file; the plugin always writes one, hand-written scripts often do not. |
| `400 INVALID_REQUEST` on every model turn | A tool `parameters` value is not a complete object-rooted JSON Schema. |
