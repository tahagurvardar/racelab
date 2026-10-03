/// The version a user sees in the window.
///
/// A literal, on purpose: `tests/release-config.test.mjs` compares it with the
/// version in package.json, tauri.conf.json and Cargo.toml, so a release that
/// bumps three files and forgets the fourth fails before it ships.
export const APP_VERSION = "1.1.0";
