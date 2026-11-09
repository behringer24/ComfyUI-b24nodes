"""``Color Picker``: pick a color and output its name for use in a prompt."""

from __future__ import annotations

# Color names that read well in a prompt, grouped by family. The hex values are
# only used by the frontend extension to draw the swatches and to map a freely
# picked color onto the nearest name; the node itself outputs the name.
# The hair group names natural and dyed hair colors, every entry ends in "hair"
# so that the text cannot be mistaken for a clothing or object color. It is left
# out when a freely picked color is mapped onto the nearest name.
HAIR_GROUP = "Hair colors"
COLOR_GROUPS = [
    ("Neutrals", [
        ("white", "#FFFFFF"), ("off-white", "#F5F3EC"), ("ivory", "#FFFFF0"), ("cream", "#FFFDD0"),
        ("beige", "#E8DCC0"), ("light gray", "#D9D9D9"), ("gray", "#808080"), ("slate gray", "#708090"),
        ("dark gray", "#4A4A4A"), ("charcoal gray", "#36454F"), ("black", "#000000"),
    ]),
    ("Browns", [
        ("sand", "#D8C49A"), ("tan", "#D2B48C"), ("khaki", "#B5A67A"), ("camel", "#C19A6B"),
        ("taupe", "#8B7D72"), ("light brown", "#B5835A"), ("brown", "#8B5A2B"), ("cognac", "#9A463D"),
        ("chocolate brown", "#5C3317"), ("dark brown", "#3D2B1F"), ("rust", "#B7410E"), ("terracotta", "#E2725B"),
    ]),
    ("Reds", [
        ("red", "#FF0000"), ("crimson", "#DC143C"), ("brick red", "#A93226"), ("dark red", "#8B0000"),
        ("burgundy", "#800020"), ("wine red", "#722F37"), ("maroon", "#4E0F12"),
    ]),
    ("Pinks", [
        ("pastel pink", "#F8C8DC"), ("light pink", "#FFB6C1"), ("blush pink", "#E8A0A8"), ("pink", "#FF8FAB"),
        ("hot pink", "#FF69B4"), ("fuchsia", "#E0218A"), ("dusty rose", "#C0848F"), ("salmon", "#FA8072"),
        ("coral", "#FF7F50"), ("peach", "#FFCBA4"),
    ]),
    ("Oranges and yellows", [
        ("pastel orange", "#FFB347"), ("orange", "#FF8C00"), ("burnt orange", "#CC5500"), ("ochre", "#CC7722"),
        ("amber", "#FFBF00"), ("mustard yellow", "#E1AD01"), ("yellow", "#FFEA00"), ("lemon yellow", "#FFF44F"),
        ("pastel yellow", "#FDFD96"),
    ]),
    ("Greens", [
        ("mint green", "#98FF98"), ("pastel green", "#77DD77"), ("neon green", "#39FF14"), ("lime green", "#32CD32"),
        ("green", "#00A000"), ("emerald green", "#50C878"), ("jade green", "#00A86B"), ("sage green", "#9CAF88"),
        ("olive green", "#708238"), ("army green", "#4B5320"), ("forest green", "#228B22"), ("hunter green", "#355E3B"),
        ("dark green", "#013220"),
    ]),
    ("Cyans and teals", [
        ("aquamarine", "#7FFFD4"), ("cyan", "#00FFFF"), ("turquoise", "#40E0D0"), ("teal", "#008080"),
        ("petrol blue", "#005F6A"), ("dark teal", "#014D4E"),
    ]),
    ("Blues", [
        ("light blue", "#ADD8E6"), ("pastel blue", "#AEC6CF"), ("baby blue", "#89CFF0"), ("sky blue", "#5DADEC"),
        ("cornflower blue", "#6495ED"), ("steel blue", "#4682B4"), ("denim blue", "#1560BD"), ("royal blue", "#4169E1"),
        ("cobalt blue", "#0047AB"), ("blue", "#0000FF"), ("deep blue", "#00239C"), ("navy blue", "#000080"),
        ("midnight blue", "#191970"),
    ]),
    ("Purples", [
        ("periwinkle", "#CCCCFF"), ("lavender", "#C4B0E8"), ("lilac", "#C8A2C8"), ("mauve", "#B784A7"),
        ("orchid", "#DA70D6"), ("magenta", "#FF00FF"), ("violet", "#8F00FF"), ("royal purple", "#7851A9"),
        ("purple", "#800080"), ("plum", "#8E4585"), ("eggplant", "#614051"), ("dark purple", "#301934"),
    ]),
    ("Metallics", [
        ("silver", "#C0C0C0"), ("gold", "#D4AF37"), ("rose gold", "#B76E79"), ("bronze", "#CD7F32"),
        ("copper", "#B87333"),
    ]),
    (HAIR_GROUP, [
        ("platinum blonde hair", "#E5E1CC"), ("very light blonde hair", "#F3E5AB"), ("light blonde hair", "#E8D08A"),
        ("blonde hair", "#D9B76A"), ("golden blonde hair", "#D4A84B"), ("honey blonde hair", "#C9954C"),
        ("strawberry blonde hair", "#D98E5F"), ("ash blonde hair", "#B8A88A"), ("dark blonde hair", "#A98B52"),
        ("light brown hair", "#8B6842"), ("chestnut brown hair", "#7A4B2E"), ("brunette hair", "#6B4A32"),
        ("ash brown hair", "#6B5E52"), ("dark brown hair", "#3E2A1E"), ("espresso brown hair", "#2B1D16"),
        ("light ginger hair", "#E3A06A"), ("ginger hair", "#C8642B"), ("copper red hair", "#B85C38"),
        ("red hair", "#B5361F"), ("auburn hair", "#8B3A22"), ("dark auburn hair", "#5E2A1E"),
        ("burgundy hair", "#6D1F2F"), ("black hair", "#1A1A1A"), ("jet black hair", "#0B0B0D"),
        ("salt and pepper hair", "#7A7A7A"), ("gray hair", "#8E8E8E"), ("silver hair", "#C4C4C8"),
        ("white hair", "#F2F2F2"), ("pastel pink hair", "#F4B6C8"), ("pink hair", "#FF6FA5"),
        ("lavender hair", "#B9A2DD"), ("purple hair", "#7B3FA0"), ("blue hair", "#2F6FDB"),
        ("teal hair", "#1B8A8A"), ("green hair", "#3FA34D"),
    ]),
]

COLOR_NAMES = [name for _, colors in COLOR_GROUPS for name, _ in colors]


class ColorPicker:
    """Output the name of the selected color as a ``STRING``.

    The value is a plain combo of color names, so it stays readable in the
    workflow and API clients can send a name directly. The frontend extension
    adds a swatch that opens a palette and a free color picker.
    """

    DESCRIPTION = (
        "Outputs the name of a color, e.g. 'pastel pink' or 'deep blue', for use "
        "in a prompt. Click the swatch to pick from the palette or to choose any "
        "color, which is mapped to the nearest name."
    )
    CATEGORY = "b24nodes/text"
    FUNCTION = "pick"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("color",)
    OUTPUT_TOOLTIPS = ("Name of the selected color.",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "color": (
                    COLOR_NAMES,
                    {"default": "black", "tooltip": "Color name to output."},
                ),
            },
        }

    def pick(self, color):
        """Return the selected color name."""
        return (color,)
