// Real painted layout for tests that jsdom cannot answer (scroll extents,
// element bounds). Runs the dev-only review harness in a headless
// Chromium-family browser over the DevTools protocol, with Node's built-in
// WebSocket and Vite's own dev server: no added dependency.
//
// The browser is the one already installed on the machine (Chrome or Edge on
// Windows), or RACELAB_TEST_BROWSER. If none is found the suite reports a
// skip with the reason; it never passes silently.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const CANDIDATES = [
  process.env.RACELAB_TEST_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

export function findBrowser() {
  return CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, what, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
}

class Page {
  #socket;
  #next = 0;
  #pending = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.#next;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) =>
      this.#pending.set(id, { resolve, reject }),
    );
  }

  /// Evaluates an expression (awaiting a returned promise) and returns its
  /// JSON value. Throws the page's own exception text on failure.
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    }
    return result.result.value;
  }

  async size(width, height) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  close() {
    this.#socket.close();
  }
}

/// Starts Vite and a headless browser, and returns helpers, or null (with the
/// reason) when no browser is installed.
export async function startBrowser() {
  const executable = findBrowser();
  if (!executable) {
    return { skip: "no Chrome/Edge/Chromium found (set RACELAB_TEST_BROWSER)" };
  }

  const { createServer } = await import("vite");
  const port = await freePort();
  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, "vite.config.ts"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port, strictPort: true },
  });
  await server.listen();

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "racelab-layout-"));
  const browser = spawn(
    executable,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const portFile = path.join(profile, "DevToolsActivePort");
  const devtoolsPort = await waitFor(() => {
    try {
      return fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
    } catch (error) {
      // Chrome can still hold its port file while writing it on Windows.
      // Retry that transient startup race within the existing timeout.
      if (error.code === "ENOENT" || error.code === "EBUSY") return false;
      throw error;
    }
  }, "browser DevTools port");
  const target = await waitFor(async () => {
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)
      ).json();
      return list.find((item) => item.type === "page");
    } catch {
      return null;
    }
  }, "browser page target");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const page = new Page(socket);
  await page.send("Runtime.enable");
  await page.send("Page.enable");

  return {
    page,
    /// Opens a harness URL and waits until the shell has rendered.
    async open(pathname) {
      await page.send("Page.navigate", {
        url: `http://127.0.0.1:${port}${pathname}`,
      });
      await waitFor(
        () =>
          page
            .evaluate(
              "document.readyState === 'complete' && !!document.querySelector('.workspace-view h1')",
            )
            .catch(() => false),
        `render of ${pathname}`,
      );
      // Let the mock's first polls settle into a steady frame.
      await sleep(600);
    },
    async close() {
      page.close();
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(browser.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else {
        browser.kill("SIGKILL");
      }
      await server.close();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          fs.rmSync(profile, { recursive: true, force: true });
          break;
        } catch {
          await sleep(200); // the browser may still hold profile files
        }
      }
    },
  };
}
