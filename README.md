# ComfyUI-b24nodes

Custom nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI).

| Node | Display name | Description |
| --- | --- | --- |
| `B24LoadImagePath` | **Load Image Path (b24)** | Load an image from any sub folder of `ComfyUI/input`. |
| `B24ResolutionAspectSelector` | **Resolution Aspect Selector (b24)** | Turn an aspect ratio and a megapixel budget into `width`/`height`. |
| `B24PromptComposer` | **Prompt Composer (b24)** | Fill `{{name}}` placeholders of a prompt template from inputs. |
| `B24ColorPicker` | **Color Picker (b24)** | Pick a color, output its name (`pastel pink`, `deep blue`, ...). |
| `B24MultiLoraLoader` | **Multi Lora Loader (b24)** | Apply any number of LoRAs with one node, each with a switch and a strength. |

## Load Image Path

The core *Load Image* node only lists the files that sit directly in
`ComfyUI/input`. This node adds a folder selection on top of it, so an image
collection can be organised in sub folders:

```
ComfyUI/input/
├── portraits/
│   ├── 2024/
│   │   ├── raw/
│   │   └── shot_01.png
│   └── 2025/
└── landscapes/
```

### Widgets

| Widget | Serialised | Purpose |
| --- | --- | --- |
| `folder` | yes | Every folder below `input/`, as a relative path. `/` is the input root. |
| `image` | yes | The images inside the selected folder. |
| `🖼 browse thumbnails` | no | Opens the thumbnail browser, see below. |
| `↓ enter sub folder` | no | The direct children of the current folder; picking one descends into it. |
| `⬆ up one level` | no | Jumps to the parent folder and loads its images. |
| `⟳ reload folders` | no | Re-reads all listings from disk, e.g. after copying new files in. |

Only `folder` and `image` are stored in the workflow; the four navigation
widgets are added by the frontend extension and are not serialised.

The node context menu (right click) additionally offers *Browse thumbnails*,
*Reload folders and images* and *Go to input root*.

Three ways to traverse the tree:

* **direct** – open the `folder` dropdown and pick any path (the dropdown of the
  ComfyUI frontend is searchable, which is handy for large collections),
* **step by step** – descend with `↓ enter sub folder`, walk back up with
  `⬆ up one level`. This only ever lists one level at a time, so it stays usable
  in deep or wide trees,
* **visual** – `🖼 browse thumbnails` opens an overlay with the images of the
  selected folder as a grid, see [Thumbnail browser](#thumbnail-browser).

Whenever the folder changes, the `image` list is reloaded and the first image of
the new folder is selected. The selected image is shown as the node preview.

### Outputs

| Output | Type | Description |
| --- | --- | --- |
| `image` | `IMAGE` | The loaded image. Multi frame files (animated GIF, TIFF stacks) are returned as a batch, like the core node. |
| `mask` | `MASK` | The inverted alpha channel, or an empty `64x64` mask when the image has none. |

### Thumbnail browser

`🖼 browse thumbnails` (or *Browse thumbnails* in the context menu) opens an
overlay with the images of the selected folder as a grid, the current image
highlighted. Sub folders are shown as tiles as well, together with `..` for the
parent, so the browser can walk the tree on its own - the node only changes
once an image is clicked, which selects it and closes the overlay. The filter
field narrows the grid down by name; `Esc`, `✕` or a click next to the panel
close it without a change.

The thumbnails come from `GET /api/b24nodes/thumbnail`, which scales an image
down to 256 pixels on its longest side and sends it as WEBP, so a folder full of
large photos does not load the originals. Details:

* Thumbnails are only requested when their tile scrolls near the visible area,
  so a folder with hundreds of images loads a screenful at a time.
* The browser caches every thumbnail and revalidates it through an `ETag` built
  from the file's modification time and size; an unchanged file is answered with
  `304` without decoding it again. Nothing is cached on disk.
* JPEGs are decoded at a reduced scale right away (Pillow's `draft` mode), which
  keeps even a 4000 x 3000 photo at a few milliseconds.
* EXIF orientation and the 32 bit integer scaling follow the node, so the
  thumbnail looks like what the node loads. Animations show their first frame.
* Files that can not be decoded get a `⚠` tile instead of a broken image.
* The route resolves the file through the same two layer check as the node,
  so it can not read anything outside of `input/`.

### Adding images

Images can be put into the collection without leaving the canvas. Both routes
use ComfyUI's own `/upload/image`, so a name that is already taken is turned
into `shot (1).png` exactly like an upload from the core *Load Image* node, and
the first file of a batch becomes the new selection.

| Gesture | Target folder |
| --- | --- |
| Drop image files onto the node | the folder that is currently selected |
| `Ctrl+V` of a clipboard bitmap, node selected | `pasted/`, created on demand - the same folder the core node uses |
| `Ctrl+V` of a file copied in the file manager | the folder that is currently selected |

The split between the last two rows is the core node's own heuristic: a bitmap
pasted into the browser always arrives as a file called `image.png`, and only
that name is routed to `pasted/`. A file that was copied in the file manager
keeps its own name and is therefore treated like a drop.

Non image files are ignored and handed back to ComfyUI, which keeps the usual
"drop a workflow JSON onto the canvas" behaviour intact.

### Notes

* Pressing `r` (*refresh node definitions*) re-reads the listings of the
  selected folder. ComfyUI overwrites `options.values` of every combo widget
  from `/object_info` during that refresh, and for this node those lists are
  built for the input *root*; the extension hooks into `refreshComboInNodes`
  and puts the listings of the selected folder back afterwards. So `r` is a
  second way to pick up newly copied files, next to `⟳ reload folders`.
* Both widget values are stored in the workflow, so a workflow keeps working
  after a restart as long as the file is still there.
* The image list is rebuilt by the frontend, so newly copied files show up
  without restarting ComfyUI – use `⟳ reload folders`.
* API clients may pass any folder/file below `input/`, including a combined
  value such as `folder = "/"`, `image = "portraits/2024/shot_01.png"`.
* The selected image is shown as the node preview. Current frontends render node
  previews from the node output store, older ones from `node.imgs`; the
  extension feeds both. The node also sets `previewMediaType = "image"`, which
  is what makes the frontend route a `Ctrl+V` to it - the fallback check looks
  for an already loaded preview, and an empty folder has none.
* Everything below `input/` is reachable, nothing above it, guarded in two
  layers: folder values are normalised first, so `..`, absolute paths and a
  leading drive letter can not leave the input directory, and every assembled
  path is then checked for containment. The second layer matters on Windows,
  where `os.path.join` silently discards the root as soon as a segment looks
  like a drive (`image = "C:evil.png"`). Symlinks and Windows junctions inside
  `input/` are followed (cycle safe), so an external collection can be linked
  into `input/` instead of being copied - the containment check runs on the
  logical path, not on `realpath`, which is what keeps those links working.
* The folder list is capped at `MAX_TREE_ENTRIES` (2000) entries; when the cap
  is hit the browser console logs a warning. Raise it in
  [b24nodes/paths.py](b24nodes/paths.py) if you have a bigger tree.

### Compatibility

Verified against ComfyUI frontend `1.49.6` (node registration, folder traversal,
preview, workflow round trip, execution, the validation error paths, drag & drop
and paste upload, and the listing repair after a node definition refresh).
The thumbnail browser was verified against `1.58.5` (navigation, filter, pick
across folders, undo/redo, lazy loading in a 300 image folder, the `⚠` tile, and
the route's `304`, `404` and `415` answers).

## Resolution Aspect Selector

Produces a `width`/`height` pair from an aspect ratio and a megapixel budget,
instead of typing both numbers by hand:

```
Resolution Aspect Selector ──width──> Empty Latent Image
                           └─height─>
```

Both outputs are plain `INT`, so they fit every node that takes a size -
`Empty Latent Image`, `EmptySD3LatentImage`, `Image Resize`, and so on.

### Widgets and inputs

| Input | Kind | Purpose |
| --- | --- | --- |
| `image` | optional `IMAGE` input | Reference image. Only its shape is read, the pixels are ignored. While it is connected the `aspect_ratio` widget is greyed out. |
| `aspect_ratio` | widget | `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`, `21:9`, `9:21` (each with its orientation in the label). Disabled while `image` is connected. |
| `megapixels` | widget | `FLOAT`, default `1.0`. Target size in megapixels, `1 MP = 1024 x 1024 = 1,048,576 pixels` - the way image models count it, so `1.0` at `1:1` is exactly `1024 x 1024`. |
| `divisible_by` | widget | `8`, `12`, `16`, `20`, `24`, `28`, `32` - the step width both outputs are aligned to (8 for SD/SDXL, 16 for Flux). |

### Outputs

| Output | Type | Description |
| --- | --- | --- |
| `width` | `INT` | A multiple of `divisible_by`. |
| `height` | `INT` | A multiple of `divisible_by`. |

### How the size is picked

Rounding the ideal width and height to the grid independently distorts the
aspect ratio noticeably on coarse grids, so the node scores a handful of
candidates around the ideal size and keeps the best one. Both errors are
measured as log ratios, which makes them symmetric and comparable; the aspect
error counts double, because hitting the ratio usually matters more than hitting
the megapixel count exactly.

At `megapixels = 1.0`:

| Aspect | `divisible_by = 8` | `= 16` | `= 32` |
| --- | --- | --- | --- |
| `1:1` | 1024 x 1024 | 1024 x 1024 | 1024 x 1024 |
| `3:2` | 1248 x 832 | 1248 x 832 | 1248 x 832 |
| `4:3` | 1184 x 888 | 1184 x 880 | 1184 x 896 |
| `16:9` | 1368 x 768 | 1360 x 768 | 1376 x 768 |
| `21:9` | 1568 x 672 | 1568 x 672 | 1568 x 672 |

The portrait entries are the same pairs with width and height swapped.

### Notes

* The unit is the binary megapixel (`1024 x 1024`), set in
  `PIXELS_PER_MEGAPIXEL`. Change it to `1_000_000` for the decimal reading.
* Connecting `image` disables the `aspect_ratio` widget: the frontend extension
  sets `widget.disabled`, which is the same flag litegraph uses for a widget
  that was replaced by an input slot - drawn at half opacity, without value text
  or stepper arrows, and skipped during hit testing. The stored value is left
  alone, so the widget comes back with its old selection once the image is
  disconnected. The python side ignores `aspect_ratio` whenever an image
  arrives, so API clients get the same behaviour without the frontend.
* Only the shape of `image` is read, so a reference can be wired in without
  costing anything - the tensor is not copied or converted.

### Compatibility

Verified against ComfyUI frontend `1.49.6` (node registration, both aspect
sources, the widget disable on connect and disconnect, and a workflow round
trip).

## Prompt Composer

Builds a prompt from a template whose variable parts are written as
placeholders, so a value that appears several times is changed in one place:

```
A {{color}} ceramic vase on a wooden table, next to a {{color}} candle,
standing in a {{setting}}.
```

Every placeholder name gets a `STRING` input of the same name - the inputs
follow the template while typing, no "+" button needed. Connect a core
*String* node, a *Color Picker (b24)* or any other text output; all
occurrences of the placeholder are replaced with that text.

```
Color Picker (b24) ──color──>   Prompt Composer ──prompt──> CLIP Text Encode (text)
String ──────────────setting──>                 └─prompt──> other prompt inputs
```

### Inputs and outputs

| Name | Kind | Purpose |
| --- | --- | --- |
| `template` | widget | Prompt with `{{name}}` placeholders. Names consist of letters, digits and `_` (umlauts work); spaces inside the braces are ignored, `{{ color }}` is `{{color}}`. |
| one per placeholder | `STRING` input | The text that replaces the placeholder. |
| `prompt` | `STRING` output | The template with every placeholder replaced. |

### Notes

* A placeholder without a connected input stops the run with
  `No value connected for {{name}}` rather than sending the braces to the
  model. An empty string is a valid value.
* An input whose placeholder was removed from the template disappears, unless
  a link is still attached - a half typed name would otherwise cost its link.
  It is removed once it is disconnected and ignored by the node until then.
* Values are inserted as they are: a value that contains `{{...}}` is not
  expanded again.
* The inputs are ordinary node inputs, so they are stored with the workflow.
  ComfyUI passes every linked input to the node, which is why they do not have
  to be declared on the python side. The flip side: ComfyUI's prompt
  validation only follows declared inputs, so a node that feeds nothing but
  placeholder inputs is not validated before the run - it still executes
  normally.
* The core *Format Text* node does something similar with fixed input names
  (`{a}`, `{b}`, ...) and Python format syntax; this node uses the names from
  the template instead.

### Compatibility

Verified against ComfyUI frontend `1.58.5` (inputs following the template while
typing, stale inputs kept while linked, workflow round trip, connection to the
`text` input of *CLIP Text Encode*, execution and the missing value error).

## Color Picker

Outputs the *name* of a color as `STRING`, ready to be wired into a prompt
placeholder. The node shows the selected color as a swatch; clicking it opens a
palette of 133 color names grouped by family (neutrals, browns, reds, pinks,
oranges and yellows, greens, cyans and teals, blues, purples, metallics, hair
colors).
Hovering an entry shows its name, a click selects it.

*Any color → nearest name* at the bottom of the palette opens the browser's
color picker; the chosen color is mapped to the palette entry that looks
closest (CIE76 distance in L\*a\*b\*), e.g. `#1A2B8C` becomes `midnight blue`.
Hair colors are not candidates there.

The *Hair colors* group (`blonde hair`, `strawberry blonde hair`, `dark brown hair`,
`brunette hair`, `red hair`, `auburn hair`, `silver hair`, ...) outputs names that
always end in `hair`, so the prompt says it is hair and not clothing. Write the
placeholder without the word: `she has long {{hair}}, ...`.

The stored value is the name itself, kept in the `color` combo, so it stays
readable in the workflow, can also be picked from the searchable dropdown, and
API clients can send a name directly.

### Notes

* The palette is defined once in
  [b24nodes/nodes/color_picker.py](b24nodes/nodes/color_picker.py) and served to
  the frontend as `GET /api/b24nodes/colors`. Add or rename entries there.
* Picking from the palette is recorded by undo/redo and marks the workflow as
  modified.

### Compatibility

Verified against ComfyUI frontend `1.58.5` (swatch, palette popup with hover
preview, nearest name mapping, closing on Escape and outside click, undo,
workflow round trip and execution).

## Multi Lora Loader

Applies a list of LoRAs to a `MODEL` and a `CLIP` in one node, instead of a
chain of *Load LoRA* nodes. `model` and `clip` are both optional.

*+ Add LoRA* appends a row, *− Remove last* removes the bottom one. A row has

| Widget | Purpose |
| --- | --- |
| `on N` | Switch the row off without losing its settings. |
| `lora N` | LoRA file from the `loras` folder, `None` leaves the row empty. |
| `strength N` | Strength for the model and the CLIP; negative values work. |

Rows are applied top to bottom. Switched off rows, empty rows and rows with
strength `0` are skipped, so they cost nothing.

The rows are made of regular widgets, no custom canvas drawing, so the node
looks and works the same with and without *Nodes 2.0*.

### Notes

* The rows are stored as JSON in a hidden `loras` string widget, e.g.
  `[{"on": true, "lora": "style.safetensors", "strength": 0.8}]`. API clients can
  send that string directly.
* One strength drives model and CLIP. Separate strengths would need another
  widget per row.
* A LoRA that no longer exists stays visible in its row and fails when the
  workflow runs, with the file name in the error.
* Verified against ComfyUI frontend `1.58.5`, in the classic canvas and with
  Nodes 2.0: adding and removing rows, workflow round trip, and that only the
  `loras` string reaches the server. Applying LoRAs is covered by unit tests
  with stand-ins for the ComfyUI loader, not by a run with a real model.

## Installation

Clone the pack into the ComfyUI `custom_nodes` folder and restart ComfyUI:

```bash
git clone https://github.com/behringer24/ComfyUI-b24nodes.git ComfyUI/custom_nodes/ComfyUI-b24nodes
```

There are no extra python dependencies – the pack only uses what ComfyUI
already ships (torch, numpy, Pillow, aiohttp).

## Repository layout

```
__init__.py                       node mappings + WEB_DIRECTORY for ComfyUI
b24nodes/
├── __init__.py                   NODE_CLASS_MAPPINGS / display names
├── paths.py                      safe browsing of the input directory, thumbnails
├── routes.py                     /b24nodes/browse, /tree, /thumbnail and /colors
└── nodes/
    ├── color_picker.py           the Color Picker node and its palette
    ├── load_image_path.py        the Load Image Path node
    ├── multi_lora_loader.py      the Multi Lora Loader node
    ├── prompt_composer.py        the Prompt Composer node
    └── resolution_aspect_selector.py
                                  the Resolution Aspect Selector node
web/
├── b24_color_picker.js           swatch and palette popup
├── b24_load_image_path.js        frontend extension (folder browser, thumbnails, preview)
├── b24_multi_lora_loader.js      LoRA rows as regular widgets
├── b24_prompt_composer.js        one input per template placeholder
└── b24_resolution_aspect_selector.js
                                  greys out aspect_ratio while image is connected
tests/
├── test_load_image_path.py       runs without a ComfyUI installation
├── test_multi_lora_loader.py     Multi Lora Loader with stand-ins for the loader
├── test_prompt_composer.py       Prompt Composer and Color Picker
└── test_resolution_aspect_selector.py
```

### HTTP API

The frontend extensions use four read only routes that ComfyUI serves under the
`/api` prefix as well:

| Route | Response |
| --- | --- |
| `GET /api/b24nodes/tree` | `{"folders": ["portraits", "portraits/2024"], "truncated": false, "limit": 2000}` |
| `GET /api/b24nodes/browse?folder=portraits` | `{"folder": "portraits", "parent": "", "exists": true, "folders": ["2024"], "images": ["shot_01.png"]}` |
| `GET /api/b24nodes/thumbnail?folder=portraits&image=shot_01.png` | WEBP image, at most 256 pixels on the longest side; `404` for a missing file, `415` for one that can not be decoded |
| `GET /api/b24nodes/colors` | `{"groups": [{"name": "Neutrals", "colors": [{"name": "white", "hex": "#FFFFFF"}, ...]}, ...]}` |

### Tests

```bash
python -m unittest discover -s tests
```

The tests stub ComfyUI's `folder_paths` module and work against a temporary
input directory, so they need torch, numpy and Pillow but no ComfyUI checkout.

## Adding a node

1. Add the implementation to `b24nodes/nodes/`.
2. Register it in `b24nodes/__init__.py` (`NODE_CLASS_MAPPINGS` and
   `NODE_DISPLAY_NAME_MAPPINGS`).
3. Optional frontend behaviour goes into a `web/*.js` file; ComfyUI loads every
   JavaScript file in `web/` automatically.

## License

MIT – see [LICENSE](LICENSE).
