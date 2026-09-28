/**
 * Tiny event bus for PME UI (framework-free).
 *
 * Goal: decouple UI components so we can expand without cross-import spaghetti.
 */

export const UI_EVENTS = Object.freeze({
  PERSONA_CHANGED: "persona:changed",
  PERSONA_DESC_CHANGED: "persona:desc_changed",
  PERSONA_LIST_INVALIDATED: "persona:list_invalidated",
});

/**
 * @template Payload
 * @typedef {(payload: Payload) => void} Handler
 */

export function createUiBus() {
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();

  /**
   * @template Payload
   * @param {string} event
   * @param {Handler<Payload>} handler
   */
  function on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(handler);
    return () => off(event, handler);
  }

  /**
   * @template Payload
   * @param {string} event
   * @param {Handler<Payload>} handler
   */
  function off(event, handler) {
    handlers.get(event)?.delete(handler);
  }

  /**
   * @template Payload
   * @param {string} event
   * @param {Payload} payload
   */
  function emit(event, payload) {
    const set = handlers.get(event);
    if (!set || !set.size) return;
    // Snapshot to avoid issues if handlers mutate subscriptions
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (e) {
        // Don't let one handler break others
        console.warn("[PME] uiBus handler failed", event, e);
      }
    }
  }

  return { on, off, emit };
}
