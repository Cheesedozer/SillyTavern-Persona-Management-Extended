/**
 * Borrow native SillyTavern / SillyBunny DOM nodes into the PME UI and put them back later.
 * Real nodes are moved (not cloned) so all native event handlers and id-based updates keep working.
 */

/** @type {Map<HTMLElement, {parent: Node, nextSibling: ChildNode|null}>} */
const origins = new Map();

/**
 * @param {Element|null} node
 * @param {HTMLElement} target
 * @param {Node|null} [before]
 * @returns {boolean} true when the node exists and is now inside target
 */
export function borrowNative(node, target, before = null) {
  if (!(node instanceof HTMLElement)) return false;
  if (!origins.has(node) && node.parentNode) {
    origins.set(node, { parent: node.parentNode, nextSibling: node.nextSibling });
  }
  if (node.parentNode !== target || (before && node.nextSibling !== before)) {
    target.insertBefore(node, before && before.parentNode === target ? before : null);
  }
  return true;
}

export function returnAllNative() {
  for (const [node, origin] of origins.entries()) {
    if (node.parentNode === origin.parent) continue;
    try {
      const next = origin.nextSibling;
      origin.parent.insertBefore(node, next && next.parentNode === origin.parent ? next : null);
    } catch {
      // ignore
    }
  }
  origins.clear();
}
