"""Tests for the Multi Lora Loader node.

The ComfyUI modules the node imports are replaced by small fakes, so the tests
run without a ComfyUI installation.

Run them from the pack root with::

    python -m unittest discover -s tests
"""

from __future__ import annotations

import importlib
import json
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

PACK_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ALIAS = "b24nodes_under_test"

if PACKAGE_ALIAS not in sys.modules:
    _package = types.ModuleType(PACKAGE_ALIAS)
    _package.__path__ = [str(PACK_ROOT / "b24nodes")]
    sys.modules[PACKAGE_ALIAS] = _package

calls = []


def fake_load_lora_for_models(model, clip, lora, strength_model, strength_clip, lora_metadata=None):
    calls.append((lora, strength_model, strength_clip))
    return f"{model}+{lora}", f"{clip}+{lora}"


def fake_get_full_path_or_raise(folder, name):
    if name == "missing.safetensors":
        raise FileNotFoundError(name)
    return f"/loras/{name}"


fake_modules = {
    "comfy": types.ModuleType("comfy"),
    "comfy.sd": types.SimpleNamespace(load_lora_for_models=fake_load_lora_for_models),
    "comfy.utils": types.SimpleNamespace(load_torch_file=lambda path, **_: (path, {"path": path})),
    "folder_paths": types.SimpleNamespace(get_full_path_or_raise=fake_get_full_path_or_raise),
}
with mock.patch.dict(sys.modules, fake_modules):
    multi_lora_loader = importlib.import_module(f"{PACKAGE_ALIAS}.nodes.multi_lora_loader")
    # ``import comfy.sd`` binds the name ``comfy``; give it the fake submodules.
    multi_lora_loader.comfy = types.SimpleNamespace(sd=fake_modules["comfy.sd"], utils=fake_modules["comfy.utils"])
MultiLoraLoader = multi_lora_loader.MultiLoraLoader


def rows(*entries):
    return json.dumps([dict(entry) for entry in entries])


class ParseRowsTests(unittest.TestCase):
    def test_empty_value_has_no_rows(self):
        self.assertEqual(multi_lora_loader.parse_rows(""), [])
        self.assertEqual(multi_lora_loader.parse_rows("[]"), [])

    def test_invalid_json_is_reported(self):
        with self.assertRaises(ValueError):
            multi_lora_loader.parse_rows("{nope")

    def test_rows_must_be_a_list_of_objects(self):
        for value in ('{"lora": "a"}', '["a"]', "3"):
            with self.assertRaises(ValueError, msg=value):
                multi_lora_loader.parse_rows(value)


class LoadLorasTests(unittest.TestCase):
    def setUp(self):
        calls.clear()

    def test_rows_are_applied_in_order(self):
        value = rows(
            {"on": True, "lora": "a.safetensors", "strength": 0.5},
            {"on": True, "lora": "b.safetensors", "strength": 1.2},
        )
        model, clip = MultiLoraLoader().load_loras(value, model="M", clip="C")
        self.assertEqual((model, clip), ("M+/loras/a.safetensors+/loras/b.safetensors", "C+/loras/a.safetensors+/loras/b.safetensors"))
        self.assertEqual([call[1:] for call in calls], [(0.5, 0.5), (1.2, 1.2)])

    def test_disabled_empty_and_zero_rows_are_skipped(self):
        value = rows(
            {"on": False, "lora": "a.safetensors", "strength": 1},
            {"on": True, "lora": "", "strength": 1},
            {"on": True, "lora": "b.safetensors", "strength": 0},
        )
        self.assertEqual(MultiLoraLoader().load_loras(value, model="M", clip="C"), ("M", "C"))
        self.assertEqual(calls, [])

    def test_negative_strength_is_applied(self):
        MultiLoraLoader().load_loras(rows({"lora": "a.safetensors", "strength": -0.7}), model="M", clip="C")
        self.assertEqual(calls[0][1:], (-0.7, -0.7))

    def test_model_and_clip_are_optional(self):
        model, clip = MultiLoraLoader().load_loras(rows({"lora": "a.safetensors", "strength": 1}))
        self.assertEqual((model, clip), ("None+/loras/a.safetensors", "None+/loras/a.safetensors"))

    def test_missing_file_fails_clearly(self):
        with self.assertRaises(FileNotFoundError):
            MultiLoraLoader().load_loras(rows({"lora": "missing.safetensors", "strength": 1}), model="M", clip="C")


if __name__ == "__main__":
    unittest.main()
