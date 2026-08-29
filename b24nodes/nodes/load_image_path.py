"""``Load Image Path``: load an image from a sub folder of ComfyUI's input directory."""

from __future__ import annotations

import hashlib
import os

import numpy as np
import torch
from PIL import Image, ImageOps, ImageSequence

from .. import paths

try:  # ComfyUI wraps Pillow calls to produce nicer error messages.
    import node_helpers
except ImportError:  # pragma: no cover - only hit outside of ComfyUI
    node_helpers = None

# Formats whose "frames" are alternative resolutions of the same picture rather
# than an animation, so they must not be batched. Mirrors the core Load Image node.
_MULTI_RESOLUTION_FORMATS = ("MPO",)

# Read the file in chunks while hashing so large images do not spike memory.
_HASH_CHUNK_SIZE = 1024 * 1024


def _pillow(function, *args, **kwargs):
    """Call a Pillow function through ComfyUI's helper when it is available."""
    if node_helpers is not None and hasattr(node_helpers, "pillow"):
        return node_helpers.pillow(function, *args, **kwargs)
    return function(*args, **kwargs)


class LoadImagePath:
    """Load an image from a freely selectable folder below ``ComfyUI/input``.

    The folder and the file name are two separate widgets: the folder widget
    lists every sub folder of the input directory, the image widget lists the
    images of the selected folder. The companion frontend extension
    (``web/b24_load_image_path.js``) keeps the image list in sync and adds
    buttons to walk up and to reload the listings.
    """

    DESCRIPTION = (
        "Loads an image from ComfyUI's input directory. In contrast to the core "
        "Load Image node the folder can be picked separately, so images can be "
        "organised in sub folders below input/."
    )
    CATEGORY = "b24nodes/image"
    FUNCTION = "load_image"
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    OUTPUT_TOOLTIPS = (
        "The loaded image (batched for multi frame files such as animated GIFs).",
        "The inverted alpha channel of the image, or an empty mask.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        """Build the initial widget lists.

        This runs whenever ComfyUI serves ``/object_info``, so it only provides
        the starting point: the frontend extension refreshes both lists while
        the user navigates.
        """
        folders, _ = paths.list_tree()
        images = paths.list_images("")
        return {
            "required": {
                "folder": (
                    [paths.ROOT_LABEL] + folders,
                    {
                        "default": paths.ROOT_LABEL,
                        "tooltip": "Folder below ComfyUI/input. '/' is the input root.",
                    },
                ),
                "image": (
                    images or [""],
                    {
                        "default": images[0] if images else "",
                        "tooltip": "Image file inside the selected folder.",
                    },
                ),
            }
        }

    def load_image(self, folder, image):
        """Load the selected file and return it as an ``IMAGE``/``MASK`` pair."""
        image_path = paths.resolve_image(folder, image)
        opened = _pillow(Image.open, image_path)

        output_images = []
        output_masks = []
        width, height = None, None

        for frame in ImageSequence.Iterator(opened):
            frame = _pillow(ImageOps.exif_transpose, frame)

            if frame.mode == "I":
                # 32 bit integer images are stored at 1/255 of the float range.
                frame = frame.point(lambda value: value * (1 / 255))
            rgb = frame.convert("RGB")

            if width is None:
                width, height = rgb.size
            elif rgb.size != (width, height):
                # Frames of a different size can not be part of the same batch.
                continue

            pixels = np.array(rgb).astype(np.float32) / 255.0
            output_images.append(torch.from_numpy(pixels)[None,])
            output_masks.append(self._extract_mask(frame).unsqueeze(0))

        if not output_images:
            raise ValueError(f"Could not read any image data from '{image_path}'")

        if len(output_images) > 1 and opened.format not in _MULTI_RESOLUTION_FORMATS:
            return (torch.cat(output_images, dim=0), torch.cat(output_masks, dim=0))
        return (output_images[0], output_masks[0])

    @staticmethod
    def _extract_mask(frame: Image.Image) -> torch.Tensor:
        """Return the inverted alpha channel of a frame, or an empty mask."""
        if "A" in frame.getbands():
            alpha = np.array(frame.getchannel("A")).astype(np.float32) / 255.0
            return 1.0 - torch.from_numpy(alpha)
        if frame.mode == "P" and "transparency" in frame.info:
            alpha = np.array(frame.convert("RGBA").getchannel("A")).astype(np.float32) / 255.0
            return 1.0 - torch.from_numpy(alpha)
        return torch.zeros((64, 64), dtype=torch.float32, device="cpu")

    @classmethod
    def IS_CHANGED(cls, folder, image):
        """Hash the file content so edits on disk invalidate the cached result."""
        try:
            image_path = paths.resolve_image(folder, image)
        except ValueError:
            return float("nan")

        digest = hashlib.sha256()
        try:
            with open(image_path, "rb") as handle:
                for chunk in iter(lambda: handle.read(_HASH_CHUNK_SIZE), b""):
                    digest.update(chunk)
        except OSError:
            # Missing or unreadable file: always re-run so validation reports it.
            return float("nan")
        return digest.hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, folder, image):
        """Validate the selection before the prompt is queued.

        Declaring both widgets here also switches off ComfyUI's built in "value
        must be part of the combo list" check, which is what allows the frontend
        to offer folders and files that were not known when ``INPUT_TYPES`` ran,
        and API clients to pass any path below ``input/``.
        """
        try:
            image_path = paths.resolve_image(folder, image)
        except ValueError as error:
            return str(error)

        if not os.path.isfile(image_path):
            return f"Image not found in the input directory: {paths.relative_image(folder, image)}"
        if not paths.is_image_file(image_path):
            return f"Unsupported image format: {paths.relative_image(folder, image)}"
        return True
