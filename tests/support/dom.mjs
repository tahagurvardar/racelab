// A browser-like environment for component tests: jsdom globals, React's act
// environment, a fake Tauri bridge and a render probe. Import this module
// FIRST in a test file — React DOM reads the DevTools hook and `window` when
// it loads.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const { window } = dom;

for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis) continue;
  try {
    globalThis[key] = window[key];
  } catch {
    // Some window properties are not assignable in Node; none are needed.
  }
}
globalThis.window = window;
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ------------------------------------------------------------- fake Tauri

/// Command → response. A test replaces entries as it needs; an unknown
/// command rejects, so a component calling something unexpected fails loudly.
export const responses = new Map();
export const calls = [];

let callbackId = 0;
window.__TAURI_INTERNALS__ = {
  transformCallback: () => ++callbackId,
  unregisterCallback() {},
  async invoke(command, args = {}) {
    calls.push(command);
    if (command === "plugin:event|listen") return ++callbackId;
    if (command === "plugin:event|unlisten") return undefined;
    if (!responses.has(command)) {
      throw new Error(`fake backend: no response for ${command}`);
    }
    // A response may be a promise, so a test can hold a reply back and
    // release replies out of order.
    return structuredClone(await responses.get(command)(args));
  },
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };

// ------------------------------------------------------------ render probe

/// Which components actually rendered, counted per commit through React's
/// DevTools hook — no instrumentation in the application. A fiber was
/// processed in a commit iff it is not the same object as in the previous
/// committed tree; it rendered iff React also flagged it PerformedWork (1).
export const renders = {};
export function resetRenders() {
  for (const key of Object.keys(renders)) delete renders[key];
}
let previous = new WeakSet();
globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true,
  isDisabled: false,
  renderers: new Map(),
  inject: () => 1,
  checkDCE() {},
  onScheduleFiberRoot() {},
  onCommitFiberUnmount() {},
  onPostCommitFiberRoot() {},
  onCommitFiberRoot(_id, root) {
    const seen = new WeakSet();
    const stack = [root.current];
    while (stack.length) {
      const fiber = stack.pop();
      seen.add(fiber);
      const type = fiber.type;
      if (
        type &&
        typeof type === "function" &&
        !previous.has(fiber) &&
        (fiber.flags & 1) === 1
      ) {
        const name = type.displayName ?? type.name;
        if (name) renders[name] = (renders[name] ?? 0) + 1;
      }
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    previous = seen;
  },
};

// ---------------------------------------------------------------- helpers

/// Elements reachable with Tab, in document order — jsdom has no sequential
/// focus navigation, so the order is computed the way a browser does for
/// tabindex 0 elements.
export function tabbables(root = document.body) {
  return [...root.querySelectorAll("*")].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.disabled &&
      !element.closest("[hidden]") &&
      (element.matches("button, input, select, textarea, a[href]") ||
        element.hasAttribute("tabindex")),
  );
}

export function nextTabbable(from) {
  const list = tabbables();
  return list[list.indexOf(from) + 1] ?? null;
}
