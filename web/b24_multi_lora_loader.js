/**
 * Frontend extension for the "Multi Lora Loader (b24)" node.
 *
 * The node stores its rows as JSON in the "loras" string widget. This
 * extension hides that widget and shows every row as regular widgets (a
 * toggle, a LoRA combo and a strength number), so it renders the same in the
 * classic canvas and in Nodes 2.0, which cannot run custom canvas drawing.
 * The row widgets are neither stored with the workflow nor sent to the
 * server (``serialize: false``); they are rebuilt from the JSON when a
 * workflow is loaded.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "B24MultiLoraLoader";
const DATA_WIDGET = "loras";
const NO_LORA = "None";
const LOG_PREFIX = "[b24nodes]";

let loraNamesPromise = null;

/** File names of the "loras" folder, fetched once. A failed request is retried later. */
function loadLoraNames() {
  loraNamesPromise ??= api
    .fetchApi("/models/loras")
    .then((response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.json();
    })
    .catch((error) => {
      loraNamesPromise = null;
      console.error(`${LOG_PREFIX} could not list the LoRAs`, error);
      return [];
    });
  return loraNamesPromise;
}

function dataWidget(node) {
  return node.widgets?.find((widget) => widget.name === DATA_WIDGET);
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

/** Write the rows to the data widget and tell the workflow that it changed. */
function writeRows(node) {
  const widget = dataWidget(node);
  if (!widget) return;
  widget.value = JSON.stringify(node.b24Rows);
  widget.callback?.(widget.value);
  node.setDirtyCanvas?.(true, true);
  // Same reason as in the color picker: a click on a button is not seen by
  // the change tracker, which only checks the graph on mouseup.
  app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.captureCanvasState?.();
}

/** Remove the row widgets and the buttons; the data widget stays. */
function clearRowWidgets(node) {
  node.widgets = node.widgets.filter((widget) => widget === dataWidget(node));
}

/** Rebuild the widgets of every row plus the buttons below them. */
async function renderRows(node) {
  const names = await loadLoraNames();
  if (!node.graph) return;

  clearRowWidgets(node);
  node.b24Rows.forEach((row, index) => {
    const number = index + 1;
    const known = row.lora && !names.includes(row.lora) ? [row.lora] : [];
    node.addWidget("toggle", `on ${number}`, row.on !== false, (value) => {
      row.on = value;
      writeRows(node);
    }, { serialize: false });
    node.addWidget("combo", `lora ${number}`, row.lora || NO_LORA, (value) => {
      row.lora = value === NO_LORA ? "" : value;
      writeRows(node);
    }, { values: [NO_LORA, ...known, ...names], serialize: false });
    node.addWidget("number", `strength ${number}`, row.strength ?? 1, (value) => {
      row.strength = value;
      writeRows(node);
    }, { min: -100, max: 100, step: 0.1, step2: 0.01, precision: 2, serialize: false });
  });

  node.addWidget("button", "+ Add LoRA", null, () => {
    node.b24Rows.push({ on: true, lora: "", strength: 1 });
    writeRows(node);
    renderRows(node);
  }, { serialize: false });
  node.addWidget("button", "− Remove last", null, () => {
    node.b24Rows.pop();
    writeRows(node);
    renderRows(node);
  }, { serialize: false });

  const [width, height] = node.computeSize();
  node.setSize([Math.max(node.size[0], width), height]);
  node.setDirtyCanvas?.(true, true);
}

/** Take the rows from the stored JSON and show them. */
function loadRows(node) {
  node.b24Rows = readRows(node);
  renderRows(node);
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

app.registerExtension({
  name: "b24nodes.MultiLoraLoader",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = onNodeCreated?.apply(this, args);
      hideDataWidget(this);
      loadRows(this);
      return result;
    };

    // A loaded workflow sets the JSON after the node was created.
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = onConfigure?.apply(this, args);
      loadRows(this);
      return result;
    };
  },
});
