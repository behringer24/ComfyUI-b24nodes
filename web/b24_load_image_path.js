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
 *  - the selected image is shown as the node preview.
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

const WIDGET_ENTER = "↓ enter sub folder";
const WIDGET_UP = "⬆ up one level";
const WIDGET_RELOAD = "⟳ reload folders";

/** The folder tree rarely changes while clicking around, so share it briefly. */
const TREE_CACHE_TTL = 1500;
let treeCache = null;

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

/** Wire up the widget callbacks and add the navigation widgets. */
function setupNode(node) {
  if (node.b24Initialised) return;
  const folderWidget = findWidget(node, "folder");
  const imageWidget = findWidget(node, "image");
  if (!folderWidget || !imageWidget) return;
  node.b24Initialised = true;

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
      if (app.nodeOutputs) delete app.nodeOutputs[this.id];
      return onRemoved?.apply(this, args);
    };

    const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      const result = getExtraMenuOptions?.apply(this, arguments);
      const node = this;
      options?.push(
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
