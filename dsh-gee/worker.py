"""Earth Engine worker for the dsh-gee bundle.

Speaks newline-delimited JSON on stdin/stdout so the Host plugin can keep one
initialized Earth Engine client alive across tool calls:

    -> {"id": "1", "op": "eval", "code": "result = ee.Number(1).add(1)"}
    <- {"id": "1", "ok": true, "result": {"json": 2}}

Every operation runs through :func:`dispatch`; failures come back as
``ok: false`` with a stable error string instead of killing the process.
"""

import json
import math
import os
import struct
import sys
import tempfile
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

_EE = None


def _init(project: str | None):
    """Import and initialize Earth Engine once, reusing the stored credentials."""
    global _EE
    if _EE is not None:
        return _EE
    import ee  # imported lazily so `status` can report an install error

    if project:
        ee.Initialize(project=project)
    else:
        ee.Initialize()
    _EE = ee
    return ee


def _compile(code: str):
    """Wrap the snippet in a function whose `ee` argument is the client and whose
    `result` variable is the return value."""
    body = code if code.strip() else "result = None"
    indented = "\n".join("    " + line for line in body.splitlines())
    source = "def __gee_main(ee):\n" + indented + "\n    return result\n"
    namespace: dict = {}
    exec(compile(source, "<gee-expression>", "exec"), namespace)
    return namespace["__gee_main"]


def _jsonable(value):
    """Convert Earth Engine objects to JSON, recursing through containers."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    get_info = getattr(value, "getInfo", None)
    if callable(get_info):
        return _jsonable(get_info())
    return str(value)


def _png_size(data: bytes):
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    width, height = struct.unpack(">II", data[16:24])
    return {"width": width, "height": height}


def _run(code: str, project: str | None):
    ee = _init(project)
    return _compile(code)(ee)


def op_status(args):
    report = {
        "python": sys.version.split()[0],
        "credentials": os.path.join(os.path.expanduser("~"), ".config", "earthengine", "credentials"),
        "has_credentials": os.path.exists(
            os.path.join(os.path.expanduser("~"), ".config", "earthengine", "credentials")
        ),
        "proxy": os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or "",
        "project": args.get("project") or "",
    }
    try:
        import ee  # noqa: F401

        report["ee_version"] = getattr(ee, "__version__", "unknown")
    except Exception as exc:  # pragma: no cover - install diagnostics
        report["ee_version"] = None
        report["error"] = f"import ee failed: {exc}"
        return report
    try:
        ee = _init(args.get("project"))
        report["init"] = True
        report["identity"] = _jsonable(ee.Number(1).add(1).getInfo())
    except Exception as exc:  # pragma: no cover - auth diagnostics
        report["init"] = False
        report["error"] = f"{type(exc).__name__}: {exc}"
    return report


def _optional_module(name, feature):
    """Import a heavy dependency, naming the feature and the fix when it is absent."""
    try:
        return __import__(name)
    except ImportError as error:
        raise RuntimeError(
            "%s needs %s, which is not installed in this Python environment. "
            "Run: python -m pip install %s" % (feature, name, name)
        ) from error


def _capture_figures(cache):
    """Save every open matplotlib figure so the Host can attach it to the reply."""
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return []
    numbers = plt.get_fignums()
    if not numbers:
        return []
    os.makedirs(cache, exist_ok=True)
    paths = []
    for number in numbers:
        figure = plt.figure(number)
        path = os.path.join(cache, "figure-%d-%d.png" % (number, int(time.time() * 1000)))
        try:
            figure.savefig(path, dpi=140, bbox_inches="tight")
            paths.append(path)
        except Exception:
            pass
    plt.close("all")
    return paths


def op_eval(args):
    value = _run(args.get("code", ""), args.get("project"))
    cache = args.get("cache") or os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
    return {"json": _jsonable(value), "figures": _capture_figures(cache)}


def op_preview(args):
    import requests

    image = _run(args.get("code", ""), args.get("project"))
    get_thumb = getattr(image, "getThumbUrl", None)
    if not callable(get_thumb):
        raise TypeError("the snippet must leave an ee.Image in `result` (use .mosaic() or .first())")

    size = int(args.get("dimensions") or 768)
    size = max(64, min(2048, size))
    vis = {"format": "png", "dimensions": size}
    if args.get("bands"):
        vis["bands"] = list(args["bands"])[:3]
    if args.get("min") is not None:
        vis["min"] = args["min"]
    if args.get("max") is not None:
        vis["max"] = args["max"]
    if args.get("palette"):
        vis["palette"] = list(args["palette"])[:64]
    region = args.get("region")
    if isinstance(region, list) and len(region) == 4:
        vis["region"] = region

    url = get_thumb(vis)
    response = requests.get(url, timeout=120)
    response.raise_for_status()
    payload = response.content

    cache = args.get("cache") or os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
    os.makedirs(cache, exist_ok=True)
    handle, path = tempfile.mkstemp(prefix="dsh-gee-", suffix=".png", dir=cache)
    with os.fdopen(handle, "wb") as stream:
        stream.write(payload)
    return {
        "path": path,
        "url": url,
        "bytes": len(payload),
        "size": _png_size(payload),
    }


STAC_BASE = "https://earthengine-stac.storage.googleapis.com/catalog"
STAC_TTL_SECONDS = 7 * 24 * 3600


def _requests():
    import requests

    return requests


def _get_json(url: str, timeout: int = 60):
    """Fetch one JSON document, returning None instead of raising for a bad leaf."""
    try:
        response = _requests().get(url, timeout=timeout)
        if response.status_code != 200:
            return None
        return response.json()
    except Exception:
        return None


def _build_stac_index():
    root = _get_json(f"{STAC_BASE}/catalog.json")
    if not root:
        raise RuntimeError("cannot reach the Earth Engine STAC catalog (is the proxy reachable?)")
    children = [
        link["href"]
        for link in root.get("links", [])
        if link.get("rel") == "child" and link.get("href")
    ]
    with ThreadPoolExecutor(max_workers=24) as pool:
        catalogs = list(pool.map(_get_json, children))
    dataset_links = []
    for catalog in catalogs:
        if not catalog:
            continue
        for link in catalog.get("links", []):
            if link.get("rel") == "child" and link.get("href"):
                dataset_links.append(link["href"])
    with ThreadPoolExecutor(max_workers=24) as pool:
        documents = list(pool.map(_get_json, dataset_links))
    items = []
    for document in documents:
        if not document or not document.get("id"):
            continue
        items.append(
            {
                "id": document["id"],
                "title": document.get("title") or document["id"],
                "type": document.get("gee:type") or "",
                "keywords": [str(key) for key in (document.get("keywords") or [])][:12],
                "summary": " ".join((document.get("description") or "").split())[:240],
                "text": " ".join((document.get("description") or "").split()).lower()[:2000],
                "deprecated": bool(document.get("deprecated")),
            }
        )
    return {"fetched_at": int(time.time()), "count": len(items), "items": items}


def _stac_index(cache_dir: str, refresh: bool):
    path = os.path.join(cache_dir, "stac-index.json")
    if not refresh and os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as stream:
                cached = json.load(stream)
            fresh = int(time.time()) - int(cached.get("fetched_at", 0)) < STAC_TTL_SECONDS
            if fresh and cached.get("items") and "text" in cached["items"][0]:
                return cached, path, False
        except Exception:
            pass
    index = _build_stac_index()
    os.makedirs(cache_dir, exist_ok=True)
    with open(path, "w", encoding="utf-8") as stream:
        json.dump(index, stream, ensure_ascii=False)
    return index, path, True


def op_catalog(args):
    cache_dir = args.get("cache") or os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
    index, _path, rebuilt = _stac_index(cache_dir, bool(args.get("refresh")))
    terms = [term for term in str(args.get("query") or "").lower().replace(",", " ").split() if term]
    wanted = args.get("type")
    scored = []
    for item in index["items"]:
        if wanted and item.get("type") != wanted:
            continue
        if not terms:
            scored.append((0, item))
            continue
        identifier = item["id"].lower()
        title = item["title"].lower()
        keywords = " ".join(item["keywords"]).lower()
        description = item.get("text", "")
        matched = 0
        score = 0
        for term in terms:
            hit_id = term in identifier
            hit_title = term in title
            hit_keywords = term in keywords
            hit_text = term in description
            if hit_id or hit_title or hit_keywords or hit_text:
                matched += 1
                score += (4 if hit_id else 0) + (3 if hit_title else 0) + (2 if hit_keywords else 0) + (1 if hit_text else 0)
        if matched == 0:
            continue
        # Every query term present is a much stronger signal than a partial hit.
        if matched == len(terms):
            score += 10
        scored.append((score, item))
    scored.sort(key=lambda pair: (-pair[0], len(pair[1]["id"])))
    limit = max(1, min(50, int(args.get("limit") or 20)))
    matches = [item for _, item in scored[:limit]]
    for item in matches:
        item.pop("text", None)
    return {
        "total": len(scored),
        "returned": len(matches),
        "catalog_size": index["count"],
        "rebuilt": rebuilt,
        "matches": matches,
    }


def op_export(args):
    ee = _init(args.get("project"))
    destination = args.get("destination") or "drive"
    image = _run(args.get("code", ""), args.get("project"))
    if not hasattr(image, "bandNames"):
        raise TypeError("the snippet must leave an ee.Image in `result`")

    region = args.get("region")
    geometry = ee.Geometry.Rectangle(region) if isinstance(region, list) and len(region) == 4 else None
    common = {
        "description": args.get("description") or "dsh-gee-export",
        "region": geometry,
        "maxPixels": int(args.get("maxPixels") or 1e10),
    }
    if args.get("scale"):
        common["scale"] = float(args["scale"])
    if args.get("crs"):
        common["crs"] = args["crs"]

    if destination == "asset":
        asset_id = args.get("assetId")
        if not asset_id:
            raise ValueError("destination 'asset' needs assetId, e.g. projects/<project>/assets/<name>")
        task = ee.batch.Export.image.toAsset(image=image, assetId=asset_id, **common)
    else:
        task = ee.batch.Export.image.toDrive(
            image=image,
            folder=args.get("folder"),
            fileNamePrefix=args.get("fileNamePrefix"),
            **common,
        )
    task.start()
    status = task.status()
    return {
        "task_id": getattr(task, "id", None) or status.get("id"),
        "destination": destination,
        "status": status,
    }


def op_tasks(args):
    ee = _init(args.get("project"))
    action = args.get("action") or "list"
    tasks = ee.batch.Task.list()

    if action == "list":
        limit = max(1, min(100, int(args.get("limit") or 20)))
        rows = []
        for task in tasks[:limit]:
            status = task.status()
            rows.append(
                {
                    "id": getattr(task, "id", None),
                    "state": status.get("state"),
                    "description": status.get("description"),
                    "created_ms": status.get("creation_timestamp_ms"),
                    "updated_ms": status.get("update_timestamp_ms"),
                    "error": status.get("error_message"),
                }
            )
        return {"tasks": rows, "count": len(tasks)}

    task_id = args.get("task_id")
    if not task_id:
        raise ValueError(f"action {action!r} needs task_id")
    for task in tasks:
        if getattr(task, "id", None) != task_id:
            continue
        if action == "status":
            return {"id": task_id, "status": task.status()}
        if action == "cancel":
            task.cancel()
            return {"id": task_id, "cancelled": True, "status": task.status()}
        raise ValueError(f"unknown action: {action}")
    raise ValueError(f"task not found: {task_id}")


def op_assets(args):
    ee = _init(args.get("project"))
    action = args.get("action") or "list"
    project = args.get("project")
    root = f"projects/{project}/assets" if project else "projects/earthengine/assets"

    if action == "list":
        parent = args.get("path") or root
        page = ee.data.listAssets(
            {"parent": parent, "pageSize": max(1, min(1000, int(args.get("limit") or 100)))}
        )
        assets = [
            {
                "name": asset.get("name"),
                "type": asset.get("type"),
                "size_bytes": asset.get("sizeBytes"),
                "updated": asset.get("updateTime"),
            }
            for asset in page.get("assets", [])
        ]
        result = {"parent": parent, "assets": assets}
        token = page.get("nextPageToken")
        if token:
            result["next_page_token"] = str(token)
        return result

    asset_id = args.get("asset_id")
    if not asset_id:
        raise ValueError(f"action {action!r} needs asset_id")
    if action == "info":
        info = ee.data.getAsset(asset_id)
        if isinstance(info, dict):
            # Full footprints are megabytes of coordinates; the shape is enough.
            has_geometry = bool(info.pop("geometry", None))
            info["has_geometry"] = has_geometry
            bands = info.get("bands")
            if isinstance(bands, list):
                info["bands"] = [
                    {
                        "id": band.get("id"),
                        "dataType": band.get("dataType"),
                        "dimensions": (band.get("grid") or {}).get("dimensions"),
                    }
                    for band in bands
                ]
        return {"asset": _jsonable(info)}
    if action == "delete":
        ee.data.deleteAsset(asset_id)
        return {"deleted": asset_id}
    if action == "move":
        destination = args.get("destination")
        if not destination:
            raise ValueError("action 'move' needs destination")
        ee.data.renameAsset(asset_id, destination)
        return {"moved": asset_id, "destination": destination}
    raise ValueError(f"unknown action: {action}")


def _vis(args):
    vis = {}
    if args.get("bands"):
        vis["bands"] = list(args["bands"])[:3]
    if args.get("min") is not None:
        vis["min"] = args["min"]
    if args.get("max") is not None:
        vis["max"] = args["max"]
    if args.get("palette"):
        vis["palette"] = list(args["palette"])[:64]
    return vis


def op_map(args):
    image = _run(args.get("code", ""), args.get("project"))
    if not hasattr(image, "getMapId"):
        raise TypeError("the snippet must leave an ee.Image in `result`")
    return {"map": image.getMapId(_vis(args))["mapid"]}


def op_asset_layer(args):
    ee = _init(args.get("project"))
    asset = args.get("asset")
    if not asset:
        raise ValueError("needs asset")
    return {"map": ee.Image(asset).getMapId(_vis(args))["mapid"]}


def _describe_tif(path, fallback_bounds=None, limit_bytes=256 * 1024 * 1024):
    """Report what the file actually contains, so callers do not have to re-probe it."""
    size = os.path.getsize(path)
    info = {"bytes": size}
    if size > limit_bytes:
        info["note"] = "too large to inspect; bounds and nodata were not verified"
        return info
    try:
        import numpy as np
        import tifffile

        with tifffile.TiffFile(path) as document:
            page = document.pages[0]
            page_count = len(document.pages)
            array = page.asarray()
            tags = page.tags
            scale = tags[33550].value if 33550 in tags else None
            tie = tags[33922].value if 33922 in tags else None
            nodata = None
            if 42113 in tags:
                try:
                    nodata = float(tags[42113].value)
                except (TypeError, ValueError):
                    nodata = None
    except Exception as error:  # a broken file must not hide the download itself
        info["note"] = "could not inspect: %s" % error
        return info

    width = int(getattr(page, "imagewidth", array.shape[-1]))
    height = int(getattr(page, "imagelength", array.shape[-2]))
    samples = int(getattr(page, "samplesperpixel", 1))
    # A band-sequential TIFF stores one page per band; a chunky one stores all
    # samples in one page.
    info.update(
        width=width,
        height=height,
        bands=samples if page_count == 1 else page_count * samples,
        dtype=str(array.dtype),
    )
    if nodata is not None:
        outside = int(np.count_nonzero(array == nodata))
        info["nodata"] = nodata
        info["nodata_fraction"] = round(outside / array.size, 4)
    if scale is not None and tie is not None:
        west, north = float(tie[3]), float(tie[4])
        info["pixel_size"] = [round(float(scale[0]), 10), round(float(scale[1]), 10)]
        info["bounds"] = [
            round(west, 6),
            round(north - float(scale[1]) * height, 6),
            round(west + float(scale[0]) * width, 6),
            round(north, 6),
        ]
        info["bounds_source"] = "file"
    elif isinstance(fallback_bounds, list) and len(fallback_bounds) == 4:
        # Earth Engine does not always write the georeferencing tags; the requested
        # region is still the true extent of a bbox download.
        info["bounds"] = [round(float(value), 6) for value in fallback_bounds]
        info["bounds_source"] = "requested region"
    return info


def op_download(args):
    """Download a bounded image as a GeoTIFF.

    Earth Engine drops the mask of `image.clip(geometry)` on GeoTIFF download,
    so `clipAsset` clips locally instead: the boundary table is painted to a
    second raster on the same grid, and every pixel outside it becomes the
    declared no-data value. The written file always carries GDAL_NODATA, so a
    viewer stretches the real values rather than the fill value.
    """
    np = _optional_module("numpy", "clipAsset")
    tifffile = _optional_module("tifffile", "clipAsset")

    ee = _init(args.get("project"))
    image = _run(args.get("code", ""), args.get("project"))
    if not hasattr(image, "getDownloadURL"):
        raise TypeError("the snippet must leave an ee.Image in `result`")

    params = {
        "format": "GEO_TIFF",
        "scale": float(args.get("scale") or 500),
    }
    region = args.get("region")
    if isinstance(region, list) and len(region) == 4:
        params["region"] = ee.Geometry.Rectangle(region).getInfo()
    if args.get("bands"):
        params["bands"] = list(args["bands"])
    if args.get("crs"):
        params["crs"] = args["crs"]
    elif args.get("clipAsset"):
        # The painted boundary carries no projection of its own, so pin both
        # requests to the image's native CRS instead of letting each pick one.
        try:
            native = image.projection().crs().getInfo()
        except Exception:
            native = None
        if native:
            params["crs"] = native

    cache = args.get("cache") or os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
    os.makedirs(cache, exist_ok=True)

    url = image.getDownloadURL(params)
    payload = _requests().get(url, timeout=900).content
    clip_asset = args.get("clipAsset")

    if not clip_asset:
        handle, path = tempfile.mkstemp(prefix="dsh-gee-", suffix=".tif", dir=cache)
        with os.fdopen(handle, "wb") as stream:
            stream.write(payload)
        requested = region if isinstance(region, list) and len(region) == 4 else None
        return {"path": path, "bytes": len(payload), "url": url, "verify": _describe_tif(path, requested)}

    handle, data_path = tempfile.mkstemp(prefix="dsh-gee-src-", suffix=".tif", dir=cache)
    with os.fdopen(handle, "wb") as stream:
        stream.write(payload)
    try:
        with tifffile.TiffFile(data_path) as source:
            page = source.pages[0]
            data = page.asarray()
            samples = int(getattr(page, "samplesperpixel", 1))
            geo = [(tag, page.tags[tag].value)
                   for tag in (33550, 33922, 34735) if tag in page.tags]
    finally:
        os.remove(data_path)

    # Earth Engine tags a 3-band image as RGB, and tifffile then reads it as
    # (rows, cols, samples); a plain stack reads as (samples, rows, cols).
    if data.ndim == 3 and samples > 1 and data.shape[-1] == samples:
        data = np.moveaxis(data, -1, 0)
    rows, cols = int(data.shape[-2]), int(data.shape[-1])

    # The painted boundary has no projection of its own, so a second request with
    # the same region and scale can land on a different grid. Ask for exactly the
    # grid the image came back on.
    mask_params = dict(params)
    mask_params.pop("scale", None)  # dimensions and scale are mutually exclusive
    mask_params["dimensions"] = "%dx%d" % (cols, rows)
    mask_url = ee.Image().paint(ee.FeatureCollection(clip_asset), 1).getDownloadURL(mask_params)
    mask_payload = _requests().get(mask_url, timeout=600).content
    handle, mask_path = tempfile.mkstemp(prefix="dsh-gee-mask-", suffix=".tif", dir=cache)
    with os.fdopen(handle, "wb") as stream:
        stream.write(mask_payload)
    try:
        mask = tifffile.imread(mask_path)
    finally:
        os.remove(mask_path)
    if mask.ndim == 3:
        mask = mask[0]

    fill = float(args.get("nodata", -32768))
    out = np.asarray(data, dtype="float32")
    inside = mask > 0
    if inside.shape != out.shape[-2:]:
        # A pixel of drift is harmless for a binary mask; anything more means the two
        # requests disagreed and the clip would be wrong.
        if abs(inside.shape[0] - out.shape[-2]) > 2 or abs(inside.shape[1] - out.shape[-1]) > 2:
            raise ValueError(
                "clip mask grid does not match the download: %s vs %s" % (inside.shape, out.shape[-2:])
            )
        rows, cols = out.shape[-2:]
        ys = np.clip((np.arange(rows) * (inside.shape[0] / rows)).astype(int), 0, inside.shape[0] - 1)
        xs = np.clip((np.arange(cols) * (inside.shape[1] / cols)).astype(int), 0, inside.shape[1] - 1)
        inside = inside[np.ix_(ys, xs)]
    if out.ndim == 3:
        out = np.where(inside[None, :, :], out, np.float32(fill))
    else:
        out[~inside] = fill

    handle, path = tempfile.mkstemp(prefix="dsh-gee-clipped-", suffix=".tif", dir=cache)
    os.close(handle)
    tag = ("%g" % fill).encode() + b"\x00"
    extratags = [(42113, "s", len(tag), tag, False)]
    # Earth Engine does not always write ModelPixelScale/ModelTiepoint, so the
    # clip output derives them from the requested region and the actual shape.
    if isinstance(region, list) and len(region) == 4:
        west_, south_, east_, north_ = [float(v) for v in region]
        rows, cols = out.shape[-2], out.shape[-1]
        extratags.append((33550, "d", 3, ((east_ - west_) / cols, (north_ - south_) / rows, 0.0), False))
        extratags.append((33922, "d", 6, (0.0, 0.0, 0.0, west_, north_, 0.0), False))
    keydir = next((value for (code_, value) in geo if code_ == 34735), None)
    if keydir is None:
        keydir = (1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326)
    extratags.append((34735, "H", len(keydir), tuple(keydir), False))
    tifffile.imwrite(path, out, photometric="minisblack", compression="deflate", extratags=extratags)
    return {
        "path": path,
        "bytes": os.path.getsize(path),
        "url": url,
        "clipped": True,
        "inside_fraction": round(float(inside.mean()), 4),
        "verify": _describe_tif(path, region if isinstance(region, list) and len(region) == 4 else None),
    }


def op_download_grid(args):
    """Download a bbox as a grid of tiles that share one affine, then mosaic.

    Every tile is requested through `computePixels` with the *same* global
    affine transform, so tiles line up pixel-for-pixel no matter where they sit
    in the bbox. `getDownloadURL` cannot do this: it ignores `crsTransform` and
    re-derives a per-request grid from `region` + `scale`, which stretches each
    tile slightly differently and produces a visible seam.
    """
    np = _optional_module("numpy", "chunked download")
    tifffile = _optional_module("tifffile", "chunked download")

    ee = _init(args.get("project"))
    region = args.get("region")
    if not (isinstance(region, list) and len(region) == 4):
        raise ValueError("a chunked download needs region [west, south, east, north]")
    west, south, east, north = [float(v) for v in region]
    scale = float(args.get("scale") or 500)
    chunk = max(256, int(args.get("chunkPixels") or 2048))
    lat = (south + north) / 2.0
    width = max(1, int(round((east - west) * 111320.0 * math.cos(math.radians(lat)) / scale)))
    height = max(1, int(round((north - south) * 110540.0 / scale)))
    dx = (east - west) / width
    dy = (north - south) / height

    image = _run(args.get("code", ""), args.get("project"))

    grid = None
    names = ()
    band_count = 0
    rows = (height + chunk - 1) // chunk
    cols = (width + chunk - 1) // chunk
    done = 0
    for row in range(rows):
        for col in range(cols):
            w0, h0 = col * chunk, row * chunk
            cw, ch = min(chunk, width - w0), min(chunk, height - h0)
            params = {
                "expression": image,
                "fileFormat": "NUMPY_NDARRAY",
                "grid": {
                    "dimensions": {"width": cw, "height": ch},
                    "affineTransform": {
                        "scaleX": dx,
                        "shearX": 0.0,
                        "translateX": west + w0 * dx,
                        "shearY": 0.0,
                        "scaleY": -dy,
                        "translateY": north - h0 * dy,
                    },
                    "crsCode": "EPSG:4326",
                },
            }
            data = ee.data.computePixels(params)
            chunk_names = data.dtype.names or ("band",)
            if grid is None:
                names = chunk_names
                band_count = len(names)
                grid = np.full((band_count, height, width), np.nan, dtype=np.float32)
            for index, band in enumerate(chunk_names[:band_count]):
                block = np.asarray(data[band] if data.dtype.names else data, dtype=np.float32)
                bh, bw = min(ch, block.shape[0]), min(cw, block.shape[1])
                grid[index, h0:h0 + bh, w0:w0 + bw] = block[:bh, :bw]
            done += 1

    cache = args.get("cache") or os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
    os.makedirs(cache, exist_ok=True)
    handle, out = tempfile.mkstemp(prefix="dsh-gee-grid-", suffix=".tif", dir=cache)
    os.close(handle)
    keydir = [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]
    if grid.shape[0] == 1:
        payload = grid[0]
        photometric = "minisblack"
    else:
        payload = np.moveaxis(grid, 0, -1)
        photometric = "rgb" if grid.shape[0] == 3 else "minisblack"
    tifffile.imwrite(
        out,
        payload,
        photometric=photometric,
        compression="deflate",
        description="bands: " + ", ".join(names),
        extratags=[
            (33550, "d", 3, (dx, dy, 0.0), False),
            (33922, "d", 6, (0.0, 0.0, 0.0, west, north, 0.0), False),
            (34735, "H", len(keydir), tuple(keydir), False),
            (42113, "s", 4, b"nan\x00", False),
        ],
    )
    return {
        "path": out,
        "bytes": os.path.getsize(out),
        "chunks": done,
        "width": width,
        "height": height,
        "bands": band_count,
        "band_names": list(names),
    }


def dispatch(request):
    op = request.get("op")
    args = request.get("args") or {}
    cache = args.get("cache")
    if cache:
        # matplotlib refuses to import without a writable config directory, and
        # the worker has no writable AppData, so pin it inside the call cache.
        os.makedirs(cache, exist_ok=True)
        os.environ.setdefault("MPLCONFIGDIR", os.path.join(cache, "mpl"))
        os.makedirs(os.environ["MPLCONFIGDIR"], exist_ok=True)
    if op == "status":
        return op_status(args)
    if op == "eval":
        return op_eval(args)
    if op == "preview":
        return op_preview(args)
    if op == "catalog":
        return op_catalog(args)
    if op == "export":
        return op_export(args)
    if op == "tasks":
        return op_tasks(args)
    if op == "assets":
        return op_assets(args)
    if op == "map":
        return op_map(args)
    if op == "asset_layer":
        return op_asset_layer(args)
    if op == "download":
        return op_download(args)
    if op == "download_grid":
        return op_download_grid(args)
    raise ValueError(f"unknown op: {op}")


def main():
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception:
            continue
        reply = {"id": request.get("id")}
        try:
            reply["ok"] = True
            reply["result"] = dispatch(request)
        except Exception as exc:
            reply["ok"] = False
            reply["error"] = f"{type(exc).__name__}: {exc}"
            reply["traceback"] = traceback.format_exc()[-2000:]
        sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
