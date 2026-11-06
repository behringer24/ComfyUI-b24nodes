"""Node registry of the b24nodes pack."""

from __future__ import annotations

import logging

from .nodes.color_picker import ColorPicker
from .nodes.load_image_path import LoadImagePath
from .nodes.prompt_composer import PromptComposer
from .nodes.resolution_aspect_selector import ResolutionAspectSelector

log = logging.getLogger(__name__)

NODE_CLASS_MAPPINGS = {
    "B24LoadImagePath": LoadImagePath,
    "B24ResolutionAspectSelector": ResolutionAspectSelector,
    "B24PromptComposer": PromptComposer,
    "B24ColorPicker": ColorPicker,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "B24LoadImagePath": "Load Image Path (b24)",
    "B24ResolutionAspectSelector": "Resolution Aspect Selector (b24)",
    "B24PromptComposer": "Prompt Composer (b24)",
    "B24ColorPicker": "Color Picker (b24)",
}

# The HTTP API is optional: without it the nodes still load, they just lose
# the dynamic folder/image listings and the color palette in the UI.
try:
    from .routes import register_routes

    register_routes()
except Exception:  # pragma: no cover - never break node loading because of the API
    log.exception("b24nodes: could not register the HTTP routes")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
