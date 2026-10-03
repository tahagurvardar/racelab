// Node module hooks for component tests.
//
// - Resolves the extensionless relative imports the components use
//   (`./shell/Icon`) to `.tsx` or `.ts`, as Vite does.
// - Compiles `.tsx` with Vite's esbuild transform (automatic JSX runtime).
// - Turns `.css` imports into empty modules; tests do not lay out.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const HAS_EXTENSION = /\.(m?[jt]sx?|c[jt]s|css|json)$/;
let transform;

export async function resolve(specifier, context, next) {
  const fromProject =
    context.parentURL?.startsWith("file:") &&
    !context.parentURL.includes("/node_modules/");
  if (
    fromProject &&
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !HAS_EXTENSION.test(specifier)
  ) {
    for (const extension of [".tsx", ".ts"]) {
      try {
        return await next(specifier + extension, context);
      } catch {
        // Try the next extension.
      }
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith(".css")) {
    return { format: "module", source: "export {};", shortCircuit: true };
  }
  if (url.endsWith(".tsx")) {
    transform ??= (await import("vite")).transformWithEsbuild;
    const path = fileURLToPath(url);
    const result = await transform(await readFile(path, "utf8"), path, {
      loader: "tsx",
      jsx: "automatic",
      format: "esm",
      target: "es2022",
    });
    return { format: "module", source: result.code, shortCircuit: true };
  }
  return next(url, context);
}
