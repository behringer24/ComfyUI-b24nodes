"""HTTP routes for the frontend extensions: the folder browser of ``Load Image
Path`` and the palette of ``Color Picker``.

The routes are registered on ComfyUI's own aiohttp application, which means they
are reachable both as ``/b24nodes/...`` and as ``/api/b24nodes/...`` (ComfyUI
mirrors every route under the ``/api`` prefix, and that is the prefix the
frontend helper ``api.fetchApi`` uses).
"""

from __future__ import annotations

import logging

from aiohttp import web

from . import paths
from .nodes.color_picker import COLOR_GROUPS

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
            {"name": group, "colors": [{"name": name, "hex": hex_value} for name, hex_value in colors]}
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

    @routes.get(f"{ROUTE_PREFIX}/colors")
    async def colors(_request: web.Request) -> web.Response:
        """The color palette of the Color Picker node."""
        return web.json_response(_colors_payload())

    return True
