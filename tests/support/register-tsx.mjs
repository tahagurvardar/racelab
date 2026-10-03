// Lets the Node test runner import the application's .tsx components.
// Node strips .ts types itself; .tsx is compiled by Vite's own esbuild
// transform (no extra dependency). Loaded with `--import` by test:frontend.
import { register } from "node:module";

register("./tsx-hooks.mjs", import.meta.url);
