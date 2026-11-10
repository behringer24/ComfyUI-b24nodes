"""Find out which base model a LoRA was trained for, for the Multi Lora Loader.

The answer comes from the safetensors header, which every trainer fills a bit
differently: kohya style files carry ``ss_base_model_version`` (``krea2``,
``sdxl_base_v1-0``), files with a model spec carry ``modelspec.architecture``
(``krea2/lora``, ``stable-diffusion-xl-v1-base/lora``). Files without either are
matched by name, and fall back to ``None``.

Pony and Illustrious are SDXL models, so their LoRAs say ``sdxl`` as well. They
are told apart by the checkpoint the LoRA was trained on, a ``score_9`` tag
(Pony only) and the file name; a LoRA with no clear hint stays plain ``SDXL``.
"""

from __future__ import annotations

import json
import os
import re
import struct

import folder_paths

# The header of a LoRA is a few hundred KB at most; anything bigger is not one.
MAX_HEADER_BYTES = 64 * 1024 * 1024

# Label and the spellings that mean it, compared against the lower case value
# with spaces, dots, dashes and underscores removed. The first match wins.
FAMILIES = [
    ("Krea 2", ("krea2",)),
    ("Flux 2", ("flux2",)),
    ("Flux", ("flux",)),
    ("SDXL", ("sdxl", "stablediffusionxl")),
    ("SD 1.5", ("sdv1", "sd15", "sd1x", "stablediffusionv1")),
    ("SD 2", ("sdv2", "sd2x", "stablediffusionv2")),
    ("LTX", ("ltx",)),
    ("Wan", ("wan2",)),
    ("Qwen Image", ("qwenimage",)),
]

# Variants of a family: they behave like their parent, but LoRAs do not carry over.
PARENTS = {"Pony": "SDXL", "Illustrious": "SDXL"}

# Spellings of the variants in text that is not squashed (checkpoint names, file
# names). "il" only counts as a word of its own: "_IL", " IL", "ilxl".
VARIANT_PATTERNS = {
    "Pony": re.compile(r"pony(?!tail)|pdxl"),
    "Illustrious": re.compile(r"illustrious|noobai|(?<![a-z0-9])il(?:xl)?(?![a-z0-9])"),
}

# (mtime_ns, size, base) per file path, so a folder is only read once.
_cache: dict[str, tuple[int, int, str | None]] = {}


def family_of(text: str) -> str | None:
    """Known family label for a metadata value or a file name, else ``None``."""
    squashed = re.sub(r"[\s._-]", "", text.lower())
    for label, spellings in FAMILIES:
        if any(spelling in squashed for spelling in spellings):
            return label
    return None


def variants_in(text: str) -> set[str]:
    """Which of Pony and Illustrious a checkpoint or file name points to."""
    lowered = text.lower()
    return {label for label, pattern in VARIANT_PATTERNS.items() if pattern.search(lowered)}


def sdxl_variant(path: str, metadata: dict) -> str | None:
    """Pony or Illustrious for an SDXL LoRA, ``None`` when there is no clear hint.

    The sources are asked in order of reliability; the first one that names
    exactly one variant decides, and one that names both (``..._pony_IL``) is a
    conflict that leaves the LoRA at plain SDXL.
    """
    tags = metadata.get("ss_tag_frequency")
    trained_on = " ".join(str(metadata.get(key, "")) for key in ("ss_sd_model_name", "modelspec.title"))
    sources = (
        {"Pony"} if isinstance(tags, str) and "score_9" in tags else set(),
        variants_in(trained_on),
        variants_in(os.path.splitext(os.path.basename(path))[0]),
    )
    for found in sources:
        if len(found) == 1:
            return next(iter(found))
        if found:
            return None
    return None


def read_metadata(path: str) -> dict:
    """The ``__metadata__`` block of a safetensors file, empty when unreadable."""
    try:
        with open(path, "rb") as handle:
            (length,) = struct.unpack("<Q", handle.read(8))
            if length > MAX_HEADER_BYTES:
                return {}
            header = json.loads(handle.read(length))
    except (OSError, struct.error, ValueError):
        return {}
    metadata = header.get("__metadata__") if isinstance(header, dict) else None
    return metadata if isinstance(metadata, dict) else {}


def base_model_of(path: str, metadata: dict) -> str | None:
    """Base model label of a LoRA: the metadata first, then the file name."""
    label = None
    for key in ("modelspec.architecture", "ss_base_model_version"):
        value = metadata.get(key)
        if isinstance(value, str) and value.strip():
            # A family this module does not know still makes a usable label.
            label = family_of(value) or value.strip().removesuffix("/lora")
            break
    else:
        label = family_of(os.path.splitext(os.path.basename(path))[0])
    if label in (None, "SDXL"):
        return sdxl_variant(path, metadata) or label
    return label


def list_loras() -> list[dict]:
    """Every LoRA of the ``loras`` folders as ``{"name", "base"}``."""
    entries = []
    for name in folder_paths.get_filename_list("loras"):
        path = folder_paths.get_full_path("loras", name)
        try:
            stat = os.stat(path)
        except (OSError, TypeError):
            continue
        cached = _cache.get(path)
        if cached and cached[:2] == (stat.st_mtime_ns, stat.st_size):
            base = cached[2]
        else:
            metadata = read_metadata(path) if path.endswith(".safetensors") else {}
            base = base_model_of(path, metadata)
            _cache[path] = (stat.st_mtime_ns, stat.st_size, base)
        entries.append({"name": name, "base": base})
    return entries
