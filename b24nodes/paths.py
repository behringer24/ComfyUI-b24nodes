"""Helpers for browsing ComfyUI's ``input`` directory.

Every folder value handled here is a *relative*, POSIX style path below the
ComfyUI input directory, where an empty string means the input root itself.
Values coming from the frontend or from a stored workflow are always run
through :func:`normalize_folder` before they are joined with the input
directory, so ``..`` segments, absolute paths and Windows drive letters can not
be used to read files outside of the input directory.

Normalization alone is not enough on Windows: ``os.path.join`` treats a segment
such as ``C:`` as a drive specification and silently drops everything in front
of it, which normalization can not catch for segments that merely *contain* a
colon. Every path built here is therefore assembled by :func:`_join_below`,
which rejects any result that does not end up below the input root.
"""

from __future__ import annotations

import io
import os
import re

import folder_paths
from PIL import Image, ImageOps

# Image formats that ComfyUI's Pillow based loader can open.
IMAGE_EXTENSIONS = frozenset(
    {
        ".png",
        ".jpg",
        ".jpeg",
        ".jfif",
        ".webp",
        ".bmp",
        ".gif",
        ".tif",
        ".tiff",
        ".ppm",
        ".pgm",
    }
)

# Combo widgets can not hold an empty string in a meaningful way, so the input
# root is presented as "/" in the UI and translated back to "" internally.
ROOT_LABEL = "/"

# Safety net for very large collections: the recursive folder list is capped so
# that a huge input directory can not stall the frontend or the /object_info
# response.
MAX_TREE_ENTRIES = 2000

# Longest side of the thumbnails shown by the image browser of the frontend.
THUMBNAIL_SIZE = 256

# Folders that are never offered in the UI.
_IGNORED_FOLDERS = frozenset({"__pycache__", "$RECYCLE.BIN", "System Volume Information"})


def _is_hidden(name: str) -> bool:
    """True for dot folders and for folders that are never interesting."""
    return name.startswith(".") or name in _IGNORED_FOLDERS


def _natural_key(name: str) -> list:
    """Sort key that orders embedded numbers numerically (img2 before img10)."""
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", name)]


def get_input_root() -> str:
    """Absolute path of the ComfyUI input directory."""
    return os.path.abspath(folder_paths.get_input_directory())


def _is_below_root(path: str, root: str) -> bool:
    """True if ``path`` is ``root`` itself or something below it."""
    root = os.path.normcase(os.path.abspath(root))
    path = os.path.normcase(os.path.abspath(path))
    return path == root or path.startswith(root + os.sep)


def _join_below(root: str, *parts: str) -> str:
    """Join path segments below ``root`` and refuse to leave it.

    Verifying the joined result is what stops a segment like ``C:`` (or any
    other value that makes ``os.path.join`` discard ``root``) from reaching the
    file system. The check runs on the *logical* path, not on ``realpath``, so
    symlinks and junctions that point outside of ``input/`` keep working.

    Raises:
        ValueError: if the joined path would point outside of ``root``.
    """
    joined = os.path.join(root, *parts)
    if not _is_below_root(joined, root):
        raise ValueError("Path is not below the ComfyUI input directory")
    return joined


def normalize_folder(folder: str | None) -> str:
    """Turn a widget/query value into a clean relative folder path.

    Returns ``""`` for the input root. ``..`` segments are resolved against the
    already collected segments and can never walk above the root.
    """
    if folder is None:
        return ""

    value = str(folder).replace("\\", "/").strip()
    if value in ("", ".", ROOT_LABEL):
        return ""

    # "C:/foo" -> "/foo": drop a drive letter so the path stays relative.
    if len(value) > 1 and value[1] == ":":
        value = value[2:]

    parts: list[str] = []
    for part in value.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        parts.append(part)
    return "/".join(parts)


def display_folder(folder: str) -> str:
    """Widget representation of a normalized folder path."""
    return ROOT_LABEL if folder == "" else folder


def parent_folder(folder: str) -> str | None:
    """Parent of a normalized folder path, or ``None`` for the input root."""
    folder = normalize_folder(folder)
    if folder == "":
        return None
    return folder.rsplit("/", 1)[0] if "/" in folder else ""


def resolve_folder(folder: str | None) -> str:
    """Absolute path of a folder below the input directory.

    Raises:
        ValueError: if the value would point outside of the input directory.
    """
    relative = normalize_folder(folder)
    root = get_input_root()
    return _join_below(root, *relative.split("/")) if relative else root


def split_image_value(folder: str | None, image: str | None) -> tuple[str, str]:
    """Split the two widget values into ``(relative_folder, filename)``.

    The image value may itself contain folder segments - that happens when a
    workflow was built with the core ``Load Image`` node or when an API client
    passes ``"portraits/2024/shot.png"`` - so those segments are merged into the
    folder part.
    """
    raw = str(image or "").replace("\\", "/").strip()
    filename = raw.rsplit("/", 1)[-1]
    nested = raw[: len(raw) - len(filename)]
    relative = normalize_folder(f"{normalize_folder(folder)}/{nested}")
    return relative, filename


def resolve_image(folder: str | None, image: str | None) -> str:
    """Absolute path of the selected image.

    Raises:
        ValueError: if nothing is selected, or if the selection would point
            outside of the input directory.
    """
    relative, filename = split_image_value(folder, image)
    if filename in ("", ".", ".."):
        raise ValueError("No image selected")
    return _join_below(resolve_folder(relative), filename)


def relative_image(folder: str | None, image: str | None) -> str:
    """Human readable ``folder/file`` label, used for error messages."""
    relative, filename = split_image_value(folder, image)
    return f"{relative}/{filename}" if relative else filename


def is_image_file(name: str) -> bool:
    """True if the file name looks like an image ComfyUI can load."""
    return os.path.splitext(name)[1].lower() in IMAGE_EXTENSIONS


def list_subfolders(folder: str | None) -> list[str]:
    """Names of the direct sub folders of ``folder`` (not recursive)."""
    try:
        with os.scandir(resolve_folder(folder)) as entries:
            names = [e.name for e in entries if e.is_dir() and not _is_hidden(e.name)]
    except (OSError, ValueError):
        return []
    return sorted(names, key=_natural_key)


def list_images(folder: str | None) -> list[str]:
    """Names of the loadable image files inside ``folder``."""
    try:
        with os.scandir(resolve_folder(folder)) as entries:
            names = [e.name for e in entries if e.is_file() and is_image_file(e.name)]
    except (OSError, ValueError):
        return []
    return sorted(names, key=_natural_key)


def folder_exists(folder: str | None) -> bool:
    """True if the folder exists below the input directory."""
    try:
        return os.path.isdir(resolve_folder(folder))
    except ValueError:
        return False


def list_tree(limit: int = MAX_TREE_ENTRIES) -> tuple[list[str], bool]:
    """Every folder below the input directory as a relative path.

    Symlinks and Windows junctions are followed, so a collection that lives
    outside of ComfyUI can be linked into ``input/``. Already visited real paths
    are skipped, which keeps the walk free of link cycles.

    Returns:
        The sorted folder list and a flag telling whether ``limit`` cut it off.
    """
    root = get_input_root()
    found: list[str] = []
    visited: set[str] = set()
    truncated = False

    for current, dirnames, _ in os.walk(root, followlinks=True):
        real_path = os.path.realpath(current)
        if real_path in visited:
            # A link pointing back into an already listed folder: do not recurse.
            dirnames[:] = []
            continue
        visited.add(real_path)

        # Prune in place so os.walk does not descend into ignored folders.
        dirnames[:] = sorted((d for d in dirnames if not _is_hidden(d)), key=_natural_key)
        relative = os.path.relpath(current, root).replace(os.sep, "/")
        prefix = "" if relative == "." else f"{relative}/"
        found.extend(f"{prefix}{name}" for name in dirnames)
        if len(found) >= limit:
            truncated = True
            del found[limit:]
            break

    return sorted(found, key=_natural_key), truncated


def render_thumbnail(image_path: str, size: int = THUMBNAIL_SIZE) -> bytes:
    """WEBP thumbnail of an image file, ``size`` pixels on the longest side at most.

    The orientation and the 32 bit integer scaling follow the Load Image Path
    node, so the thumbnail looks like what the node will load. Only the first
    frame of an animation is used.
    """
    with Image.open(image_path) as opened:
        # JPEGs are decoded at a reduced scale right away, which makes large
        # photos several times cheaper; other formats ignore the hint.
        opened.draft(None, (size, size))
        frame = ImageOps.exif_transpose(opened)
        if frame.mode == "I":
            frame = frame.point(lambda value: value * (1 / 255))
        frame = frame.convert("RGBA")
        frame.thumbnail((size, size))

    buffer = io.BytesIO()
    frame.save(buffer, format="WEBP", quality=80)
    return buffer.getvalue()
