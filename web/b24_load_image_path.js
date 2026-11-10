/**
 * Frontend extension for the "Load Image Path (b24)" node.
 *
 * The python side only provides the initial widget lists. This extension turns
 * the two combo widgets into a small folder browser:
 *
 *  - the "folder" widget lists every folder below ComfyUI/input, so any sub
 *    path can be selected directly,
 *  - the "image" widget always shows the images of the selected folder,
 *  - the "enter" widget descends into a direct sub folder of the current one,
 *    the button walks back up, so the tree can also be traversed step by step,
 *  - the selected image is shown as the node preview,
 *  - images can be dropped onto the node or pasted into it,
 *  - the thumbnail browser shows the images of a folder as a grid to pick from.
 *
 * Only "folder" and "image" are serialised with the workflow; the navigation
 * widgets are added here and marked as non serialisable.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "B24LoadImagePath";
const ROUTE_PREFIX = "/b24nodes";
const ROOT_LABEL = "/";
const LOG_PREFIX = "[b24nodes]";

// Placeholder entries of the "enter sub folder" widget. A combo always shows a
// value, so descending is modelled as "pick an entry, then fall back to this".
const PICK_LABEL = "— pick to enter —";
const EMPTY_LABEL = "— no sub folders —";

// Clipboard images go to the same folder the core Load Image node uses.
const PASTE_FOLDER = "pasted";
const PASTED_IMAGE_EXPIRY_MS = 2000;

// Uploads go through ComfyUI's own route, so dropped and pasted files land in
// input/ exactly like an upload from the core node, including its handling of
// name collisions.
const UPLOAD_ROUTE = "/upload/image";
const UPLOAD_TIMEOUT_MS = 120_000;

const WIDGET_THUMBNAILS = "🖼 browse thumbnails";
const WIDGET_ENTER = "↓ enter sub folder";
const WIDGET_UP = "⬆ up one level";
const WIDGET_RELOAD = "⟳ reload folders";

/** The folder tree rarely changes while clicking around, so share it briefly. */
const TREE_CACHE_TTL = 1500;
let treeCache = null;

/**
 * Every live node of this type, so that the "refresh node definitions" hook can
 * reach them. Nodes register themselves in ``setupNode`` and drop out again in
 * ``onRemoved``.
 */
const liveNodes = new Set();

/**
 * Normalize a folder value exactly like the python side does.
 * @param {unknown} value raw widget value
 * @returns {string} relative path, "" for the input root
 */
function normalizeFolder(value) {
  if (value === undefined || value === null) return "";

  let raw = String(value).replace(/\\/g, "/").trim();
  if (raw === "" || raw === "." || raw === ROOT_LABEL) return "";
  if (raw.length > 1 && raw[1] === ":") raw = raw.slice(2);

  const parts = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

/**
 * Split the two widget values into folder and file name, mirroring
 * ``paths.split_image_value``: the image value may carry folder segments when
 * the workflow came from the core Load Image node or from an API client.
 * @returns {{folder: string, filename: string}}
 */
function splitImageValue(folder, image) {
  const raw = String(image ?? "")
    .replace(/\\/g, "/")
    .trim();
  const filename = raw.slice(raw.lastIndexOf("/") + 1);
  const nested = raw.slice(0, raw.length - filename.length);
  return { folder: normalizeFolder(`${normalizeFolder(folder)}/${nested}`), filename };
}

/** Widget representation of a normalized folder path. */
const displayFolder = (folder) => (folder === "" ? ROOT_LABEL : folder);

/** Parent of a normalized folder path, or null for the input root. */
const parentFolder = (folder) =>
  folder === "" ? null : folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";

const findWidget = (node, name) => node.widgets?.find((widget) => widget.name === name);

/**
 * Add a widget that is *not* stored in the workflow.
 *
 * Serialisation is skipped for widgets whose ``serialize`` property is exactly
 * ``false``; the flag has to sit on the widget itself, passing it in the options
 * object is not enough. Without it the navigation widgets would show up in
 * ``widgets_values`` and shift the values that belong to "folder" and "image".
 *
 * @returns {object} the created widget
 */
function addTransientWidget(node, type, name, value, callback, options = {}) {
  const widget = node.addWidget(type, name, value, callback, { ...options, serialize: false });
  widget.serialize = false;
  return widget;
}

/**
 * GET a JSON payload from the API of this pack.
 * @param {string} route route below the api root, including the query string
 */
async function getJson(route) {
  const response = await api.fetchApi(route);
  if (!response.ok) {
    throw new Error(`${route} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

const browseFolder = (folder) =>
  getJson(`${ROUTE_PREFIX}/browse?folder=${encodeURIComponent(folder)}`);

/**
 * Fetch the folder tree, reusing a very recent request when possible.
 * @param {boolean} force ignore the cache
 */
function fetchTree(force = false) {
  const now = performance.now();
  if (!force && treeCache && now - treeCache.time < TREE_CACHE_TTL) {
    return treeCache.request;
  }
  const request = getJson(`${ROUTE_PREFIX}/tree`).catch((error) => {
    treeCache = null;
    throw error;
  });
  treeCache = { time: now, request };
  return request;
}

/** URL of an image inside the input directory. */
function viewUrl(folder, filename) {
  const query = new URLSearchParams({ filename, type: "input", subfolder: folder });
  const route = `/view?${query.toString()}`;
  return api.apiURL ? api.apiURL(route) : route;
}

/** URL of the thumbnail of an image inside the input directory. */
function thumbnailUrl(folder, filename) {
  const query = new URLSearchParams({ folder, image: filename });
  const route = `${ROUTE_PREFIX}/thumbnail?${query.toString()}`;
  return api.apiURL ? api.apiURL(route) : route;
}

/**
 * Show the selected input image as the node preview.
 *
 * Two mechanisms are fed on purpose: current frontends render node previews
 * from the node output store (exposed to extensions as ``app.nodeOutputs``),
 * while older ones and the mask editor read ``node.imgs``.
 */
function updatePreview(node) {
  const { folder, filename } = splitImageValue(
    findWidget(node, "folder")?.value,
    findWidget(node, "image")?.value,
  );

  if (!filename) {
    clearPreview(node);
    return;
  }

  if (app.nodeOutputs) {
    app.nodeOutputs[node.id] = {
      images: [{ filename, subfolder: folder, type: "input" }],
    };
  }

  const image = new Image();
  image.onload = () => {
    node.imgs = [image];
    app.graph?.setDirtyCanvas(true);
  };
  image.onerror = () => {
    node.imgs = null;
    app.graph?.setDirtyCanvas(true);
  };
  image.src = viewUrl(folder, filename);
}

/** Drop the preview of a node, e.g. when its folder holds no images. */
function clearPreview(node) {
  node.imgs = null;
  if (app.nodeOutputs) delete app.nodeOutputs[node.id];
  app.graph?.setDirtyCanvas(true);
}

/** Show a message in ComfyUI's toast area, with the console as a fallback. */
function notify(severity, summary, detail) {
  const toast = app.extensionManager?.toast;
  if (toast?.add) {
    toast.add({ severity, summary, detail, life: severity === "error" ? 6000 : 3000 });
    return;
  }
  console[severity === "error" ? "error" : "info"](`${LOG_PREFIX} ${summary}: ${detail}`);
}

/** Upload filter of the core Load Image node: anything the browser calls an image. */
const isImageFile = (file) => typeof file?.type === "string" && file.type.startsWith("image/");

/**
 * The core node's test for "this came out of the clipboard": a bitmap pasted
 * into the browser always arrives as a file called "image.png".
 *
 * The freshness comparison is taken over from the core node as it stands there.
 * ``lastModified`` is never in the future, so the difference is negative and
 * that half of the condition always passes - which means a file genuinely
 * named "image.png" is treated here exactly as the core node treats it.
 */
const isPastedFile = (file) =>
  file.name === "image.png" && file.lastModified - Date.now() < PASTED_IMAGE_EXPIRY_MS;

/**
 * Pair the image files of a drop or a paste with the folder they belong in.
 *
 * Dropped files go to the folder that is currently selected. Pasted files only
 * go to "pasted/" when they look like a clipboard bitmap; a file that was
 * copied in the file manager keeps its name and is treated like a drop, which
 * is the same split the core node makes.
 *
 * @returns {{file: File, folder: string}[]}
 */
function uploadEntries(node, files, { pasted = false } = {}) {
  const current = normalizeFolder(findWidget(node, "folder")?.value);
  return Array.from(files ?? [])
    .filter(isImageFile)
    .map((file) => ({
      file,
      folder: pasted && isPastedFile(file) ? PASTE_FOLDER : current,
    }));
}

/**
 * Upload one file into a folder below input/ through ComfyUI's upload route.
 *
 * The server creates the folder when it is missing and renames the file when
 * the name is already taken ("shot.png" -> "shot (1).png"), so the name that
 * ends up on disk is read back from the response rather than from the file.
 *
 * @returns {Promise<{folder: string, filename: string}>} where the file landed
 */
async function uploadImage(file, folder) {
  const body = new FormData();
  body.append("image", file, file.name);
  body.append("type", "input");
  if (folder) body.append("subfolder", folder);

  const response = await api.fetchApi(UPLOAD_ROUTE, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return { folder: normalizeFolder(data.subfolder ?? folder), filename: data.name };
}

/**
 * Upload the prepared entries and select the first file that made it through.
 *
 * The files are sent one after another on purpose: the server picks a free
 * name by looking at the directory, so two parallel uploads carrying the same
 * name could both be told that the name is still available.
 *
 * @param {{file: File, folder: string}[]} entries what to upload and where
 * @returns {Promise<boolean>} whether at least one file was stored
 */
async function uploadInto(node, entries) {
  const folderWidget = findWidget(node, "folder");
  const imageWidget = findWidget(node, "image");
  if (!folderWidget || !imageWidget || !entries.length) return false;

  if (node.b24Uploading) {
    notify("warn", "Upload already running", "Wait for the current upload to finish.");
    return false;
  }
  node.b24Uploading = true;

  const uploaded = [];
  try {
    for (const { file, folder } of entries) {
      try {
        uploaded.push(await uploadImage(file, folder));
      } catch (error) {
        console.error(`${LOG_PREFIX} upload of "${file.name}" failed`, error);
        notify("error", "Upload failed", `${file.name}: ${error?.message ?? error}`);
      }
    }
  } finally {
    node.b24Uploading = false;
  }

  if (!uploaded.length) return false;

  // The first file of a drop becomes the selection, like in the core node.
  const [first] = uploaded;
  folderWidget.value = displayFolder(first.folder);
  imageWidget.value = first.filename;
  await refreshNode(node, { keepImage: true, forceTree: true });
  return true;
}

/**
 * Wire up drag & drop and Ctrl+V.
 *
 *  - dropped files land in the folder that is currently selected,
 *  - clipboard bitmaps land in "pasted/", the folder the core node uses,
 *  - in both cases the node switches to the first uploaded file.
 *
 * ``previewMediaType`` marks this as an image node. The paste dispatcher only
 * hands the clipboard to the selected node once it recognises it as one, and
 * without the flag that recognition depends on a preview being loaded already,
 * which is exactly not the case for an empty folder.
 */
function installUploadHandlers(node) {
  node.previewMediaType = "image";

  node.onDragOver = (event) => {
    const items = event?.dataTransfer?.items;
    return !!items && Array.from(items).some((item) => item.kind === "file");
  };

  node.onDragDrop = async (event) => {
    const entries = uploadEntries(node, event?.dataTransfer?.files);
    if (!entries.length) return false;
    return uploadInto(node, entries);
  };

  // Returning true claims the clipboard, so the frontend does not additionally
  // drop a fresh core Load Image node onto the canvas.
  node.pasteFiles = (files) => {
    const entries = uploadEntries(node, files, { pasted: true });
    if (!entries.length) return false;
    void uploadInto(node, entries);
    return true;
  };
}

/**
 * Reload the folder tree and the file list of the selected folder.
 * @param {object} node the node instance
 * @param {{keepImage?: boolean, forceTree?: boolean}} options
 *        keepImage: keep the selected file if it still exists in the folder
 */
async function refreshNode(node, { keepImage = true, forceTree = false } = {}) {
  const folderWidget = findWidget(node, "folder");
  const imageWidget = findWidget(node, "image");
  if (!folderWidget || !imageWidget) return;

  // Guard against overlapping requests: only the newest one may apply.
  const token = (node.b24RefreshToken = (node.b24RefreshToken ?? 0) + 1);
  const folder = normalizeFolder(folderWidget.value);

  try {
    const [tree, listing] = await Promise.all([fetchTree(forceTree), browseFolder(folder)]);
    if (token !== node.b24RefreshToken || !node.graph) return;

    const folders = [ROOT_LABEL, ...tree.folders];
    if (!listing.exists && folder !== "") {
      // Keep a missing folder selectable instead of silently dropping the value.
      folders.push(displayFolder(folder));
      console.warn(`${LOG_PREFIX} folder "${folder}" does not exist below input/`);
    }
    if (tree.truncated) {
      console.warn(`${LOG_PREFIX} folder list truncated at ${tree.limit} entries`);
    }

    folderWidget.options = folderWidget.options ?? {};
    folderWidget.options.values = folders;
    folderWidget.value = displayFolder(folder);

    imageWidget.options = imageWidget.options ?? {};
    imageWidget.options.values = listing.images;
    if (!keepImage || !listing.images.includes(imageWidget.value)) {
      imageWidget.value = listing.images[0] ?? "";
    }

    setEnterOptions(node, listing.folders ?? []);
  } catch (error) {
    console.error(`${LOG_PREFIX} could not refresh ${NODE_TYPE}`, error);
    return;
  }

  updatePreview(node);
  node.setDirtyCanvas?.(true, true);
}

/** Fill the "enter sub folder" widget with the children of the current folder. */
function setEnterOptions(node, subfolders) {
  const enterWidget = findWidget(node, WIDGET_ENTER);
  if (!enterWidget) return;

  enterWidget.options = enterWidget.options ?? {};
  enterWidget.options.values = subfolders.length ? [PICK_LABEL, ...subfolders] : [EMPTY_LABEL];
  enterWidget.value = subfolders.length ? PICK_LABEL : EMPTY_LABEL;
}

/**
 * Refresh on the next tick. Used for node creation, because litegraph restores
 * the stored widget values right after the node was created.
 */
function scheduleRefresh(node, options) {
  clearTimeout(node.b24RefreshTimer);
  node.b24RefreshTimer = setTimeout(() => refreshNode(node, options), 0);
}

/** Move the node to another folder and load the images of that folder. */
function navigateTo(node, folder) {
  const folderWidget = findWidget(node, "folder");
  if (!folderWidget) return;
  folderWidget.value = displayFolder(normalizeFolder(folder));
  refreshNode(node, { keepImage: false, forceTree: true });
}

/** Select an image picked in the thumbnail browser, possibly in another folder. */
async function pickImage(node, folder, filename) {
  const folderWidget = findWidget(node, "folder");
  const imageWidget = findWidget(node, "image");
  if (!folderWidget || !imageWidget) return;
  folderWidget.value = displayFolder(folder);
  imageWidget.value = filename;
  await refreshNode(node, { keepImage: true });
  // The change tracker looks at the graph on mouseup, before the click on a
  // thumbnail is handled - without this the pick would miss undo.
  app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.captureCanvasState?.();
}

let openBrowser = null;

function closeBrowser() {
  openBrowser?.close();
}

/** One entry of the browser grid: a thumbnail or an icon above a caption. */
function browserTile(caption, content, onClick) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "b24-thumbs-tile";
  tile.title = caption;
  const label = document.createElement("span");
  label.textContent = caption;
  tile.append(content, label);
  tile.addEventListener("click", onClick);
  return tile;
}

function tileIcon(icon) {
  const symbol = document.createElement("span");
  symbol.className = "b24-thumbs-icon";
  symbol.textContent = icon;
  return symbol;
}

const folderTile = (icon, caption, onClick) => browserTile(caption, tileIcon(icon), onClick);

/**
 * Open the thumbnail browser on the folder that is selected on ``node``.
 *
 * The browser can walk the tree on its own; the node only changes once an
 * image is picked. Thumbnails are loaded lazily as they scroll into view.
 */
function showBrowser(node) {
  closeBrowser();

  const backdrop = document.createElement("div");
  backdrop.className = "b24-thumbs-backdrop";
  const panel = document.createElement("div");
  panel.className = "b24-thumbs-panel";
  const header = document.createElement("div");
  header.className = "b24-thumbs-header";
  const title = document.createElement("span");
  const filter = document.createElement("input");
  filter.type = "search";
  filter.placeholder = "Filter by name";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "✕";
  close.title = "Close (Esc)";
  const grid = document.createElement("div");
  grid.className = "b24-thumbs-grid";
  header.append(title, filter, close);
  panel.append(header, grid);
  backdrop.append(panel);

  // Only named tiles take part in filtering, the "up" tile always stays.
  filter.addEventListener("input", () => {
    const needle = filter.value.trim().toLowerCase();
    for (const tile of grid.children) {
      const name = tile.dataset.name;
      tile.hidden = !!needle && name !== undefined && !name.toLowerCase().includes(needle);
    }
  });

  let token = 0;
  const open = async (folder) => {
    const current = ++token;
    title.textContent = displayFolder(folder);
    filter.value = "";
    let listing;
    try {
      listing = await browseFolder(folder);
    } catch (error) {
      console.error(`${LOG_PREFIX} could not list "${folder}"`, error);
      notify("error", "Could not list folder", displayFolder(folder));
      return;
    }
    if (current !== token) return;

    const selected = splitImageValue(findWidget(node, "folder")?.value, findWidget(node, "image")?.value);
    const tiles = [];
    if (listing.parent !== null) tiles.push(folderTile("⬆", "..", () => open(listing.parent)));
    for (const name of listing.folders) {
      const tile = folderTile("📁", name, () => open(folder ? `${folder}/${name}` : name));
      tile.dataset.name = name;
      tiles.push(tile);
    }
    let selectedTile = null;
    for (const name of listing.images) {
      const image = document.createElement("img");
      image.loading = "lazy";
      image.decoding = "async";
      image.src = thumbnailUrl(folder, name);
      // Files the server can not decode answer 415; show that instead of a broken image.
      image.addEventListener("error", () => image.replaceWith(tileIcon("⚠")), { once: true });
      const tile = browserTile(name, image, () => {
        closeBrowser();
        pickImage(node, folder, name);
      });
      tile.dataset.name = name;
      if (folder === selected.folder && name === selected.filename) {
        tile.classList.add("selected");
        selectedTile = tile;
      }
      tiles.push(tile);
    }
    grid.replaceChildren(...tiles);
    grid.scrollTop = 0;
    selectedTile?.scrollIntoView({ block: "center" });
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") closeBrowser();
  };
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeBrowser();
  });
  close.addEventListener("click", closeBrowser);
  document.addEventListener("keydown", onKeyDown, true);
  document.body.append(backdrop);
  filter.focus();

  openBrowser = {
    node,
    close() {
      document.removeEventListener("keydown", onKeyDown, true);
      backdrop.remove();
      openBrowser = null;
    },
  };
  open(normalizeFolder(findWidget(node, "folder")?.value));
}

const BROWSER_STYLE = `
.b24-thumbs-backdrop {
  position: fixed; inset: 0; z-index: 10000; background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
}
.b24-thumbs-panel {
  width: min(960px, 92vw); height: min(760px, 85vh); display: flex; flex-direction: column;
  background: var(--comfy-menu-bg, #353535); color: var(--fg-color, #ddd);
  border: 1px solid var(--border-color, #555); border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5); font: 13px sans-serif;
}
.b24-thumbs-header {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid var(--border-color, #555);
}
.b24-thumbs-header span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.b24-thumbs-header input {
  width: 200px; padding: 4px 8px; border-radius: 4px; color: inherit;
  background: var(--comfy-input-bg, #222); border: 1px solid var(--border-color, #555);
}
.b24-thumbs-header button { background: none; border: none; color: inherit; font-size: 16px; cursor: pointer; }
.b24-thumbs-grid {
  flex: 1; overflow-y: auto; padding: 12px; display: grid; gap: 10px; align-content: start;
  grid-template-columns: repeat(auto-fill, minmax(136px, 1fr));
}
.b24-thumbs-tile {
  display: flex; flex-direction: column; gap: 4px; padding: 4px; min-width: 0; cursor: pointer;
  background: var(--comfy-input-bg, #222); color: inherit; font: inherit; font-size: 11px;
  border: 2px solid transparent; border-radius: 6px;
}
.b24-thumbs-tile[hidden] { display: none; }
.b24-thumbs-tile:hover { border-color: var(--border-color, #777); }
.b24-thumbs-tile.selected { border-color: var(--fg-color, #ddd); }
.b24-thumbs-tile img, .b24-thumbs-icon { width: 100%; aspect-ratio: 1; border-radius: 4px; }
.b24-thumbs-tile img { object-fit: contain; }
.b24-thumbs-icon { display: flex; align-items: center; justify-content: center; font-size: 48px; }
.b24-thumbs-tile span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

/** Wire up the widget callbacks and add the navigation widgets. */
function setupNode(node) {
  if (node.b24Initialised) return;
  const folderWidget = findWidget(node, "folder");
  const imageWidget = findWidget(node, "image");
  if (!folderWidget || !imageWidget) return;
  node.b24Initialised = true;
  liveNodes.add(node);
  installUploadHandlers(node);

  // Picking a folder loads the images of that folder.
  const folderCallback = folderWidget.callback;
  folderWidget.callback = function (...args) {
    const result = folderCallback?.apply(this, args);
    refreshNode(node, { keepImage: false });
    return result;
  };

  // Picking an image updates the preview.
  const imageCallback = imageWidget.callback;
  imageWidget.callback = function (...args) {
    const result = imageCallback?.apply(this, args);
    updatePreview(node);
    return result;
  };

  addTransientWidget(node, "button", WIDGET_THUMBNAILS, "", () => showBrowser(node));

  // Step by step traversal downwards: pick one of the direct sub folders.
  // The widget resets itself, so the same folder can be entered again later.
  const enterWidget = addTransientWidget(
    node,
    "combo",
    WIDGET_ENTER,
    EMPTY_LABEL,
    (value) => {
      enterWidget.value = PICK_LABEL;
      if (!value || value === PICK_LABEL || value === EMPTY_LABEL) return;
      const current = normalizeFolder(folderWidget.value);
      navigateTo(node, current ? `${current}/${value}` : value);
    },
    { values: [EMPTY_LABEL] },
  );

  // ... and upwards.
  addTransientWidget(node, "button", WIDGET_UP, "", () => {
    const parent = parentFolder(normalizeFolder(folderWidget.value));
    if (parent === null) return;
    navigateTo(node, parent);
  });

  addTransientWidget(node, "button", WIDGET_RELOAD, "", () =>
    refreshNode(node, { keepImage: true, forceTree: true }),
  );

  scheduleRefresh(node, { keepImage: true });
}

app.registerExtension({
  name: "b24nodes.LoadImagePath",

  setup() {
    const style = document.createElement("style");
    style.textContent = BROWSER_STYLE;
    document.head.append(style);
  },

  /**
   * Put the folder listings back after a "refresh node definitions" (the "r"
   * key, or the update button in the menu).
   *
   * That refresh reloads /object_info and overwrites ``options.values`` of
   * every combo widget with the list from the node definition. For this node
   * those lists are built for the input *root*, so a node that sits in a sub
   * folder would afterwards offer the files of the root instead of its own.
   * This hook runs right after the overwrite - which is also the moment newly
   * copied files are supposed to show up, so the listings are re-read from
   * disk rather than taken from the cache.
   */
  async refreshComboInNodes() {
    treeCache = null;
    const nodes = [];
    for (const node of liveNodes) {
      // Nodes of a closed or replaced graph are dropped on the way past.
      if (node.graph) nodes.push(node);
      else liveNodes.delete(node);
    }
    // No forceTree: the first refresh refills the cache, the others share it.
    await Promise.all(nodes.map((node) => refreshNode(node, { keepImage: true })));
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = onNodeCreated?.apply(this, args);
      setupNode(this);
      return result;
    };

    // Loading a workflow restores the widget values after node creation.
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = onConfigure?.apply(this, args);
      scheduleRefresh(this, { keepImage: true });
      return result;
    };

    // Do not leave the preview of a deleted node behind in the output store.
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function (...args) {
      clearTimeout(this.b24RefreshTimer);
      liveNodes.delete(this);
      if (openBrowser?.node === this) closeBrowser();
      this.onDragOver = undefined;
      this.onDragDrop = undefined;
      this.pasteFiles = undefined;
      if (app.nodeOutputs) delete app.nodeOutputs[this.id];
      return onRemoved?.apply(this, args);
    };

    const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      const result = getExtraMenuOptions?.apply(this, arguments);
      const node = this;
      options?.push(
        {
          content: "Browse thumbnails",
          callback: () => showBrowser(node),
        },
        {
          content: "Reload folders and images",
          callback: () => refreshNode(node, { keepImage: true, forceTree: true }),
        },
        {
          content: "Go to input root",
          callback: () => navigateTo(node, ""),
        },
      );
      return result;
    };
  },
});
