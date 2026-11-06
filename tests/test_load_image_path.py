"""Tests for the path helpers and for the Load Image Path node.

The tests run without a ComfyUI installation: ``folder_paths`` is replaced by a
stub that points at a temporary input directory, and the pack modules are
imported under a synthetic package name so that the pack ``__init__`` (which
needs the ComfyUI server) is not executed.

Run them from the pack root with::

    python -m unittest discover -s tests
"""

from __future__ import annotations

import importlib
import io
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

PACK_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ALIAS = "b24nodes_under_test"

# Stub of ComfyUI's folder_paths module. The input directory is swapped per test.
folder_paths_stub = types.ModuleType("folder_paths")
folder_paths_stub.input_directory = ""
folder_paths_stub.get_input_directory = lambda: folder_paths_stub.input_directory
sys.modules.setdefault("folder_paths", folder_paths_stub)

# Expose ``b24nodes`` under an alias without running its __init__.
_package = types.ModuleType(PACKAGE_ALIAS)
_package.__path__ = [str(PACK_ROOT / "b24nodes")]
sys.modules[PACKAGE_ALIAS] = _package

paths = importlib.import_module(f"{PACKAGE_ALIAS}.paths")
load_image_path = importlib.import_module(f"{PACKAGE_ALIAS}.nodes.load_image_path")
LoadImagePath = load_image_path.LoadImagePath


def write_image(path: Path, size=(4, 3), mode="RGB", color=(255, 0, 0)) -> Path:
    """Create a small image file for the loader tests."""
    from PIL import Image

    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new(mode, size, color).save(path)
    return path


def foreign_drive(root: Path) -> str:
    """A Windows drive letter that differs from the one ``root`` lives on.

    Only a *different* drive makes ``os.path.join`` discard the root; the same
    drive letter is joined as a relative name and stays inside the directory.
    """
    root_drive = os.path.splitdrive(os.path.abspath(str(root)))[0].rstrip(":").upper()
    return "D" if root_drive == "C" else "C"


class PathHelperTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "input"
        self.root.mkdir()
        folder_paths_stub.input_directory = str(self.root)
        self.addCleanup(self._tmp.cleanup)

    def test_normalize_folder_handles_widget_values(self):
        self.assertEqual(paths.normalize_folder(None), "")
        self.assertEqual(paths.normalize_folder(""), "")
        self.assertEqual(paths.normalize_folder("/"), "")
        self.assertEqual(paths.normalize_folder("."), "")
        self.assertEqual(paths.normalize_folder("portraits"), "portraits")
        self.assertEqual(paths.normalize_folder("portraits/2024/"), "portraits/2024")
        self.assertEqual(paths.normalize_folder("portraits\\2024"), "portraits/2024")
        self.assertEqual(paths.normalize_folder("  portraits/2024  "), "portraits/2024")

    def test_normalize_folder_never_escapes_the_input_root(self):
        self.assertEqual(paths.normalize_folder(".."), "")
        self.assertEqual(paths.normalize_folder("../../etc"), "etc")
        self.assertEqual(paths.normalize_folder("portraits/../../../etc"), "etc")
        self.assertEqual(paths.normalize_folder("/etc/passwd"), "etc/passwd")
        self.assertEqual(paths.normalize_folder("C:/Windows/System32"), "Windows/System32")

    def test_resolve_folder_stays_below_the_input_root(self):
        resolved = paths.resolve_folder("../../somewhere/else")
        self.assertTrue(
            os.path.abspath(resolved).startswith(os.path.abspath(str(self.root)) + os.sep)
        )

    def test_parent_and_display_folder(self):
        self.assertIsNone(paths.parent_folder(""))
        self.assertEqual(paths.parent_folder("portraits"), "")
        self.assertEqual(paths.parent_folder("portraits/2024/raw"), "portraits/2024")
        self.assertEqual(paths.display_folder(""), paths.ROOT_LABEL)
        self.assertEqual(paths.display_folder("portraits"), "portraits")

    def test_split_image_value_merges_nested_file_names(self):
        self.assertEqual(paths.split_image_value("", "shot.png"), ("", "shot.png"))
        self.assertEqual(
            paths.split_image_value("portraits", "2024/shot.png"), ("portraits/2024", "shot.png")
        )
        self.assertEqual(
            paths.split_image_value("portraits/2024", "../shot.png"), ("portraits", "shot.png")
        )

    def test_resolve_image_never_leaves_the_input_root(self):
        # Values that made os.path.join drop the input root before _join_below
        # existed: a segment that looks like a Windows drive re-roots the path.
        drive = foreign_drive(self.root)
        hostile = [
            ("/", f"{drive}:evil.png"),
            (f"portraits/{drive}:", "evil.png"),
            ("portraits", f"{drive}:/evil.png"),
            ("..", "../evil.png"),
            ("/", "//server/share/evil.png"),
        ]
        root = os.path.normcase(os.path.abspath(str(self.root)))

        for folder, image in hostile:
            with self.subTest(folder=folder, image=image):
                try:
                    resolved = paths.resolve_image(folder, image)
                except ValueError:
                    continue  # Rejected outright, which is the Windows behaviour.
                # Otherwise (e.g. on POSIX, where "C:" is a legal folder name)
                # the path must still be contained in the input directory.
                resolved = os.path.normcase(os.path.abspath(resolved))
                self.assertTrue(resolved.startswith(root + os.sep), resolved)

    @unittest.skipUnless(os.name == "nt", "drive letters only re-root paths on Windows")
    def test_resolve_image_rejects_windows_drive_segments(self):
        # A drive letter that differs from the one the input root lives on is
        # what makes os.path.join discard the root; the same drive letter is
        # joined as a relative name and stays inside the input directory.
        foreign = foreign_drive(self.root)

        with self.assertRaises(ValueError):
            paths.resolve_image("/", f"{foreign}:evil.png")
        with self.assertRaises(ValueError):
            paths.resolve_folder(f"portraits/{foreign}:")

    def test_listings_stay_empty_for_rejected_paths(self):
        # The HTTP routes call these helpers with unchecked query values, so a
        # rejected path has to degrade to an empty listing instead of raising.
        hostile = f"portraits/{foreign_drive(self.root)}:"

        self.assertEqual(paths.list_images(hostile), [])
        self.assertEqual(paths.list_subfolders(hostile), [])
        self.assertFalse(paths.folder_exists(hostile))

    def test_resolve_image_requires_a_selection(self):
        with self.assertRaises(ValueError):
            paths.resolve_image("portraits", "")
        with self.assertRaises(ValueError):
            paths.resolve_image("portraits", "..")

    def test_listings_skip_hidden_and_non_image_entries(self):
        write_image(self.root / "b.png")
        write_image(self.root / "a10.png")
        write_image(self.root / "a2.png")
        (self.root / "notes.txt").write_text("ignored", encoding="utf-8")
        (self.root / ".hidden").mkdir()
        (self.root / "__pycache__").mkdir()
        (self.root / "portraits").mkdir()

        # Numbers are sorted numerically, not alphabetically.
        self.assertEqual(paths.list_images(""), ["a2.png", "a10.png", "b.png"])
        self.assertEqual(paths.list_subfolders(""), ["portraits"])

    def test_list_tree_returns_every_folder_as_relative_path(self):
        (self.root / "portraits" / "2024" / "raw").mkdir(parents=True)
        (self.root / "landscapes").mkdir()

        folders, truncated = paths.list_tree()
        self.assertEqual(
            folders, ["landscapes", "portraits", "portraits/2024", "portraits/2024/raw"]
        )
        self.assertFalse(truncated)

    def test_list_tree_reports_truncation(self):
        for index in range(5):
            (self.root / f"folder{index}").mkdir()

        folders, truncated = paths.list_tree(limit=3)
        self.assertEqual(len(folders), 3)
        self.assertTrue(truncated)

    def test_folder_exists(self):
        (self.root / "portraits").mkdir()
        self.assertTrue(paths.folder_exists("portraits"))
        self.assertFalse(paths.folder_exists("portraits/2024"))
        self.assertTrue(paths.folder_exists("/"))


class RenderThumbnailTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def render(self, path: Path):
        from PIL import Image

        return Image.open(io.BytesIO(paths.render_thumbnail(str(path))))

    def test_long_side_is_scaled_to_the_thumbnail_size(self):
        thumb = self.render(write_image(self.root / "wide.png", size=(1024, 512)))
        self.assertEqual(thumb.format, "WEBP")
        self.assertEqual(thumb.size, (paths.THUMBNAIL_SIZE, paths.THUMBNAIL_SIZE // 2))

    def test_small_images_are_not_enlarged(self):
        thumb = self.render(write_image(self.root / "small.png", size=(40, 30)))
        self.assertEqual(thumb.size, (40, 30))

    def test_large_jpeg_uses_the_reduced_decoder(self):
        thumb = self.render(write_image(self.root / "photo.jpg", size=(3000, 2000)))
        self.assertEqual(thumb.size, (256, 171))

    def test_exif_orientation_is_applied(self):
        from PIL import Image

        path = self.root / "rotated.jpg"
        exif = Image.Exif()
        exif[0x0112] = 6  # stored landscape, displayed rotated by 90 degrees
        Image.new("RGB", (400, 200), (0, 0, 255)).save(path, exif=exif)
        self.assertEqual(self.render(path).size, (128, 256))

    def test_transparency_is_kept(self):
        thumb = self.render(write_image(self.root / "alpha.png", mode="RGBA", color=(255, 0, 0, 0)))
        self.assertEqual(thumb.convert("RGBA").getpixel((0, 0))[3], 0)

    def test_unreadable_file_raises(self):
        broken = self.root / "broken.png"
        broken.write_bytes(b"not an image")
        with self.assertRaises(OSError):
            paths.render_thumbnail(str(broken))


class LoadImagePathNodeTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "input"
        self.root.mkdir()
        folder_paths_stub.input_directory = str(self.root)
        self.addCleanup(self._tmp.cleanup)
        self.node = LoadImagePath()

    def test_input_types_offer_the_root_and_every_folder(self):
        (self.root / "portraits" / "2024").mkdir(parents=True)
        write_image(self.root / "root.png")

        inputs = LoadImagePath.INPUT_TYPES()["required"]
        self.assertEqual(inputs["folder"][0], [paths.ROOT_LABEL, "portraits", "portraits/2024"])
        self.assertEqual(inputs["image"][0], ["root.png"])

    def test_load_image_returns_image_and_empty_mask(self):
        write_image(self.root / "portraits" / "2024" / "shot.png", size=(4, 3))

        image, mask = self.node.load_image("portraits/2024", "shot.png")
        self.assertEqual(tuple(image.shape), (1, 3, 4, 3))  # batch, height, width, channels
        self.assertEqual(tuple(mask.shape), (1, 64, 64))
        self.assertAlmostEqual(float(image[0, 0, 0, 0]), 1.0, places=5)
        self.assertAlmostEqual(float(mask.max()), 0.0, places=5)

    def test_load_image_uses_the_alpha_channel_as_mask(self):
        write_image(self.root / "cutout.png", size=(2, 2), mode="RGBA", color=(0, 255, 0, 0))

        _, mask = self.node.load_image("/", "cutout.png")
        self.assertEqual(tuple(mask.shape), (1, 2, 2))
        self.assertAlmostEqual(float(mask.min()), 1.0, places=5)  # fully transparent = masked

    def test_load_image_accepts_a_nested_file_name(self):
        write_image(self.root / "portraits" / "shot.png")

        image, _ = self.node.load_image("/", "portraits/shot.png")
        self.assertEqual(image.shape[0], 1)

    def test_validate_inputs(self):
        write_image(self.root / "portraits" / "shot.png")
        (self.root / "notes.txt").write_text("not an image", encoding="utf-8")

        self.assertTrue(LoadImagePath.VALIDATE_INPUTS("portraits", "shot.png"))
        self.assertIsInstance(LoadImagePath.VALIDATE_INPUTS("portraits", ""), str)
        self.assertIsInstance(LoadImagePath.VALIDATE_INPUTS("portraits", "missing.png"), str)
        self.assertIsInstance(LoadImagePath.VALIDATE_INPUTS("/", "notes.txt"), str)

    def test_validate_inputs_rejects_paths_outside_the_input_directory(self):
        outside = Path(self._tmp.name) / "outside"
        write_image(outside / "secret.png")

        result = LoadImagePath.VALIDATE_INPUTS("../outside", "secret.png")
        self.assertIsInstance(result, str)

    def test_validate_inputs_rejects_a_drive_letter_escape(self):
        result = LoadImagePath.VALIDATE_INPUTS("/", f"{foreign_drive(self.root)}:evil.png")
        self.assertIsInstance(result, str)

    def test_is_changed_never_caches_a_rejected_path(self):
        value = LoadImagePath.IS_CHANGED("/", f"{foreign_drive(self.root)}:evil.png")
        self.assertNotEqual(value, value)  # NaN forces a re-run

    def test_is_changed_follows_the_file_content(self):
        target = write_image(self.root / "shot.png", color=(255, 0, 0))
        first = LoadImagePath.IS_CHANGED("/", "shot.png")
        self.assertEqual(first, LoadImagePath.IS_CHANGED("/", "shot.png"))

        write_image(target, color=(0, 0, 255))
        self.assertNotEqual(first, LoadImagePath.IS_CHANGED("/", "shot.png"))

    def test_is_changed_never_caches_a_missing_file(self):
        value = LoadImagePath.IS_CHANGED("/", "missing.png")
        self.assertNotEqual(value, value)  # NaN forces a re-run


if __name__ == "__main__":
    unittest.main()
