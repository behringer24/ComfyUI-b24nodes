/**
 * Frontend extension for the "Color Picker (b24)" node.
 *
 * The node stores a color *name* in its "color" combo. This extension adds a
 * swatch below the combo that shows the selected color; clicking it opens a
 * palette with every named color, grouped by family, plus a free color picker
 * whose result is mapped to the nearest name. The palette comes from
 * ``/b24nodes/colors``, so the python module stays the only place the colors
 * are defined.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "B24ColorPicker";
const COLOR_WIDGET = "color";
const SWATCH_WIDGET = "swatch";
const SWATCH_HEIGHT = 32;
const LOG_PREFIX = "[b24nodes]";

let palettePromise = null;

/** Fetch the palette once: ``{groups, hexByName}``. A failed request is retried later. */
function loadPalette() {
  palettePromise ??= api
    .fetchApi("/b24nodes/colors")
    .then((response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.json();
    })
    .then(({ groups }) => {
      const hexByName = new Map();
      for (const group of groups) {
        for (const { name, hex } of group.colors) hexByName.set(name, hex);
      }
      return { groups, hexByName };
    })
    .catch((error) => {
      palettePromise = null;
      console.error(`${LOG_PREFIX} could not load the color palette`, error);
      return null;
    });
  return palettePromise;
}

/** CIE L*a*b* of a "#RRGGBB" color (sRGB, D65). */
function hexToLab(hex) {
  const value = parseInt(hex.slice(1), 16);
  const [r, g, b] = [value >> 16, value >> 8, value].map((channel) => {
    const c = (channel & 255) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Name of the palette color that looks closest to ``hex`` (CIE76 distance). */
function nearestName(palette, hex) {
  const target = hexToLab(hex);
  let best = null;
  let bestDistance = Infinity;
  for (const [name, candidate] of palette.hexByName) {
    const distance = Math.hypot(...hexToLab(candidate).map((v, i) => v - target[i]));
    if (distance < bestDistance) [best, bestDistance] = [name, distance];
  }
  return best;
}

/** Black or white, whichever reads better on ``hex``. */
function textColorFor(hex) {
  return hexToLab(hex)[0] > 60 ? "#000" : "#fff";
}

function paint(element, name, hex) {
  element.textContent = name ?? "";
  element.style.background = hex ?? "transparent";
  element.style.color = hex ? textColorFor(hex) : "inherit";
}

/** Show the selected color on the swatch of ``node``. */
async function updateSwatch(node) {
  const element = node.b24Swatch;
  if (!element) return;
  const palette = await loadPalette();
  const name = node.widgets?.find((widget) => widget.name === COLOR_WIDGET)?.value;
  paint(element, name, palette?.hexByName.get(name));
}

function selectColor(node, name) {
  const widget = node.widgets?.find((entry) => entry.name === COLOR_WIDGET);
  if (!widget || !name) return;
  widget.value = name;
  widget.callback?.(name);
  node.setDirtyCanvas?.(true, true);
  // The change tracker looks at the graph on mouseup, which fires before the
  // click on a palette entry - without this the pick misses undo and the
  // "modified" marker of the workflow.
  app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.captureCanvasState?.();
}

let openPopup = null;

function closePopup() {
  openPopup?.close();
}

/** Open the palette below the swatch of ``node``. */
async function showPalette(node) {
  closePopup();
  const palette = await loadPalette();
  if (!palette || !node.b24Swatch) return;

  const current = node.widgets?.find((widget) => widget.name === COLOR_WIDGET)?.value;
  const popup = document.createElement("div");
  popup.className = "b24-color-popup";

  const preview = document.createElement("div");
  preview.className = "b24-color-preview";
  const showPreview = (name) => paint(preview, name, palette.hexByName.get(name));
  showPreview(current);
  popup.append(preview);

  const pick = (name) => {
    selectColor(node, name);
    closePopup();
  };

  for (const group of palette.groups) {
    const row = document.createElement("div");
    row.className = "b24-color-row";
    row.title = group.name;
    for (const { name, hex } of group.colors) {
      const button = document.createElement("button");
      button.type = "button";
      button.title = name;
      button.style.background = hex;
      button.classList.toggle("selected", name === current);
      button.addEventListener("pointerenter", () => showPreview(name));
      button.addEventListener("pointerleave", () => showPreview(current));
      button.addEventListener("click", () => pick(name));
      row.append(button);
    }
    popup.append(row);
  }

  // Any color, snapped to the nearest name. "input" fires while dragging in
  // the browser's picker, "change" once it is confirmed.
  const custom = document.createElement("label");
  custom.className = "b24-color-custom";
  custom.textContent = "Any color → nearest name ";
  const input = document.createElement("input");
  input.type = "color";
  input.value = palette.hexByName.get(current) ?? "#000000";
  input.addEventListener("input", () => showPreview(nearestName(palette, input.value)));
  input.addEventListener("change", () => pick(nearestName(palette, input.value)));
  custom.append(input);
  popup.append(custom);

  document.body.append(popup);
  const anchor = node.b24Swatch.getBoundingClientRect();
  const { width, height } = popup.getBoundingClientRect();
  popup.style.left = `${Math.max(4, Math.min(anchor.left, innerWidth - width - 4))}px`;
  popup.style.top = `${anchor.bottom + height + 4 <= innerHeight ? anchor.bottom + 4 : Math.max(4, anchor.top - height - 4)}px`;

  const onPointerDown = (event) => {
    if (!popup.contains(event.target)) closePopup();
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") closePopup();
  };
  // Registered on the next tick, so the click that opened the popup does not close it.
  const timer = setTimeout(() => document.addEventListener("pointerdown", onPointerDown, true), 0);
  document.addEventListener("keydown", onKeyDown, true);

  openPopup = {
    node,
    close() {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      popup.remove();
      openPopup = null;
    },
  };
}

const STYLE = `
.b24-color-swatch {
  box-sizing: border-box; height: ${SWATCH_HEIGHT}px; border-radius: 6px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--border-color, #555); font: 13px sans-serif; user-select: none;
}
.b24-color-popup {
  position: fixed; z-index: 10000; padding: 8px; border-radius: 8px;
  background: var(--comfy-menu-bg, #353535); color: var(--fg-color, #ddd);
  border: 1px solid var(--border-color, #555); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  font: 12px sans-serif; display: flex; flex-direction: column; gap: 4px;
}
.b24-color-preview { height: 28px; border-radius: 5px; display: flex; align-items: center; justify-content: center; font-size: 13px; }
.b24-color-row { display: flex; gap: 3px; }
.b24-color-row button {
  width: 22px; height: 22px; padding: 0; border-radius: 4px; cursor: pointer;
  border: 1px solid rgba(128, 128, 128, 0.6);
}
.b24-color-row button:hover { transform: scale(1.15); }
.b24-color-row button.selected { outline: 2px solid var(--fg-color, #ddd); outline-offset: 1px; }
.b24-color-custom { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
.b24-color-custom input { width: 40px; height: 24px; padding: 0; border: none; background: none; cursor: pointer; }
`;

app.registerExtension({
  name: "b24nodes.ColorPicker",

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

      const element = document.createElement("div");
      element.className = "b24-color-swatch";
      element.title = "Click to pick a color";
      element.addEventListener("click", () => showPalette(node));
      const swatch = node.addDOMWidget(SWATCH_WIDGET, "b24colorswatch", element, {
        serialize: false,
        getMinHeight: () => SWATCH_HEIGHT,
        getMaxHeight: () => SWATCH_HEIGHT,
      });
      swatch.serialize = false;
      node.b24Swatch = element;

      const widget = node.widgets?.find((entry) => entry.name === COLOR_WIDGET);
      if (widget) {
        const callback = widget.callback;
        widget.callback = function (...callbackArgs) {
          const callbackResult = callback?.apply(this, callbackArgs);
          updateSwatch(node);
          return callbackResult;
        };
      }
      updateSwatch(node);
      return result;
    };

    // A loaded workflow sets the combo value after the node was created.
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = onConfigure?.apply(this, args);
      updateSwatch(this);
      return result;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function (...args) {
      if (openPopup?.node === this) closePopup();
      return onRemoved?.apply(this, args);
    };
  },
});
