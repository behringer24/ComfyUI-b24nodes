"""HTTP routes for the frontend extensions: the folder browser and the
thumbnails of ``Load Image Path`` and the palette of ``Color Picker``.

The routes are registered on ComfyUI's own aiohttp application, which means they
are reachable both as ``/b24nodes/...`` and as ``/api/b24nodes/...`` (ComfyUI
mirrors every route under the ``/api`` prefix, and that is the prefix the
frontend helper ``api.fetchApi`` uses).
"""

from __future__ import annotations

import asyncio
import logging
import os

from aiohttp import web
from PIL import Image

from . import paths
from .nodes.color_picker import COLOR_GROUPS, HAIR_GROUP

log = logging.getLogger(__name__)

ROUTE_PREFIX = "/b24nodes"


def _browse_payload(folder: str) -> dict:
    """Listing of a single folder: sub folders, images and the parent path."""
    exists = paths.folder_exists(folder)
    return {
        "folder": folder,
        "parent": paths.parent_folder(folder),
        "exists": exists,
        "folders": paths.list_subfolders(folder) if exists else [],
        "images": paths.list_images(folder) if exists else [],
    }


def _tree_payload() -> dict:
    """Every folder below the input directory, capped at ``MAX_TREE_ENTRIES``."""
    folders, truncated = paths.list_tree()
    return {"folders": folders, "truncated": truncated, "limit": paths.MAX_TREE_ENTRIES}


def _colors_payload() -> dict:
    """The color palette of the ``Color Picker`` node, grouped by family."""
    return {
        "groups": [
            {
                "name": group,
                "hair": group == HAIR_GROUP,
                "colors": [{"name": name, "hex": hex_value} for name, hex_value in colors],
            }
            for group, colors in COLOR_GROUPS
        ]
    }


def register_routes() -> bool:
    """Attach the routes to the running ComfyUI server.

    Returns ``False`` when there is no server instance - for example when the
    nodes are imported by a test runner - so that importing this pack never
    fails outside of ComfyUI.
    """
    try:
        from server import PromptServer
    except ImportError:
        log.debug("ComfyUI server module not available, skipping b24nodes routes")
        return False

    instance = getattr(PromptServer, "instance", None)
    if instance is None or not hasattr(instance, "routes"):
        log.debug("No PromptServer instance available, skipping b24nodes routes")
        return False

    routes = instance.routes

    @routes.get(f"{ROUTE_PREFIX}/browse")
    async def browse(request: web.Request) -> web.Response:
        """List one folder below the input directory."""
        folder = paths.normalize_folder(request.query.get("folder", ""))
        return web.json_response(_browse_payload(folder))

    @routes.get(f"{ROUTE_PREFIX}/tree")
    async def tree(_request: web.Request) -> web.Response:
        """List every folder below the input directory."""
        return web.json_response(_tree_payload())

    @routes.get(f"{ROUTE_PREFIX}/thumbnail")
    async def thumbnail(request: web.Request) -> web.Response:
        """A small WEBP preview of one image below the input directory.

        The ETag is built from the file's modification time and size, so the
        browser keeps the thumbnails and only revalidates them; an unchanged
        file is answered with 304 without decoding it again.
        """
        try:
            image_path = paths.resolve_image(request.query.get("folder", ""), request.query.get("image", ""))
            stat = os.stat(image_path)
        except (OSError, ValueError):
            raise web.HTTPNotFound()
        if not paths.is_image_file(image_path) or not os.path.isfile(image_path):
            raise web.HTTPNotFound()

        headers = {"ETag": f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"', "Cache-Control": "no-cache"}
        if request.headers.get("If-None-Match") == headers["ETag"]:
            return web.Response(status=304, headers=headers)

        # Decoding a large image takes long enough to stall the event loop that
        # also carries ComfyUI's progress updates, so it runs in a worker thread.
        try:
            body = await asyncio.get_running_loop().run_in_executor(None, paths.render_thumbnail, image_path)
        except (OSError, ValueError, Image.DecompressionBombError):
            raise web.HTTPUnsupportedMediaType()
        return web.Response(body=body, content_type="image/webp", headers=headers)

    @routes.get(f"{ROUTE_PREFIX}/colors")
    async def colors(_request: web.Request) -> web.Response:
        """The color palette of the Color Picker node."""
        return web.json_response(_colors_payload())

    return True
