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
const MIN_NODE_WIDTH = 400;
const TOOLBAR_HEIGHT = 38;
const ROW_HEIGHT = 30;
const ROW_GAP = 6;
const STRENGTH_STEP = 0.05;
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
    .then(({ loras, parents }) => {
      const counts = new Map();
      for (const { base } of loras) if (base) counts.set(base, (counts.get(base) ?? 0) + 1);
      const bases = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return { entries: loras, baseByName: new Map(loras.map(({ name, base }) => [name, base])), bases, parents };
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

/** The family a variant such as Pony belongs to (SDXL), if the filter is one. */
const parentOf = (node) => node.b24Catalog?.parents?.[baseFilter(node)];

/**
 * True when a LoRA is known to be trained for another base than the filter. A
 * LoRA of the parent family (plain SDXL under "Pony") is not known to be wrong.
 */
function isMismatch(node, file) {
  const filter = baseFilter(node);
  const base = node.b24Catalog?.baseByName.get(file);
  return filter !== ALL_BASES && Boolean(base) && base !== filter && base !== parentOf(node);
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
  const line = element("div", "b24-lora-row");
  line.classList.toggle("off", row.on === false);
  line.classList.toggle("mismatch", row.lora && isMismatch(node, row.lora));

  const toggle = element("button", "b24-lora-on");
  toggle.type = "button";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(row.on !== false));
  toggle.title = "Enable or disable this LoRA";
  toggle.addEventListener("click", () => {
    row.on = row.on === false;
    toggle.setAttribute("aria-checked", String(row.on));
    line.classList.toggle("off", !row.on);
    writeRows(node);
  });

  const name = element("button", "b24-lora-name");
  name.type = "button";
  name.append(
    element("span", "b24-lora-name-text", row.lora ? displayName(row.lora) : NO_LORA_LABEL),
    element("span", "b24-lora-chevron", "⌄"),
  );
  const base = node.b24Catalog?.baseByName.get(row.lora);
  name.title = row.lora ? `${row.lora}${base ? ` - ${base}` : ""}` : "Click to choose a LoRA";
  name.classList.toggle("empty", !row.lora);
  name.addEventListener("click", () => showPicker(node, row, name));

  // "- 1.00 +" like the number widgets of ComfyUI.
  const stepper = element("div", "b24-lora-stepper");
  stepper.title = "Strength for model and CLIP";
  const strength = element("input", "b24-lora-strength");
  strength.type = "number";
  strength.min = "-100";
  strength.max = "100";
  strength.step = String(STRENGTH_STEP);
  strength.value = Number(row.strength ?? 1).toFixed(2);
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
  const nudge = (label, direction) => {
    const button = element("button", "b24-lora-nudge", label);
    button.type = "button";
    button.addEventListener("click", () => {
      row.strength = Math.round((Number(row.strength ?? 1) + direction * STRENGTH_STEP) * 100) / 100;
      strength.value = row.strength.toFixed(2);
      writeRows(node);
    });
    return button;
  };
  stepper.append(nudge("−", -1), strength, nudge("+", 1));

  const remove = element("button", "b24-lora-remove", "✕");
  remove.type = "button";
  remove.title = "Remove this row";
  remove.addEventListener("click", () => {
    node.b24Rows.splice(node.b24Rows.indexOf(row), 1);
    writeRows(node);
    renderList(node);
  });

  line.append(toggle, name, stepper, remove);
  return line;
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
  const parent = parentOf(node);
  const popup = element("div", "b24-lora-picker");
  const search = element("input", "b24-lora-search");
  search.type = "search";
  search.placeholder = filter === ALL_BASES ? "Search LoRAs" : `Search ${filter} LoRAs`;
  const results = element("div", "b24-lora-results");
  popup.append(search);

  // LoRAs of the parent family may or may not work with a variant, so they are
  // only listed on request.
  let withParent = false;
  if (parent) {
    const label = element("label", "b24-lora-parent");
    const checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.addEventListener("change", () => {
      withParent = checkbox.checked;
      active = 0;
      show();
    });
    label.append(checkbox, ` Also show ${parent} LoRAs without a ${filter} hint`);
    popup.append(label);
  }
  popup.append(results);

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
        (filter === ALL_BASES || !base || base === filter || (withParent && base === parent)) &&
        name.toLowerCase().includes(needle),
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
.b24-lora-list { --field: var(--component-node-widget-background, #313235); box-sizing: border-box; width: 100%; display: flex; flex-direction: column; gap: ${ROW_GAP}px; font: 13px Inter, Arial, sans-serif; color: #fff; }
.b24-lora-list button, .b24-lora-list select, .b24-lora-list input { font: inherit; color: inherit; }
.b24-lora-toolbar { display: flex; gap: 6px; height: ${TOOLBAR_HEIGHT - ROW_GAP}px; }
.b24-lora-filter, .b24-lora-add { height: 100%; background: var(--field); border: none; border-radius: 6px; padding: 0 10px; cursor: pointer; }
.b24-lora-filter { flex: 1; min-width: 0; }
.b24-lora-add { flex: none; }
.b24-lora-add:hover { filter: brightness(1.25); }
.b24-lora-row { display: flex; align-items: center; gap: 6px; height: ${ROW_HEIGHT}px; border-radius: 6px; border: 1px solid transparent; box-sizing: border-box; }
.b24-lora-row.mismatch { border-color: #d9a441; }
.b24-lora-row.off .b24-lora-name, .b24-lora-row.off .b24-lora-stepper { opacity: 0.45; }
.b24-lora-on { flex: none; position: relative; width: 32px; height: 18px; padding: 0; border: none; border-radius: 9px; background: #555; cursor: pointer; transition: background 0.15s; }
.b24-lora-on::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: left 0.15s; }
.b24-lora-on[aria-checked="true"] { background: #3b82c4; }
.b24-lora-on[aria-checked="true"]::after { left: 16px; }
.b24-lora-name { flex: 1; min-width: 0; height: 100%; display: flex; align-items: center; gap: 4px; padding: 0 8px; background: var(--field); border: none; border-radius: 6px; text-align: left; cursor: pointer; }
.b24-lora-name:hover, .b24-lora-stepper:hover { filter: brightness(1.15); }
.b24-lora-name-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.b24-lora-name.empty .b24-lora-name-text { opacity: 0.6; }
.b24-lora-chevron { flex: none; opacity: 0.6; line-height: 1; }
.b24-lora-stepper { flex: none; width: 112px; height: 100%; display: flex; align-items: center; background: var(--field); border-radius: 6px; overflow: hidden; }
.b24-lora-nudge { flex: none; width: 28px; height: 100%; padding: 0; background: none; border: none; opacity: 0.6; cursor: pointer; font-size: 16px; }
.b24-lora-nudge:hover { opacity: 1; background: rgba(128, 128, 128, 0.2); }
.b24-lora-strength { flex: 1; min-width: 0; width: 100%; height: 100%; padding: 0; background: none; border: none; text-align: center; -moz-appearance: textfield; }
.b24-lora-strength::-webkit-inner-spin-button, .b24-lora-strength::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.b24-lora-remove { flex: none; width: 22px; height: 100%; padding: 0; background: none; border: none; opacity: 0.5; cursor: pointer; }
.b24-lora-remove:hover { opacity: 1; }
.b24-lora-picker { position: fixed; z-index: 10000; width: 400px; max-height: 440px; display: flex; flex-direction: column; gap: 6px; padding: 8px; box-sizing: border-box; border-radius: 8px; background: var(--comfy-menu-bg, #353535); color: var(--fg-color, #ddd); border: 1px solid var(--border-color, #555); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); font: 13px Inter, Arial, sans-serif; }
.b24-lora-search { box-sizing: border-box; width: 100%; height: 30px; padding: 0 10px; background: var(--component-node-widget-background, #313235); color: inherit; border: none; border-radius: 6px; font: inherit; }
.b24-lora-results { overflow-y: auto; display: flex; flex-direction: column; }
.b24-lora-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; text-align: left; padding: 6px 8px; background: none; border: none; border-radius: 4px; color: inherit; font: inherit; cursor: pointer; }
.b24-lora-item:hover, .b24-lora-item.active { background: rgba(128, 128, 128, 0.25); }
.b24-lora-item.selected .b24-lora-item-name { font-weight: bold; }
.b24-lora-item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.b24-lora-badge { flex: none; padding: 0 6px; border-radius: 8px; background: rgba(90, 140, 220, 0.35); font-size: 11px; }
.b24-lora-badge.unknown { background: rgba(128, 128, 128, 0.3); }
.b24-lora-more { padding: 4px 6px; opacity: 0.7; }
.b24-lora-parent { display: flex; align-items: center; gap: 4px; opacity: 0.85; cursor: pointer; }
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
