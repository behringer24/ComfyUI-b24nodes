# ComfyUI-b24nodes

Custom nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI).

| Node | Display name | Description |
| --- | --- | --- |
| `B24LoadImagePath` | **Load Image Path (b24)** | Load an image from any sub folder of `ComfyUI/input`. |
| `B24ResolutionAspectSelector` | **Resolution Aspect Selector (b24)** | Turn an aspect ratio and a megapixel budget into `width`/`height`. |

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
| `↓ enter sub folder` | no | The direct children of the current folder; picking one descends into it. |
| `⬆ up one level` | no | Jumps to the parent folder and loads its images. |
| `⟳ reload folders` | no | Re-reads all listings from disk, e.g. after copying new files in. |

Only `folder` and `image` are stored in the workflow; the three navigation
widgets are added by the frontend extension and are not serialised.

The node context menu (right click) additionally offers *Reload folders and
images* and *Go to input root*.

Two ways to traverse the tree:

* **direct** – open the `folder` dropdown and pick any path (the dropdown of the
  ComfyUI frontend is searchable, which is handy for large collections),
* **step by step** – descend with `↓ enter sub folder`, walk back up with
  `⬆ up one level`. This only ever lists one level at a time, so it stays usable
  in deep or wide trees.

Whenever the folder changes, the `image` list is reloaded and the first image of
the new folder is selected. The selected image is shown as the node preview.

### Outputs

| Output | Type | Description |
| --- | --- | --- |
| `image` | `IMAGE` | The loaded image. Multi frame files (animated GIF, TIFF stacks) are returned as a batch, like the core node. |
| `mask` | `MASK` | The inverted alpha channel, or an empty `64x64` mask when the image has none. |

### Notes

* Both widget values are stored in the workflow, so a workflow keeps working
  after a restart as long as the file is still there.
* The image list is rebuilt by the frontend, so newly copied files show up
  without restarting ComfyUI – use `⟳ reload folders`.
* API clients may pass any folder/file below `input/`, including a combined
  value such as `folder = "/"`, `image = "portraits/2024/shot_01.png"`.
* The selected image is shown as the node preview. Current frontends render node
  previews from the node output store, older ones from `node.imgs`; the
  extension feeds both.
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
preview, workflow round trip, execution and the validation error paths).

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
├── paths.py                      safe browsing of the input directory
├── routes.py                     /b24nodes/browse and /b24nodes/tree
└── nodes/
    ├── load_image_path.py        the Load Image Path node
    └── resolution_aspect_selector.py
                                  the Resolution Aspect Selector node
web/
├── b24_load_image_path.js        frontend extension (folder browser, preview)
└── b24_resolution_aspect_selector.js
                                  greys out aspect_ratio while image is connected
tests/
├── test_load_image_path.py       runs without a ComfyUI installation
└── test_resolution_aspect_selector.py
```

### HTTP API

The frontend extension uses two read only routes that ComfyUI serves under the
`/api` prefix as well:

| Route | Response |
| --- | --- |
| `GET /api/b24nodes/tree` | `{"folders": ["portraits", "portraits/2024"], "truncated": false, "limit": 2000}` |
| `GET /api/b24nodes/browse?folder=portraits` | `{"folder": "portraits", "parent": "", "exists": true, "folders": ["2024"], "images": ["shot_01.png"]}` |

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
