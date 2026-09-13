"""Tests for the Resolution Aspect Selector node.

Like the loader tests these run without a ComfyUI installation: the module is
imported under a synthetic package name so the pack ``__init__`` (which needs
the ComfyUI server) is not executed.

Run them from the pack root with::

    python -m unittest discover -s tests
"""

from __future__ import annotations

import importlib
import sys
import types
import unittest
from pathlib import Path

PACK_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ALIAS = "b24nodes_under_test"

if PACKAGE_ALIAS not in sys.modules:
    _package = types.ModuleType(PACKAGE_ALIAS)
    _package.__path__ = [str(PACK_ROOT / "b24nodes")]
    sys.modules[PACKAGE_ALIAS] = _package

module = importlib.import_module(f"{PACKAGE_ALIAS}.nodes.resolution_aspect_selector")
ResolutionAspectSelector = module.ResolutionAspectSelector


class FakeImage:
    """Stand in for an ``IMAGE`` tensor - only the shape is read."""

    def __init__(self, width, height, batch=1, channels=3):
        self.shape = (batch, height, width, channels)


class ParseAspectTests(unittest.TestCase):
    def test_every_widget_entry_parses(self):
        for label in module.ASPECT_RATIOS:
            self.assertGreater(module.parse_aspect(label), 0, label)

    def test_orientation_is_taken_from_the_ratio(self):
        self.assertAlmostEqual(module.parse_aspect("1:1"), 1.0)
        self.assertGreater(module.parse_aspect("16:9 (Landscape)"), 1.0)
        self.assertLess(module.parse_aspect("9:16 (Portrait)"), 1.0)

    def test_invalid_label_is_rejected(self):
        with self.assertRaises(ValueError):
            module.parse_aspect("not a ratio")
        with self.assertRaises(ValueError):
            module.parse_aspect("0:9")


class RatioFromImageTests(unittest.TestCase):
    def test_shape_is_read_as_batch_height_width(self):
        self.assertAlmostEqual(module.ratio_from_image(FakeImage(1920, 1080)), 1920 / 1080)

    def test_unbatched_frame_works_too(self):
        image = FakeImage(800, 400)
        image.shape = image.shape[1:]
        self.assertAlmostEqual(module.ratio_from_image(image), 2.0)

    def test_unusable_input_is_rejected(self):
        with self.assertRaises(ValueError):
            module.ratio_from_image(object())
        with self.assertRaises(ValueError):
            module.ratio_from_image(FakeImage(0, 100))


class SelectResolutionTests(unittest.TestCase):
    def setUp(self):
        self.node = ResolutionAspectSelector()

    def select(self, **kwargs):
        arguments = {"aspect_ratio": "1:1", "megapixels": 1.0, "divisible_by": "8"}
        arguments.update(kwargs)
        return self.node.select_resolution(**arguments)

    def test_square_hits_the_budget_exactly(self):
        # 1 MP is 1024x1024, the way image models count it - not a round million.
        self.assertEqual(self.select(), (1024, 1024))

    def test_result_is_always_a_multiple_of_the_divisor(self):
        for divisor in module.DIVISORS:
            for label in module.ASPECT_RATIOS:
                width, height = self.select(aspect_ratio=label, divisible_by=divisor)
                step = int(divisor)
                self.assertEqual(width % step, 0, (label, divisor))
                self.assertEqual(height % step, 0, (label, divisor))
                self.assertGreaterEqual(width, step)
                self.assertGreaterEqual(height, step)

    def test_orientations_are_mirrored(self):
        landscape = self.select(aspect_ratio="16:9 (Landscape)")
        portrait = self.select(aspect_ratio="9:16 (Portrait)")
        self.assertEqual(landscape, tuple(reversed(portrait)))
        self.assertGreater(landscape[0], landscape[1])

    def test_aspect_and_pixel_count_stay_close_to_the_request(self):
        for label in module.ASPECT_RATIOS:
            wanted = module.parse_aspect(label)
            for divisor in module.DIVISORS:
                for megapixels in (0.5, 1.0, 2.0, 4.5):
                    width, height = self.select(
                        aspect_ratio=label, divisible_by=divisor, megapixels=megapixels
                    )
                    self.assertAlmostEqual(
                        width / height, wanted, delta=wanted * 0.05, msg=(label, divisor)
                    )
                    pixels = width * height
                    target = megapixels * module.PIXELS_PER_MEGAPIXEL
                    self.assertAlmostEqual(pixels, target, delta=target * 0.12)

    def test_megapixels_scale_the_result(self):
        one = self.select(megapixels=1.0)
        four = self.select(megapixels=4.0)
        self.assertEqual(four, (2048, 2048))
        self.assertGreater(four[0], one[0])

    def test_fractional_megapixels(self):
        # 0.25 MP is half the edge length of 1 MP.
        self.assertEqual(self.select(megapixels=0.25), (512, 512))
        half = self.select(megapixels=0.5)
        self.assertLess(half[0], 1024)
        self.assertGreater(half[0], 512)

    def test_an_empty_budget_is_rejected(self):
        with self.assertRaises(ValueError):
            self.select(megapixels=0.0)

    def test_connected_image_overrides_the_widget(self):
        width, height = self.select(aspect_ratio="1:1", image=FakeImage(1920, 1080))
        self.assertAlmostEqual(width / height, 1920 / 1080, delta=0.05)
        self.assertNotEqual(width, height)

    def test_node_metadata(self):
        self.assertEqual(ResolutionAspectSelector.RETURN_TYPES, ("INT", "INT"))
        self.assertEqual(ResolutionAspectSelector.RETURN_NAMES, ("width", "height"))
        inputs = ResolutionAspectSelector.INPUT_TYPES()
        self.assertIn("image", inputs["optional"])
        self.assertEqual(set(inputs["required"]), {"aspect_ratio", "megapixels", "divisible_by"})

    def test_megapixels_is_a_float_widget(self):
        kind, options = ResolutionAspectSelector.INPUT_TYPES()["required"]["megapixels"]
        self.assertEqual(kind, "FLOAT")
        self.assertEqual(options["default"], 1.0)
        self.assertIsInstance(options["default"], float)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
