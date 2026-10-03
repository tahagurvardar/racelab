/// Guard for the DEV-ONLY review harness. Imported first by every harness
/// entry, so it runs before any mock is installed.
///
/// 1. Development server only. `import.meta.env.DEV` is false in any Vite
///    production build, so harness code that somehow reached a bundle refuses
///    to run instead of presenting fixtures as product UI.
/// 2. Never inside the real application. If the Tauri bridge is present, the
///    mock would replace it; refuse rather than shadow real telemetry.
const reason = !import.meta.env.DEV
  ? "it is development-only and this is a production build"
  : "__TAURI_INTERNALS__" in window
    ? "the real RaceLab backend is present and the mock would replace it"
    : null;

if (reason != null) {
  document.body.textContent = `RaceLab review harness refused to start: ${reason}.`;
  throw new Error(`RaceLab review harness refused to start: ${reason}.`);
}

export {};
