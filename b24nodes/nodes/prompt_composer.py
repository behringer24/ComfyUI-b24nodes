"""``Prompt Composer``: fill ``{{name}}`` placeholders of a prompt template."""

from __future__ import annotations

import re

# ``{{color}}``, ``{{ color }}``, ``{{hair_color}}``. ``\w`` is Unicode aware, so
# ``{{größe}}`` works as well; the frontend extension uses the same pattern.
PLACEHOLDER = re.compile(r"\{\{\s*(\w+)\s*\}\}")


def placeholder_names(template: str) -> list[str]:
    """Return the placeholder names of ``template`` in order of first appearance."""
    return list(dict.fromkeys(PLACEHOLDER.findall(template)))


def compose(template: str, values: dict) -> str:
    """Replace every placeholder of ``template`` with its entry in ``values``.

    The substitution runs in a single pass, so a value that itself contains
    ``{{...}}`` is inserted as is and not expanded again.
    """
    missing = [name for name in placeholder_names(template) if name not in values]
    if missing:
        listed = ", ".join(f"{{{{{name}}}}}" for name in missing)
        raise ValueError(f"No value connected for {listed}")
    return PLACEHOLDER.sub(lambda match: values[match.group(1)], template)


class PromptComposer:
    """Build a prompt from a template with ``{{name}}`` placeholders.

    The frontend extension adds one ``STRING`` input per placeholder name, so
    the values arrive as extra keyword arguments named after the placeholders.
    ComfyUI hands over every linked input, declared or not.
    """

    DESCRIPTION = (
        "Builds a prompt from a template. Every {{name}} in the template gets an "
        "input of the same name; all occurrences are replaced with the text that "
        "is connected there."
    )
    CATEGORY = "b24nodes/text"
    FUNCTION = "compose"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    OUTPUT_TOOLTIPS = ("The template with every placeholder replaced.",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "template": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "placeholder": (
                            "A {{color}} ceramic vase next to a {{color}} candle."
                        ),
                        "tooltip": (
                            "Prompt with {{name}} placeholders. Each name becomes an "
                            "input of the node."
                        ),
                    },
                ),
            },
        }

    def compose(self, template, **values):
        """Return the composed prompt; inputs without a placeholder are ignored."""
        return (compose(template, values),)
