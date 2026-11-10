"""Tests for the Prompt Composer and Color Picker nodes.

Like the other tests these run without a ComfyUI installation: the modules are
imported under a synthetic package name so the pack ``__init__`` (which needs
the ComfyUI server) is not executed.

Run them from the pack root with::

    python -m unittest discover -s tests
"""

from __future__ import annotations

import importlib
import re
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

prompt_composer = importlib.import_module(f"{PACKAGE_ALIAS}.nodes.prompt_composer")
color_picker = importlib.import_module(f"{PACKAGE_ALIAS}.nodes.color_picker")
PromptComposer = prompt_composer.PromptComposer
ColorPicker = color_picker.ColorPicker

TEMPLATE = (
    "A {{color}} ceramic vase on a table, next to a {{color}} candle, "
    "and a {{ color }} ribbon."
)


class PlaceholderNameTests(unittest.TestCase):
    def test_names_are_unique_and_ordered(self):
        names = prompt_composer.placeholder_names("{{b}} {{a}} {{b}} {{ c }}")
        self.assertEqual(names, ["b", "a", "c"])

    def test_unicode_names(self):
        self.assertEqual(prompt_composer.placeholder_names("{{größe}}"), ["größe"])

    def test_non_placeholders_are_ignored(self):
        self.assertEqual(prompt_composer.placeholder_names("{color} {{}} {{two words}}"), [])


class ComposeTests(unittest.TestCase):
    def test_every_occurrence_is_replaced(self):
        (prompt,) = PromptComposer().compose(TEMPLATE, color="pastel pink")
        self.assertEqual(
            prompt,
            "A pastel pink ceramic vase on a table, next to a pastel pink candle, "
            "and a pastel pink ribbon.",
        )

    def test_several_variables(self):
        (prompt,) = PromptComposer().compose("{{a}} and {{b}}", a="cat", b="dog")
        self.assertEqual(prompt, "cat and dog")

    def test_template_without_placeholders_passes_through(self):
        (prompt,) = PromptComposer().compose("a plain prompt")
        self.assertEqual(prompt, "a plain prompt")

    def test_inputs_without_placeholder_are_ignored(self):
        (prompt,) = PromptComposer().compose("{{a}}", a="x", stale="y")
        self.assertEqual(prompt, "x")

    def test_values_are_not_expanded_again(self):
        (prompt,) = PromptComposer().compose("{{a}} {{b}}", a="{{b}}", b="x")
        self.assertEqual(prompt, "{{b}} x")

    def test_empty_value_is_allowed(self):
        (prompt,) = PromptComposer().compose("a{{a}}b", a="")
        self.assertEqual(prompt, "ab")

    def test_missing_value_names_every_placeholder(self):
        with self.assertRaises(ValueError) as caught:
            PromptComposer().compose("{{a}} {{b}} {{c}}", b="x")
        self.assertIn("{{a}}", str(caught.exception))
        self.assertIn("{{c}}", str(caught.exception))
        self.assertNotIn("{{b}}", str(caught.exception))


class ColorPickerTests(unittest.TestCase):
    def test_names_are_unique(self):
        self.assertEqual(len(color_picker.COLOR_NAMES), len(set(color_picker.COLOR_NAMES)))

    def test_hex_values_are_well_formed(self):
        for _, colors in color_picker.COLOR_GROUPS:
            for name, hex_value in colors:
                self.assertRegex(hex_value, re.compile(r"^#[0-9A-F]{6}$"), name)

    def test_hair_names_say_hair(self):
        groups = dict(color_picker.COLOR_GROUPS)
        hair = groups[color_picker.HAIR_GROUP]
        self.assertTrue(hair)
        for name, _ in hair:
            self.assertTrue(name.endswith(" hair"), name)
        for group, colors in color_picker.COLOR_GROUPS:
            if group != color_picker.HAIR_GROUP:
                for name, _ in colors:
                    self.assertFalse(name.endswith(" hair"), name)

    def test_default_is_a_palette_entry(self):
        names, options = ColorPicker.INPUT_TYPES()["required"]["color"]
        self.assertIn(options["default"], names)

    def test_outputs_the_name(self):
        self.assertEqual(ColorPicker().pick("deep blue"), ("deep blue",))


if __name__ == "__main__":
    unittest.main()
