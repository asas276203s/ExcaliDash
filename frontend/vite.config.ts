import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const versionFilePath = path.resolve(__dirname, "../VERSION");
let versionFromFile = "0.0.0";

try {
  const raw = fs.readFileSync(versionFilePath, "utf8").trim();
  if (raw) {
    versionFromFile = raw;
  }
} catch (error) {
  console.warn("Unable to read VERSION file:", error);
}

const appVersion = process.env.VITE_APP_VERSION?.trim() || versionFromFile;
const buildLabel = process.env.VITE_APP_BUILD_LABEL?.trim() || "local development build";

/**
 * Resolve a build-unique version string, baked into the bundle AND written to
 * `dist/version.json`. This is what powers the frontend-bundle update banner:
 * a running tab periodically fetches `/version.json` and compares its
 * `version` to the value baked into its own bundle — so ANY new frontend
 * deploy (even backend-unchanged, VERSION-file-unchanged) is detected.
 *
 * Resolution order (first non-empty wins):
 *  1. git short SHA        — local/CI builds that have a `.git` checkout
 *  2. CI-provided commit   — Zeabur/GitHub inject the deploy SHA as an env/arg
 *  3. `build-<timestamp>`  — guaranteed-unique fallback so every build differs
 *     (Docker build stage copies no `.git`, so this or (2) is what ships)
 */
const resolveBuildVersion = (): string => {
  try {
    const sha = execSync("git rev-parse --short=12 HEAD", {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (sha) return sha;
  } catch {
    // no git available (e.g. Docker build stage) — fall through
  }
  const ciSha =
    process.env.VITE_BUILD_HASH?.trim() ||
    process.env.ZEABUR_GIT_COMMIT_SHA?.trim() ||
    process.env.SOURCE_COMMIT?.trim() ||
    process.env.GIT_COMMIT?.trim();
  if (ciSha) return ciSha.slice(0, 12);
  return `build-${Date.now()}`;
};

const buildVersion = resolveBuildVersion();
// Backward-compat: `__BUILD_HASH__` predates this feature; keep it pointing at
// the same resolved value so any future diagnostics use stays consistent.
const buildHash = buildVersion;

/**
 * Emits `dist/version.json` so a deployed, long-lived tab can poll it and learn
 * a newer frontend bundle has shipped. Build-only; never runs in dev/test.
 */
const versionJsonPlugin = (version: string): Plugin => ({
  name: "excalidash-version-json",
  apply: "build",
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "version.json",
      source: JSON.stringify(
        { version, builtAt: new Date().toISOString() },
        null,
        2,
      ),
    });
  },
});

export default defineConfig(({ command }) => {
  const nodeEnv = process.env.NODE_ENV || (command === "build" ? "production" : "development");
  const devBackendTarget = process.env.VITE_DEV_BACKEND_URL?.trim() || "http://localhost:8000";
  const processEnvDefines = {
    'process.env.IS_PREACT': JSON.stringify("false"),
    'process.env.NODE_ENV': JSON.stringify(nodeEnv),
  };

  return {
    plugins: [react(), versionJsonPlugin(buildVersion)],
    build: {
      rollupOptions: {
        output: {
          // Excalidraw's font-subsetting runs in a module Web Worker:
          // `subset-worker.chunk.js` is dynamically imported, then self-spawns
          // via `new Worker(new URL(import.meta.url), { type: "module" })`. Its
          // transitive shared deps (`dist/prod/chunk-*.js`) are worker-safe by
          // Excalidraw's design. But Vite/Rollup dedupes those shared modules
          // (including the CJS-interop `__require` helper) into the APP ENTRY
          // chunk, because the main thread imports the same modules. The worker
          // then transitively imports the entry, whose top-level runs the Vite
          // modulepreload polyfill (`document.createElement`) and `main.tsx`
          // (`document.getElementById`) — both throw
          // `ReferenceError: Can't find variable: document` in a worker.
          //
          // Pinning Excalidraw's internal shared chunks into their own chunk
          // restores Excalidraw's original worker-safe boundary: the worker
          // imports this DOM-free chunk instead of the app entry. (Path prefix
          // `dist/prod/chunk-` is stable across Excalidraw patch releases even
          // though the trailing hash changes.)
          manualChunks(id: string) {
            // Preserve Excalidraw's own chunk boundaries instead of letting
            // Rollup dedupe its internal chunks into the app entry. Each
            // `dist/prod/chunk-XXXX.js` becomes its own output chunk, so the
            // worker-reachable chunks (chunk-EIO257PC -> chunk-SRAX5OIU) stay
            // isolated from both the app entry AND from Excalidraw's
            // main-thread-only chunks (which do unguarded top-level `window`
            // access). Merging them all into one chunk would drag main-thread
            // code into the worker graph and re-introduce the crash.
            const match = id.match(
              /@excalidraw\/excalidraw\/dist\/prod\/(chunk-[A-Za-z0-9_]+)\.js/,
            );
            if (match) {
              return `excalidraw-${match[1]}`;
            }
            return undefined;
          },
        },
      },
    },
    define: {
      ...processEnvDefines,
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
      'import.meta.env.VITE_APP_BUILD_LABEL': JSON.stringify(buildLabel),
      __BUILD_HASH__: JSON.stringify(buildHash),
      __APP_BUILD_VERSION__: JSON.stringify(buildVersion),
    },
    optimizeDeps: {
      esbuildOptions: {
        define: processEnvDefines,
        target: "es2022",
      },
    },
    server: {
      proxy: {
        "/api": {
          target: devBackendTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
        "/socket.io": {
          target: devBackendTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
