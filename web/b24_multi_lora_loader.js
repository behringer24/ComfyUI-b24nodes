/**
 * Frontend extension for the "Multi Lora Loader (b24)" node.
 *
 * The node stores its rows as JSON in the "loras" string widget. This
 * extension hides that widget and shows the rows as one compact list built
 * from plain DOM elements (switch, LoRA, strength, remove), which works in the
 * classic canvas as well as in Nodes 2.0. The list widget is neither stored
 * with the workflow nor sent to the server; it is rebuilt from the JSON when
 * a workflow is loaded.
 *
 * Clicking a LoRA opens a searchable picker. A "base model" dropdown above
 * the rows limits the picker to LoRAs trained for that model (and to those
 * whose base model is unknown, so nothing disappears for good). The base
 * models come from ``/b24nodes/loras``; the chosen filter is a property of the
 * node.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "B24MultiLoraLoader";
const DATA_WIDGET = "loras";
const LIST_WIDGET = "lora_list";
const FILTER_PROPERTY = "b24BaseFilter";
const ALL_BASES = "All";
const NO_LORA_LABEL = "None";
const MIN_NODE_WIDTH = 320;
const TOOLBAR_HEIGHT = 30;
const ROW_HEIGHT = 26;
const ROW_GAP = 4;
const MAX_PICKER_ENTRIES = 200;
const LOG_PREFIX = "[b24nodes]";

let catalogPromise = null;

/** ``{entries, bases}`` of the LoRA list, fetched once. A failed request is retried later. */
function loadCatalog() {
  catalogPromise ??= api
    .fetchApi("/b24nodes/loras")
    .then((response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.json();
    })
    .then(({ loras }) => {
      const counts = new Map();
      for (const { base } of loras) if (base) counts.set(base, (counts.get(base) ?? 0) + 1);
      const bases = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return { entries: loras, baseByName: new Map(loras.map(({ name, base }) => [name, base])), bases };
    })
    .catch((error) => {
      catalogPromise = null;
      console.error(`${LOG_PREFIX} could not list the LoRAs`, error);
      return null;
    });
  return catalogPromise;
}

const dataWidget = (node) => node.widgets?.find((widget) => widget.name === DATA_WIDGET);
const baseFilter = (node) => node.properties?.[FILTER_PROPERTY] || ALL_BASES;

/** "folder/name.safetensors" -> "name" */
function displayName(file) {
  return file.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
}

/** Rows stored in the node; anything unreadable counts as "no rows". */
function readRows(node) {
  try {
    const rows = JSON.parse(dataWidget(node)?.value || "[]");
    return Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object") : [];
  } catch {
    return [];
  }
}

/** Write the rows to the data widget; ``record`` also makes the change undoable. */
function writeRows(node, record = true) {
  const widget = dataWidget(node);
  if (!widget) return;
  widget.value = JSON.stringify(node.b24Rows);
  widget.callback?.(widget.value);
  node.setDirtyCanvas?.(true, true);
  // The change tracker only looks at the graph on mouseup, which fires before
  // the click that changed a row.
  if (record) app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.captureCanvasState?.();
}

const listHeight = (node) => TOOLBAR_HEIGHT + (node.b24Rows?.length ?? 0) * (ROW_HEIGHT + ROW_GAP) + ROW_GAP;

function fitNode(node) {
  const [width, height] = node.computeSize();
  node.setSize([Math.max(node.size[0], width, MIN_NODE_WIDTH), height]);
  node.setDirtyCanvas?.(true, true);
}

function element(tag, className, text) {
  const created = document.createElement(tag);
  if (className) created.className = className;
  if (text !== undefined) created.textContent = text;
  return created;
}

/** True when a LoRA is known to be trained for another base than the filter. */
function isMismatch(node, file) {
  const filter = baseFilter(node);
  const base = node.b24Catalog?.baseByName.get(file);
  return filter !== ALL_BASES && Boolean(base) && base !== filter;
}

/** The dropdown above the rows: "All" plus every base model found. */
function buildFilter(node) {
  const select = element("select", "b24-lora-filter");
  select.title = "Base model: limits the LoRA picker";
  const bases = node.b24Catalog?.bases ?? [];
  const add = (value, label) => select.append(Object.assign(element("option", "", label), { value }));
  add(ALL_BASES, "All base models");
  for (const [base, count] of bases) add(base, `${base} (${count})`);
  const filter = baseFilter(node);
  if (!bases.some(([base]) => base === filter) && filter !== ALL_BASES) add(filter, filter);
  select.value = filter;
  select.addEventListener("change", () => {
    node.properties ??= {};
    node.properties[FILTER_PROPERTY] = select.value;
    renderList(node);
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.captureCanvasState?.();
  });
  return select;
}

function buildRow(node, row) {
  const element_ = element("div", "b24-lora-row");
  element_.classList.toggle("off", row.on === false);
  element_.classList.toggle("mismatch", row.lora && isMismatch(node, row.lora));

  const toggle = element("input", "b24-lora-on");
  toggle.type = "checkbox";
  toggle.checked = row.on !== false;
  toggle.title = "Enable or disable this LoRA";
  toggle.addEventListener("change", () => {
    row.on = toggle.checked;
    element_.classList.toggle("off", !toggle.checked);
    writeRows(node);
  });

  const name = element("button", "b24-lora-name", row.lora ? displayName(row.lora) : NO_LORA_LABEL);
  name.type = "button";
  const base = node.b24Catalog?.baseByName.get(row.lora);
  name.title = row.lora ? `${row.lora}${base ? ` - ${base}` : ""}` : "Click to choose a LoRA";
  name.classList.toggle("empty", !row.lora);
  name.addEventListener("click", () => showPicker(node, row, name));

  const strength = element("input", "b24-lora-strength");
  strength.type = "number";
  strength.min = "-100";
  strength.max = "100";
  strength.step = "0.05";
  strength.value = Number(row.strength ?? 1).toFixed(2);
  strength.title = "Strength for model and CLIP";
  strength.addEventListener("input", () => {
    const value = parseFloat(strength.value);
    if (!Number.isFinite(value)) return;
    row.strength = value;
    writeRows(node, false);
  });
  strength.addEventListener("change", () => {
    strength.value = Number(row.strength ?? 1).toFixed(2);
    writeRows(node);
  });

  const remove = element("button", "b24-lora-remove", "✕");
  remove.type = "button";
  remove.title = "Remove this row";
  remove.addEventListener("click", () => {
    node.b24Rows.splice(node.b24Rows.indexOf(row), 1);
    writeRows(node);
    renderList(node);
  });

  element_.append(toggle, name, strength, remove);
  return element_;
}

/** Rebuild the whole list: toolbar and one row per LoRA. */
function renderList(node) {
  const list = node.b24List;
  if (!list) return;

  const toolbar = element("div", "b24-lora-toolbar");
  const add = element("button", "b24-lora-add", "+ Add LoRA");
  add.type = "button";
  add.addEventListener("click", () => {
    node.b24Rows.push({ on: true, lora: "", strength: 1 });
    writeRows(node);
    renderList(node);
  });
  toolbar.append(buildFilter(node), add);

  list.replaceChildren(toolbar, ...node.b24Rows.map((row) => buildRow(node, row)));
  fitNode(node);
}

let openPicker = null;

function closePicker() {
  openPicker?.close();
}

/** Open the searchable LoRA picker below ``anchor`` for ``row``. */
function showPicker(node, row, anchor) {
  closePicker();

  const catalog = node.b24Catalog;
  const filter = baseFilter(node);
  const popup = element("div", "b24-lora-picker");
  const search = element("input", "b24-lora-search");
  search.type = "search";
  search.placeholder = filter === ALL_BASES ? "Search LoRAs" : `Search ${filter} LoRAs`;
  const results = element("div", "b24-lora-results");
  popup.append(search, results);

  let active = 0;
  let visible = [];

  const choose = (file) => {
    row.lora = file;
    writeRows(node);
    closePicker();
    renderList(node);
  };

  const show = () => {
    const needle = search.value.trim().toLowerCase();
    const matches = (catalog?.entries ?? []).filter(
      ({ name, base }) =>
        (filter === ALL_BASES || !base || base === filter) && name.toLowerCase().includes(needle),
    );
    visible = [{ name: "", base: null }, ...matches.slice(0, MAX_PICKER_ENTRIES)];
    active = Math.min(active, visible.length - 1);

    results.replaceChildren(
      ...visible.map(({ name, base }, index) => {
        const item = element("button", "b24-lora-item");
        item.type = "button";
        item.classList.toggle("active", index === active);
        item.classList.toggle("selected", name === row.lora);
        item.title = name || "Leave this row empty";
        item.append(element("span", "b24-lora-item-name", name ? displayName(name) : NO_LORA_LABEL));
        if (name) item.append(element("span", base ? "b24-lora-badge" : "b24-lora-badge unknown", base ?? "?"));
        item.addEventListener("click", () => choose(name));
        return item;
      }),
    );
    if (matches.length > MAX_PICKER_ENTRIES) {
      results.append(element("div", "b24-lora-more", `${matches.length - MAX_PICKER_ENTRIES} more - refine the search`));
    }
    results.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  };

  search.addEventListener("input", () => {
    active = 0;
    show();
  });
  const onKeyDown = (event) => {
    if (event.key === "Escape") closePicker();
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(0, Math.min(visible.length - 1, active + (event.key === "ArrowDown" ? 1 : -1)));
      show();
    } else if (event.key === "Enter" && visible[active]) choose(visible[active].name);
  };
  const onPointerDown = (event) => {
    if (!popup.contains(event.target) && event.target !== anchor) closePicker();
  };

  show();
  document.body.append(popup);
  const place = anchor.getBoundingClientRect();
  const { width, height } = popup.getBoundingClientRect();
  popup.style.left = `${Math.max(4, Math.min(place.left, innerWidth - width - 4))}px`;
  popup.style.top = `${place.bottom + height + 4 <= innerHeight ? place.bottom + 4 : Math.max(4, place.top - height - 4)}px`;
  search.focus();

  // Registered on the next tick, so the click that opened the picker does not close it.
  const timer = setTimeout(() => document.addEventListener("pointerdown", onPointerDown, true), 0);
  document.addEventListener("keydown", onKeyDown, true);

  openPicker = {
    node,
    close() {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      popup.remove();
      openPicker = null;
    },
  };
}

/** Take the rows from the stored JSON and show them. */
function loadRows(node) {
  node.b24Rows = readRows(node);
  renderList(node);
  loadCatalog().then((catalog) => {
    if (!catalog || !node.graph) return;
    node.b24Catalog = catalog;
    renderList(node);
  });
}

/** Hide the JSON widget: it is an implementation detail, not something to edit. */
function hideDataWidget(node) {
  const widget = dataWidget(node);
  if (!widget) return;
  widget.hidden = true;
  widget.type = "hidden";
  widget.computeSize = () => [0, -4];
  widget.options = { ...widget.options, hidden: true };
}

const STYLE = `
.b24-lora-list { box-sizing: border-box; width: 100%; display: flex; flex-direction: column; gap: ${ROW_GAP}px; font: 12px sans-serif; color: var(--input-text, #ddd); }
.b24-lora-toolbar { display: flex; gap: 6px; height: ${TOOLBAR_HEIGHT - ROW_GAP}px; }
.b24-lora-row { display: flex; align-items: center; gap: 6px; height: ${ROW_HEIGHT}px; padding: 0 4px; box-sizing: border-box; border-radius: 6px; background: var(--comfy-input-bg, #222); border: 1px solid var(--border-color, #444); }
.b24-lora-row.off .b24-lora-name, .b24-lora-row.off .b24-lora-strength { opacity: 0.45; }
.b24-lora-row.mismatch { border-color: #d9a441; }
.b24-lora-on { margin: 0; flex: none; cursor: pointer; }
.b24-lora-name { flex: 1; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: none; border: none; color: inherit; font: inherit; cursor: pointer; padding: 0 2px; }
.b24-lora-name.empty { opacity: 0.6; font-style: italic; }
.b24-lora-strength { flex: none; width: 58px; box-sizing: border-box; height: 20px; background: var(--comfy-menu-bg, #353535); color: inherit; border: 1px solid var(--border-color, #555); border-radius: 4px; font: inherit; text-align: right; }
.b24-lora-remove { flex: none; width: 20px; height: 20px; padding: 0; background: none; border: none; color: inherit; opacity: 0.6; cursor: pointer; }
.b24-lora-remove:hover { opacity: 1; }
.b24-lora-filter { flex: 1; min-width: 0; height: 100%; background: var(--comfy-input-bg, #222); color: inherit; border: 1px solid var(--border-color, #444); border-radius: 6px; font: inherit; }
.b24-lora-add { flex: none; height: 100%; padding: 0 10px; background: var(--comfy-input-bg, #222); color: inherit; border: 1px solid var(--border-color, #444); border-radius: 6px; font: inherit; cursor: pointer; }
.b24-lora-add:hover { background: var(--comfy-menu-bg, #353535); }
.b24-lora-picker { position: fixed; z-index: 10000; width: 380px; max-height: 420px; display: flex; flex-direction: column; gap: 6px; padding: 8px; box-sizing: border-box; border-radius: 8px; background: var(--comfy-menu-bg, #353535); color: var(--fg-color, #ddd); border: 1px solid var(--border-color, #555); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); font: 12px sans-serif; }
.b24-lora-search { box-sizing: border-box; width: 100%; height: 26px; padding: 0 8px; background: var(--comfy-input-bg, #222); color: inherit; border: 1px solid var(--border-color, #555); border-radius: 6px; font: inherit; }
.b24-lora-results { overflow-y: auto; display: flex; flex-direction: column; }
.b24-lora-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; text-align: left; padding: 4px 6px; background: none; border: none; border-radius: 4px; color: inherit; font: inherit; cursor: pointer; }
.b24-lora-item:hover, .b24-lora-item.active { background: rgba(128, 128, 128, 0.25); }
.b24-lora-item.selected .b24-lora-item-name { font-weight: bold; }
.b24-lora-item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.b24-lora-badge { flex: none; padding: 0 6px; border-radius: 8px; background: rgba(90, 140, 220, 0.35); font-size: 11px; }
.b24-lora-badge.unknown { background: rgba(128, 128, 128, 0.3); }
.b24-lora-more { padding: 4px 6px; opacity: 0.7; }
`;

app.registerExtension({
  name: "b24nodes.MultiLoraLoader",

  setup() {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.append(style);
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = onNodeCreated?.apply(this, args);
      const node = this;
      hideDataWidget(node);

      node.b24Rows = [];
      node.b24List = element("div", "b24-lora-list");
      const widget = node.addDOMWidget(LIST_WIDGET, "b24loralist", node.b24List, {
        serialize: false,
        getMinHeight: () => listHeight(node),
        getMaxHeight: () => listHeight(node),
      });
      widget.serialize = false;
      loadRows(node);
      return result;
    };

    // A loaded workflow sets the JSON and the properties after the node was created.
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = onConfigure?.apply(this, args);
      loadRows(this);
      return result;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function (...args) {
      if (openPicker?.node === this) closePicker();
      return onRemoved?.apply(this, args);
    };
  },
});
