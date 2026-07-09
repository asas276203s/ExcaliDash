/**
 * Injected by Vite (see `vite.config.ts` — `define.__BUILD_HASH__`).
 * Values:
 *  - Zeabur runtime → the deploy's git commit SHA.
 *  - Local dev / test → the literal string "dev".
 */
declare const __BUILD_HASH__: string;

/**
 * The frontend bundle's own build version, injected by Vite
 * (see `vite.config.ts` — `define.__APP_BUILD_VERSION__`). The same value is
 * written to `dist/version.json`; a running tab compares the two to detect a
 * newer frontend deploy. Values:
 *  - git checkout      → git short SHA
 *  - CI / Zeabur build → deploy commit SHA (or `build-<timestamp>` fallback)
 *  - dev / test        → git short SHA locally; `undefined` under vitest.
 */
declare const __APP_BUILD_VERSION__: string;
