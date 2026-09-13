"""``Resolution Aspect Selector``: turn an aspect ratio and a megapixel budget into a size."""

from __future__ import annotations

import math

# Aspect ratios offered by the selector, in the order they appear in the widget.
# The label carries the orientation, the value is parsed back out of the "w:h"
# part in front of it, so the list stays the single source of truth.
ASPECT_RATIOS = [
    "1:1",
    "3:2 (Landscape)",
    "2:3 (Portrait)",
    "4:3 (Landscape)",
    "3:4 (Portrait)",
    "16:9 (Landscape)",
    "9:16 (Portrait)",
    "21:9 (Landscape)",
    "9:21 (Portrait)",
]

# Allowed step widths. Models want their latent size to be divisible by a fixed
# number (8 for SD/SDXL, 16 for Flux, 32/64 for some video models).
DIVISORS = ["8", "12", "16", "20", "24", "28", "32"]

# One megapixel, the way image models count it: 1024 x 1024 rather than a round
# million. The SDXL buckets (1024x1024, 1152x896, 1216x832, 1344x768) all sit on
# this number, so "1 MP" reproduces them instead of landing 5% below.
PIXELS_PER_MEGAPIXEL = 1024 * 1024

# Weight of the aspect error against the pixel count error when picking a size
# from the grid: hitting the ratio matters more than hitting the megapixels.
_ASPECT_WEIGHT = 2.0


def parse_aspect(label: str) -> float:
    """Return the ``width / height`` factor of an entry of :data:`ASPECT_RATIOS`."""
    ratio_part = label.split(" ", 1)[0]
    try:
        width, height = (float(part) for part in ratio_part.split(":", 1))
    except ValueError:
        raise ValueError(f"Not a valid aspect ratio: '{label}'") from None
    if width <= 0 or height <= 0:
        raise ValueError(f"Not a valid aspect ratio: '{label}'")
    return width / height


def ratio_from_image(image) -> float:
    """Return the ``width / height`` factor of an ``IMAGE`` tensor.

    ComfyUI images are ``[batch, height, width, channels]``; reading the shape
    from the back also covers a single unbatched frame.
    """
    shape = getattr(image, "shape", None)
    if shape is None or len(shape) < 3:
        raise ValueError("The image input does not carry a usable shape")

    height, width = int(shape[-3]), int(shape[-2])
    if width <= 0 or height <= 0:
        raise ValueError("The image input is empty")
    return width / height


def best_size(ratio: float, target_pixels: float, divisor: int) -> tuple[int, int]:
    """Pick the size on the ``divisor`` grid that fits ``ratio`` and ``target_pixels``.

    Rounding width and height independently distorts the aspect ratio quite a
    bit on coarse grids, so a handful of candidates around the ideal size are
    scored instead. Both errors are measured as log ratios, which makes them
    symmetric (10% too wide costs as much as 10% too narrow) and comparable.
    """
    if target_pixels <= 0:
        raise ValueError("The megapixel budget must be greater than zero")

    ideal_width = math.sqrt(target_pixels * ratio)
    first_step = max(1, int(ideal_width // divisor) - 1)

    best_score = None
    best = (divisor, divisor)

    for width_steps in range(first_step, first_step + 4):
        width = width_steps * divisor
        height_steps = max(1, int((width / ratio) // divisor))
        for steps in (height_steps, height_steps + 1):
            height = steps * divisor
            aspect_error = abs(math.log((width / height) / ratio))
            pixel_error = abs(math.log((width * height) / target_pixels))
            score = aspect_error * _ASPECT_WEIGHT + pixel_error
            if best_score is None or score < best_score:
                best_score, best = score, (width, height)

    return best


class ResolutionAspectSelector:
    """Compute a width/height pair from an aspect ratio and a megapixel budget.

    The aspect ratio comes either from the optional ``image`` input - only its
    shape is read, the pixels are ignored - or from the ``aspect_ratio`` widget
    when nothing is connected. The resulting size is always a multiple of
    ``divisible_by`` in both directions.
    """

    DESCRIPTION = (
        "Turns an aspect ratio and a megapixel budget into width/height values. "
        "The ratio is taken from the optional image input when it is connected, "
        "otherwise from the aspect ratio widget. Both values are rounded to a "
        "multiple of the selected step width."
    )
    CATEGORY = "b24nodes/utils"
    FUNCTION = "select_resolution"
    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("width", "height")
    OUTPUT_TOOLTIPS = (
        "Image width, a multiple of the selected step width.",
        "Image height, a multiple of the selected step width.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "aspect_ratio": (
                    ASPECT_RATIOS,
                    {
                        "default": ASPECT_RATIOS[0],
                        "tooltip": (
                            "Aspect ratio to use. Ignored while the image input "
                            "is connected."
                        ),
                    },
                ),
                "megapixels": (
                    "FLOAT",
                    {
                        "default": 1.0,
                        "min": 0.01,
                        "max": 256.0,
                        "step": 0.1,
                        "round": 0.01,
                        "tooltip": "Target size in megapixels (1 MP = 1024 x 1024 pixels).",
                    },
                ),
                "divisible_by": (
                    DIVISORS,
                    {
                        "default": "8",
                        "tooltip": (
                            "Width and height are rounded to a multiple of this "
                            "value (8 for SD/SDXL, 16 for Flux)."
                        ),
                    },
                ),
            },
            "optional": {
                "image": (
                    "IMAGE",
                    {
                        "tooltip": (
                            "Optional reference image. Only its aspect ratio is "
                            "used, it overrides the aspect ratio widget."
                        ),
                    },
                ),
            },
        }

    def select_resolution(self, aspect_ratio, megapixels, divisible_by, image=None):
        """Return the ``(width, height)`` pair for the selected ratio and budget."""
        # A connected image wins: the frontend greys the widget out in that case,
        # but API clients still send whatever value the workflow carried.
        ratio = ratio_from_image(image) if image is not None else parse_aspect(aspect_ratio)
        target_pixels = megapixels * PIXELS_PER_MEGAPIXEL
        width, height = best_size(ratio, target_pixels, int(divisible_by))
        return (width, height)
