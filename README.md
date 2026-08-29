# ComfyUI-b24nodes

Custom nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI).

| Node | Display name | Description |
| --- | --- | --- |
| `B24LoadImagePath` | **Load Image Path (b24)** | Load an image from any sub folder of `ComfyUI/input`. |

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
    └── load_image_path.py        the Load Image Path node
web/
└── b24_load_image_path.js        frontend extension (folder browser, preview)
tests/
└── test_load_image_path.py       runs without a ComfyUI installation
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
