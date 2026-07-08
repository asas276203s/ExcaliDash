import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Regression guard for the production Safari crash:
 *
 *   ReferenceError: Can't find variable: document
 *   at index-*.js  (the Vite modulepreload polyfill, line 2, col ~372)
 *
 * Root cause: Excalidraw's font-subsetting runs in a module Web Worker
 * (`subset-worker.chunk.js` self-spawns via
 * `new Worker(new URL(import.meta.url), { type: "module" })`). Vite/Rollup used
 * to dedupe Excalidraw's internal shared chunks into the APP ENTRY chunk, so the
 * worker transitively imported the entry — whose top-level runs the modulepreload
 * polyfill (`document.createElement`) and `main.tsx` (`document.getElementById`).
 * Workers have no `document`, so the worker crashed on load.
 *
 * The fix (vite.config.ts `manualChunks`) keeps Excalidraw's internal chunks in
 * their own output chunks, so the worker imports only DOM-free, worker-safe code.
 *
 * These tests build the app (production mode) and assert:
 *  1. the worker's transitive import graph never reaches the app entry chunk,
 *  2. no worker-reachable chunk carries the modulepreload polyfill, and
 *  3. every worker-reachable chunk imports cleanly with no `document` / `window`.
 */

const frontendRoot = path.resolve(__dirname, "..", "..");

let assetsDir: string;
let outDir: string;

function transitiveImports(dir: string, entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) continue;
    const code = fs.readFileSync(full, "utf8");
    for (const m of code.matchAll(/from\s*["']\.\/([^"']+)["']/g)) stack.push(m[1]);
    for (const m of code.matchAll(/\bimport\s*["']\.\/([^"']+)["']/g)) stack.push(m[1]);
  }
  return seen;
}

function findWorkerEntry(files: string[]): string {
  const worker = files.find((f) => /^subset-worker\.chunk-.*\.js$/.test(f));
  if (!worker) {
    throw new Error(
      "subset-worker.chunk-*.js was not emitted — Excalidraw's font-subset " +
        "worker is no longer a standalone chunk (check the build config).",
    );
  }
  return worker;
}

/** The real app entry is whatever index.html loads as a module script. */
function appEntryChunk(): string {
  const html = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
  const m = html.match(/<script[^>]*type="module"[^>]*src="[^"]*\/([^"/]+\.js)"/);
  if (!m) throw new Error("could not find the app entry <script> in index.html");
  return m[1];
}

beforeAll(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "excalidash-worker-safety-"));
  execFileSync(
    path.join(frontendRoot, "node_modules", ".bin", "vite"),
    ["build", "--outDir", outDir, "--emptyOutDir", "--mode", "production"],
    {
      cwd: frontendRoot,
      stdio: "pipe",
      // Force a production build regardless of the NODE_ENV vitest runs under,
      // so chunking matches what ships.
      env: { ...process.env, NODE_ENV: "production" },
    },
  );
  assetsDir = path.join(outDir, "assets");
}, 180_000);

describe("Excalidraw font-subset worker DOM safety", () => {
  it("worker's transitive imports exclude the app entry chunk", () => {
    const reachable = transitiveImports(assetsDir, findWorkerEntry(fs.readdirSync(assetsDir)));
    const entry = appEntryChunk();
    expect(
      reachable.has(entry),
      `worker transitively imports the app entry chunk "${entry}", whose top-level ` +
        `touches document and crashes in a Web Worker`,
    ).toBe(false);
  });

  it("no worker-reachable chunk carries the Vite modulepreload polyfill", () => {
    const worker = findWorkerEntry(fs.readdirSync(assetsDir));
    const reachable = transitiveImports(assetsDir, worker);
    const offenders: string[] = [];
    for (const chunk of reachable) {
      const full = path.join(assetsDir, chunk);
      if (!fs.existsSync(full)) continue;
      const code = fs.readFileSync(full, "utf8");
      // Signature of the modulepreload polyfill IIFE that crashed in the worker.
      if (code.includes('document.createElement("link").relList')) offenders.push(chunk);
    }
    expect(
      offenders,
      `these worker-reachable chunks contain the modulepreload polyfill: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("worker-reachable chunks import cleanly in a workerless (no document/window) context", () => {
    const worker = findWorkerEntry(fs.readdirSync(assetsDir));
    const reachable = [...transitiveImports(assetsDir, worker)].filter(
      // Skip the worker entry itself: it self-spawns via
      // `new Worker(new URL(import.meta.url))`, referencing the web Worker global
      // that Node lacks. That is not a DOM-safety concern — only its imports are.
      (f) => f !== worker && fs.existsSync(path.join(assetsDir, f)),
    );
    expect(reachable.length).toBeGreaterThan(0);

    // A bare Node module process has no `document`/`window` — exactly like a Web
    // Worker global scope. Importing each worker-reachable chunk there proves its
    // top-level code never touches the DOM. (Done in a subprocess because
    // vitest's module runner would otherwise intercept the dynamic import.)
    const urls = reachable.map((f) => pathToFileURL(path.join(assetsDir, f)).href);
    const script =
      "for (const u of process.argv.slice(1)) { await import(u); }";
    execFileSync("node", ["--input-type=module", "-e", script, ...urls], {
      stdio: "pipe",
    });
  }, 60_000);
});
