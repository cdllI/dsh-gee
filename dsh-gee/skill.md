# Earth Engine workflows

Use the `gee_*` tools. Every snippet is Python with `ee` in scope and the value left in `result` is
returned as JSON, so a call looks like:

```python
col = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterDate("2024-06-01", "2024-07-01")
result = col.size()
```

## 1. Find the dataset first

Never guess a collection id. Search the catalog, then read the returned `id` verbatim:

```
gee_catalog query="sentinel-2 surface reflectance" type=image_collection limit=5
```

The first call builds an index (60-90 s); later calls are instant for a week.

## 2. Analysis

- Scale matters: provincial statistics at 500-1000 m, field-scale at 10-30 m. Always pass `scale` to
  `reduceRegion`, and `maxPixels` above roughly 1e9 for anything continental.
- Mask clouds before compositing (`CLOUDY_PIXEL_PERCENTAGE`, `QA60`, or `GOOGLE/CLOUD_SCORE_PLUS`).
- Boundaries come from `FAO/GAUL/2025/level2` (city) or `level1` (province, e.g. `Shanxi Sheng`),
  or from an asset under `projects/<project>/assets`.

## 3. Show it

```
gee_preview code=<image expression> bands=["B4","B3","B2"] min=0 max=3000 region=[w,s,e,n] dimensions=768
```

The snippet must leave an `ee.Image` in `result` (call `.mosaic()` or `.first()` on a collection).
Single-band products take `palette`. A preview writes a PNG to `previews/` and shows it in the chat.

To put the same image on the interactive map panel, call `gee_layer action=add` with the same code
and visualisation arguments. Layers are in-memory and vanish when the app restarts.

## 4. Get the data out

| Need | Tool |
|---|---|
| A local file, small (under about 32 MB) | `gee_download` |
| Something large (province at 10 m) | `gee_download chunked=true chunkPixels=2048`, or `gee_export` |
| A boundary-clipped raster | `gee_download clipAsset="projects/<project>/assets/<table>"` |
| A repeatable task in Drive or as an asset | `gee_export destination=drive|asset` |

`gee_download` writes into `exports/` and always declares `GDAL_NODATA`. `clipAsset` clips locally:
Earth Engine drops the mask of `image.clip(geometry)` on GeoTIFF download, so never rely on it.

Exports are asynchronous: `gee_export` returns a task id, `gee_tasks action=list` shows progress.

## 5. Assets

`gee_assets action=list` (defaults to `projects/<project>/assets`), `info`, `move`, `delete`.
Deletion is irreversible; list first and confirm the exact id.

## Pitfalls

- A download larger than about 32 MB fails at the request, not in the file. Use `chunked`.
- Chunked mosaics use a mid-latitude degree grid, so they are not pixel-identical to Earth Engine's own
  download grid; do not mix the two in a pixel-wise comparison.
- `clipAsset` and `chunked` cannot be combined.
- If a call fails, run `gee_status` first: it distinguishes bad credentials, a missing project and an
  unreachable proxy.
