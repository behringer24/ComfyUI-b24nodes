/**
 * Frontend extension for the "Resolution Aspect Selector (b24)" node.
 *
 * The node takes its aspect ratio from the optional "image" input as soon as
 * something is connected there, which makes the "aspect_ratio" widget dead
 * weight. This extension greys it out while the input is connected, the same
 * way litegraph marks a widget that was replaced by an input slot: the widget
 * is drawn at half opacity, loses its value text and stepper arrows and is
 * skipped during hit testing, so it can no longer be clicked.
 *
 * Nothing here changes the serialised value - the widget keeps whatever was
 * selected and becomes usable again when the image is disconnected.
 */

import { app } from "../../scripts/app.js";

const NODE_TYPE = "B24ResolutionAspectSelector";
const IMAGE_INPUT = "image";
const ASPECT_WIDGET = "aspect_ratio";

/** True while something is connected to the optional image input. */
function hasImage(node) {
  const slot = node.inputs?.find((input) => input.name === IMAGE_INPUT);
  return slot?.link != null;
}

/** Enable or disable the aspect ratio widget to match the image input. */
function syncAspectWidget(node) {
  const widget = node.widgets?.find((entry) => entry.name === ASPECT_WIDGET);
  if (!widget) return;

  const disabled = hasImage(node);
  if (widget.disabled === disabled) return;

  widget.disabled = disabled;
  node.setDirtyCanvas?.(true, true);
}

/**
 * Sync on the next tick. Link bookkeeping is not finished when
 * ``onConnectionsChange`` fires and ``onConfigure`` restores the links of a
 * loaded workflow after the node exists, so both cases need to wait a tick.
 */
function scheduleSync(node) {
  clearTimeout(node.b24AspectSyncTimer);
  node.b24AspectSyncTimer = setTimeout(() => {
    if (node.graph) syncAspectWidget(node);
  }, 0);
}

app.registerExtension({
  name: "b24nodes.ResolutionAspectSelector",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = onNodeCreated?.apply(this, args);
      scheduleSync(this);
      return result;
    };

    // Loading a workflow restores the links after the node was created.
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = onConfigure?.apply(this, args);
      scheduleSync(this);
      return result;
    };

    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (...args) {
      const result = onConnectionsChange?.apply(this, args);
      // Update right away so the widget reacts while the link is dropped, and
      // once more on the next tick in case the slot was not updated yet.
      syncAspectWidget(this);
      scheduleSync(this);
      return result;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function (...args) {
      clearTimeout(this.b24AspectSyncTimer);
      return onRemoved?.apply(this, args);
    };
  },
});
