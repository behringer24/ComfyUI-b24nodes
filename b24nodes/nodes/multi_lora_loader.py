"""``Multi Lora Loader``: apply any number of LoRAs with one node."""

from __future__ import annotations

import json

import comfy.sd
import comfy.utils
import folder_paths


def parse_rows(value: str) -> list[dict]:
    """Rows stored in the ``loras`` widget: ``[{"on": true, "lora": "a.safetensors", "strength": 1.0}, ...]``."""
    try:
        rows = json.loads(value) if value.strip() else []
    except json.JSONDecodeError as error:
        raise ValueError(f"Multi Lora Loader: the LoRA list is not valid JSON ({error})") from error
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise ValueError("Multi Lora Loader: the LoRA list must be a list of rows")
    return rows


class MultiLoraLoader:
    """Apply a list of LoRAs to a model and a CLIP.

    Every row has an on/off switch, a LoRA and a strength that is used for both
    the model and the CLIP. The rows live in one JSON string widget, which the
    frontend extension edits through regular widgets; API clients can send the
    JSON directly.
    """

    DESCRIPTION = (
        "Applies several LoRAs in order. Each row has a switch, a LoRA and a strength "
        "(used for the model and the CLIP). Use the + button to add rows."
    )
    CATEGORY = "b24nodes/loaders"
    FUNCTION = "load_loras"
    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("MODEL", "CLIP")
    OUTPUT_TOOLTIPS = ("The model with the enabled LoRAs applied.", "The CLIP with the enabled LoRAs applied.")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "loras": ("STRING", {"default": "[]", "tooltip": "LoRA rows as JSON, edited by the rows of the node."}),
            },
            "optional": {
                "model": ("MODEL", {"tooltip": "The diffusion model the LoRAs are applied to."}),
                "clip": ("CLIP", {"tooltip": "The CLIP model the LoRAs are applied to."}),
            },
        }

    def load_loras(self, loras, model=None, clip=None):
        """Apply every enabled row with a non-zero strength, top to bottom."""
        for row in parse_rows(loras):
            name = row.get("lora")
            strength = float(row.get("strength", 1.0))
            if not row.get("on", True) or not name or strength == 0:
                continue
            path = folder_paths.get_full_path_or_raise("loras", name)
            lora, metadata = comfy.utils.load_torch_file(path, safe_load=True, return_metadata=True)
            model, clip = comfy.sd.load_lora_for_models(model, clip, lora, strength, strength, lora_metadata=metadata)
        return (model, clip)
