"""Node registry of the b24nodes pack."""

from __future__ import annotations

import logging

from .nodes.load_image_path import LoadImagePath

log = logging.getLogger(__name__)

NODE_CLASS_MAPPINGS = {
    "B24LoadImagePath": LoadImagePath,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "B24LoadImagePath": "Load Image Path (b24)",
}

# The folder browser API is optional: without it the nodes still load, they
# just lose the dynamic folder/image listings in the UI.
try:
    from .routes import register_routes

    register_routes()
except Exception:  # pragma: no cover - never break node loading because of the API
    log.exception("b24nodes: could not register the folder browser routes")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
