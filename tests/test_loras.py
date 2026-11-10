"""Tests for the LoRA base model detection of the Multi Lora Loader.

``folder_paths`` is replaced by a stand-in that points at a temporary folder, so
the tests run without a ComfyUI installation.

Run them from the pack root with::

    python -m unittest discover -s tests
"""

from __future__ import annotations

import importlib
import json
import os
import struct
import sys
import tempfile
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

LORA_DIR = tempfile.TemporaryDirectory()
fake_folder_paths = types.SimpleNamespace(
    get_filename_list=lambda folder: sorted(os.listdir(LORA_DIR.name)),
    get_full_path=lambda folder, name: os.path.join(LORA_DIR.name, name),
)
with mock.patch.dict(sys.modules, {"folder_paths": fake_folder_paths}):
    loras = importlib.import_module(f"{PACKAGE_ALIAS}.loras")


def write_safetensors(name, metadata=None):
    header = {"w": {"dtype": "F16", "shape": [1], "data_offsets": [0, 2]}}
    if metadata is not None:
        header["__metadata__"] = metadata
    blob = json.dumps(header).encode()
    with open(os.path.join(LORA_DIR.name, name), "wb") as handle:
        handle.write(struct.pack("<Q", len(blob)) + blob + b"\0\0")


class FamilyTests(unittest.TestCase):
    def test_spellings_of_one_family(self):
        for value in ("krea2", "krea2/lora", "Krea-2/lora", "krea_2"):
            self.assertEqual(loras.family_of(value), "Krea 2", value)
        for value in ("sdxl_base_v1-0", "stable-diffusion-xl-v1-base/lora", "sdxl_1.0"):
            self.assertEqual(loras.family_of(value), "SDXL", value)
        for value in ("sd_v1", "sd_1.5", "stable-diffusion-v1/lora"):
            self.assertEqual(loras.family_of(value), "SD 1.5", value)

    def test_flux2_is_not_flux(self):
        self.assertEqual(loras.family_of("flux-2-dev/lora"), "Flux 2")
        self.assertEqual(loras.family_of("flux1"), "Flux")

    def test_unknown_text_has_no_family(self):
        self.assertIsNone(loras.family_of("my_favourite_style"))

    def test_wan_needs_its_version(self):
        self.assertEqual(loras.family_of("wan2.2-i2v"), "Wan")
        self.assertIsNone(loras.family_of("swan_lake_style"))


class BaseModelTests(unittest.TestCase):
    def test_architecture_wins_over_trainer_version(self):
        metadata = {"modelspec.architecture": "krea2/lora", "ss_base_model_version": "sdxl_base_v1-0"}
        self.assertEqual(loras.base_model_of("a.safetensors", metadata), "Krea 2")

    def test_trainer_version_is_used_without_architecture(self):
        self.assertEqual(loras.base_model_of("a.safetensors", {"ss_base_model_version": "flux1"}), "Flux")

    def test_unknown_architecture_keeps_its_name(self):
        self.assertEqual(loras.base_model_of("a.safetensors", {"modelspec.architecture": "newmodel-v3/lora"}), "newmodel-v3")

    def test_file_name_is_the_last_resort(self):
        self.assertEqual(loras.base_model_of("city_lights_krea2_v1.safetensors", {}), "Krea 2")
        self.assertIsNone(loras.base_model_of("style_v1.safetensors", {}))

    def test_empty_metadata_values_are_ignored(self):
        self.assertIsNone(loras.base_model_of("style.safetensors", {"ss_base_model_version": "  "}))


class ListTests(unittest.TestCase):
    def setUp(self):
        for name in os.listdir(LORA_DIR.name):
            os.remove(os.path.join(LORA_DIR.name, name))
        loras._cache.clear()

    def test_list_reads_the_headers(self):
        write_safetensors("a.safetensors", {"ss_base_model_version": "krea2"})
        write_safetensors("b.safetensors")
        write_safetensors("c_flux_style.safetensors")
        self.assertEqual(
            loras.list_loras(),
            [
                {"name": "a.safetensors", "base": "Krea 2"},
                {"name": "b.safetensors", "base": None},
                {"name": "c_flux_style.safetensors", "base": "Flux"},
            ],
        )

    def test_unreadable_file_is_listed_without_base(self):
        with open(os.path.join(LORA_DIR.name, "broken.safetensors"), "wb") as handle:
            handle.write(b"not a safetensors file")
        self.assertEqual(loras.list_loras(), [{"name": "broken.safetensors", "base": None}])

    def test_unchanged_file_is_not_read_again(self):
        write_safetensors("a.safetensors", {"ss_base_model_version": "krea2"})
        loras.list_loras()
        with mock.patch.object(loras, "read_metadata", side_effect=AssertionError("read again")):
            self.assertEqual(loras.list_loras()[0]["base"], "Krea 2")


if __name__ == "__main__":
    unittest.main()
