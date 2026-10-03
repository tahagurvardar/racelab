// Trusted keyboard input for the real-browser tests: CDP Input events are
// indistinguishable from a physical keyboard to the page (Tab moves focus,
// Enter and Space activate buttons), which synthetic DOM events are not.

const KEYS = {
  Tab: { code: "Tab", keyCode: 9 },
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  " ": { code: "Space", keyCode: 32, text: " " },
  Escape: { code: "Escape", keyCode: 27 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
};

const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/// Presses one key, e.g. "Tab", "shift+Tab", "ctrl+2", "Enter", " ".
export async function press(page, chord) {
  const parts = chord === " " ? [" "] : chord.split("+");
  const key = parts.pop();
  const modifiers = parts.reduce((sum, name) => sum | MODIFIERS[name], 0);
  const spec =
    KEYS[key] ??
    (/^[0-9a-z]$/i.test(key)
      ? {
          code: /\d/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`,
          keyCode: key.toUpperCase().charCodeAt(0),
          text: key,
        }
      : null);
  if (!spec) throw new Error(`no key spec for ${key}`);
  const base = {
    key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    modifiers,
  };
  const text =
    modifiers & (MODIFIERS.ctrl | MODIFIERS.alt | MODIFIERS.meta)
      ? undefined
      : spec.text;
  await page.send("Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    ...base,
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  // Let React commit and any focus handling settle.
  await page.evaluate("new Promise((resolve) => setTimeout(resolve, 60))");
}

/// What has keyboard focus, in one line: element, role, accessible text, and
/// whether a focus indicator is painted and on screen.
export const FOCUS = `(() => {
  const element = document.activeElement;
  if (!element || element === document.body || element === document.documentElement) {
    return { lost: true, text: "BODY" };
  }
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const name = (element.getAttribute("aria-label") ?? element.textContent ?? "")
    .trim().split(String.fromCharCode(10)).join(" ").split(" ").filter(Boolean).join(" ").slice(0, 40);
  const role = element.getAttribute("role");
  return {
    lost: false,
    tag: element.tagName.toLowerCase(),
    role,
    name,
    ring: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 1,
    onScreen: box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight &&
      box.right > 0 && box.left < innerWidth,
    text: element.tagName.toLowerCase() + (role ? "[" + role + "]" : "") + ' "' + name + '"',
  };
})()`;
