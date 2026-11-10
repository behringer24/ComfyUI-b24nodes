/**
 * Frontend extension for the "Prompt Composer (b24)" node.
 *
 * The node has a single template widget. Every {{name}} placeholder written
 * there gets a STRING input of the same name, so the inputs follow the
 * template while typing:
 *
 *  - a new placeholder adds its input at the bottom,
 *  - an input whose placeholder is gone is removed, unless a link is still
 *    attached - half typed names would otherwise cost the user their links.
 *    Such an input disappears once it is disconnected.
 *
 * The inputs are regular node inputs, so they are stored with the workflow
 * and come back on load without help from this extension.
 */

import { app } from "../../scripts/app.js";

const NODE_TYPE = "B24PromptComposer";
const TEMPLATE_WIDGET = "template";

// Same pattern as PLACEHOLDER in prompt_composer.py.
const PLACEHOLDER = /\{\{\s*([\p{L}\p{N}_]+)\s*\}\}/gu;

/** Placeholder names of a template in order of first appearance. */
function placeholderNames(template) {
  const names = new Set();
  for (const match of String(template ?? "").matchAll(PLACEHOLDER)) names.add(match[1]);
  return [...names];
}

/** Inputs that carry a widget socket ("template") are not variables. */
const isVariableInput = (input) => !input.widget;

/** Add and remove variable inputs so that they match the template. */
function syncInputs(node) {
  const template = node.widgets?.find((widget) => widget.name === TEMPLATE_WIDGET);
  if (!template) return;

  const names = placeholderNames(template.value);
  let changed = false;

  for (let slot = (node.inputs?.length ?? 0) - 1; slot >= 0; slot--) {
    const input = node.inputs[slot];
    if (isVariableInput(input) && input.link == null && !names.includes(input.name)) {
      node.removeInput(slot);
      changed = true;
    }
  }

  for (const name of names) {
    if (node.inputs?.some((input) => input.name === name)) continue;
    node.addInput(name, "STRING");
    changed = true;
  }

  if (!changed) return;
  // Grow only: shrinking would undo a size the user picked for the textarea.
  const [width, height] = node.computeSize();
  node.setSize([Math.max(node.size[0], width), Math.max(node.size[1], height)]);
  node.setDirtyCanvas?.(true, true);
}

/**
 * Sync on the next tick: ``onConnectionsChange`` fires before the link
 * bookkeeping is finished, and a loaded workflow sets the widget value after
 * the node was created.
 */
function scheduleSync(node) {
  clearTimeout(node.b24ComposerSyncTimer);
  node.b24ComposerSyncTimer = setTimeout(() => {
    if (node.graph) syncInputs(node);
  }, 0);
}

app.registerExtension({
  name: "b24nodes.PromptComposer",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = onNodeCreated?.apply(this, args);
      const node = this;
      const template = node.widgets?.find((widget) => widget.name === TEMPLATE_WIDGET);
      if (template) {
        // The textarea calls this on every keystroke.
        const callback = template.callback;
        template.callback = function (...callbackArgs) {
          const callbackResult = callback?.apply(this, callbackArgs);
          syncInputs(node);
          return callbackResult;
        };
      }
      scheduleSync(node);
      return result;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = onConfigure?.apply(this, args);
      scheduleSync(this);
      return result;
    };

    // Disconnecting a stale input removes it.
    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (...args) {
      const result = onConnectionsChange?.apply(this, args);
      scheduleSync(this);
      return result;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function (...args) {
      clearTimeout(this.b24ComposerSyncTimer);
      return onRemoved?.apply(this, args);
    };
  },
});
