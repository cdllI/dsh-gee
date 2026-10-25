# Google Earth Engine

Use the `gee_*` tools. Every snippet is **Python** executed in a persistent worker with `ee` already in
scope; the value you assign to `result` comes back as JSON. Never `import ee` and never pass a callback.

```python
col = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterDate("2024-06-01", "2024-07-01")
result = col.size()          # -> 42
```

When anything fails, call `gee_status` first. It separates bad credentials, a missing project, an
unreachable proxy and a dead worker in one call.

## Pick the tool

| Situation | Tool |
|---|---|
| Do not know the collection id | `gee_catalog` |
| Need a number, table or JSON | `gee_eval` |
| Need to see an image | `gee_preview` |
| Need the image on the interactive map | `gee_layer` |
| Need a local file | `gee_download` |
| Need a big, repeatable job | `gee_export` then `gee_tasks` |
| Need to inspect or clean assets | `gee_assets` |
| Anything is broken | `gee_status` |

## Datasets

Never guess a collection id from memory. Search, then copy the returned `id` verbatim:

```
gee_catalog query="sentinel-2 surface reflectance" type=image_collection limit=5
```

The first call builds the index (60-90 s); later calls are instant for a week. Common ids worth
confirming once and reusing: `COPERNICUS/S2_SR_HARMONIZED`, `LANDSAT/LC09/C02/T1_L2`,
`MODIS/061/MOD13A1`, `MODIS/061/MOD11A2`, `USGS/SRTMGL1_003`, `NASA/NASADEM_HGT/001`.

Boundaries: `FAO/GAUL/2025/level1` for provinces (`ADM1_NAME`, for example `Shanxi Sheng`),
`FAO/GAUL/2025/level2` for cities (`ADM2_NAME`), or a table asset under `projects/<project>/assets`.

**Charts.** A matplotlib figure left open at the end of a `gee_eval` snippet is captured and shown to the
user as an image. Use it for scatters, histograms and time series; do not try to return pixels as JSON.
`matplotlib` must be installed in the worker environment (it usually is in a scientific setup).

Draw inside `gee_eval` rather than saving a standalone script: the figure comes back automatically. If you
do save a file, link it with a **workspace-relative** path (`exports/chart.png`); `D:\...` and `file://`
paths do not render in the chat.

## Conventions

- `region=[west, south, east, north]` in degrees, in every tool that takes a region.
- `scale` is metres per pixel: 500-1000 for provincial statistics, 10-30 for field work.
- Always pass `scale` and a `maxPixels` above about `1e9` to `reduceRegion`.
- `bands` is an RGB order list; single-band products take `palette` instead.
- Map layers are in memory: they disappear when the app restarts. Export what matters.
- `gee_preview` and `gee_layer` need an `ee.Image` in `result`; call `.mosaic()` or `.first()` on a
  collection first.

## Recipes

**Provincial statistic**

```python
adm = ee.FeatureCollection("FAO/GAUL/2025/level1").filter(ee.Filter.eq("ADM1_NAME", "Shanxi Sheng")).first().geometry()
col = ee.ImageCollection("MODIS/061/MOD13A1").filterDate("2024-01-01", "2025-01-01").select("NDVI")
mm = col.mean().multiply(0.0001).reduceRegion(ee.Reducer.mean(), adm, 500, maxPixels=int(1e9))
result = mm.getInfo()
```

Then preview or layer the same image:

```python
result = col.mean().multiply(0.0001).clip(adm)
# gee_preview: palette=["#a6611a","#d8b365","#f5f5c3","#c7eae5","#5ab4ac","#1a7f4b"], min=0.05, max=0.9
```

**True colour**

```python
result = col.median().select(["B4", "B3", "B2"])
# gee_preview: bands=["B4","B3","B2"], min=0, max=3000, region=[116.2,39.8,116.6,40.0], dimensions=900
```

**Boundary-clipped download**

```
gee_download code=<image expression> region=[...] scale=500 clipAsset="projects/<project>/assets/<table>"
```

`clipAsset` clips locally and declares `GDAL_NODATA`. Do not write `image.clip(geom)` and expect the
mask in the file: Earth Engine drops it during GeoTIFF download.

**Large area**

```
gee_download code=<...> region=[...] scale=10 chunked=true chunkPixels=2048
```

Each tile is fetched on one shared affine grid and mosaicked locally, so the result is seamless. The
mosaic uses a mid-latitude degree grid and is therefore not pixel-identical to Earth Engine's own
download grid; do not mix the two in a pixel-wise comparison. `chunked` and `clipAsset` cannot be
combined.

**Batch export**

```
gee_export code=<...> description="shanxi-ndvi-2024" destination=asset
  assetId="projects/<project>/assets/shanxi_ndvi_2024" region=[...] scale=500
```

Returns a task id immediately. Poll with `gee_tasks action=list` (or `action=status task_id=...`).
Exports are asynchronous and can take minutes; do not block on them.

## Pitfalls

| Symptom | Cause and fix |
|---|---|
| `no project found` | Pass a project id, or set it in `gee.config.json`. |
| `Please authorize access` | The refresh token is gone. Re-run `earthengine authenticate --auth_mode localhost`; without that flag the consent page returns `400 invalid_request` because the default out-of-band flow was retired. |
| A call times out | Proxy unreachable. `gee_status` shows what the worker actually received. |
| Download fails immediately | The request is over Earth Engine's ~32 MB synchronous limit. Use `chunked`. |
| Clipped raster is all white in QGIS | No `GDAL_NODATA` in the file. Use `clipAsset`, not `image.clip()`. |
| Mosaic has visible seams | Should not happen; if it does, the chunks did not share one affine. |
| `Refusing ...: approval rejected` | The session approval policy denied a destructive call. Ask the human. |
| Map blank but layers listed | The browser cannot reach `earthengine.googleapis.com`; the Host is fine. |

## Assets

`gee_assets action=list` defaults to `projects/<project>/assets`, `info` returns bands and size without
the footprint, `move` renames, `delete` is irreversible. List first, confirm the exact id, then delete.
