"""ComfyUI-b24nodes - custom nodes by b24.

ComfyUI imports this file, reads the two node mappings and serves the files in
``WEB_DIRECTORY`` under ``/extensions/ComfyUI-b24nodes/``.
"""

from __future__ import annotations

from .b24nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# Frontend extensions of this pack (served as static files by ComfyUI).
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
