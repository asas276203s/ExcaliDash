import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { appVersionMiddleware, getAppVersion } from "./app-version";

const withEnv = (
  key: string,
  value: string | undefined,
  fn: () => void,
): void => {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
};

describe("getAppVersion", () => {
  beforeEach(() => {
    delete process.env.ZEABUR_GIT_COMMIT_SHA;
    delete process.env.BUILD_HASH;
  });

  it("prefers ZEABUR_GIT_COMMIT_SHA", () => {
    withEnv("ZEABUR_GIT_COMMIT_SHA", "abc123", () => {
      withEnv("BUILD_HASH", "should-be-ignored", () => {
        expect(getAppVersion()).toBe("abc123");
      });
    });
  });

  it("falls back to BUILD_HASH", () => {
    withEnv("BUILD_HASH", "explicit", () => {
      expect(getAppVersion()).toBe("explicit");
    });
  });

  it("returns 'dev' when nothing is set", () => {
    expect(getAppVersion()).toBe("dev");
  });

  it("trims whitespace", () => {
    withEnv("BUILD_HASH", "  spaced  ", () => {
      expect(getAppVersion()).toBe("spaced");
    });
  });
});

describe("appVersionMiddleware", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("sets X-App-Version on every response", async () => {
    process.env.ZEABUR_GIT_COMMIT_SHA = "sha-42";
    const app = express();
    app.use(appVersionMiddleware());
    app.get("/", (_req, res) => res.status(200).json({ ok: true }));
    app.get("/error", (_req, res) => res.status(500).json({ ok: false }));

    const ok = await request(app).get("/");
    expect(ok.headers["x-app-version"]).toBe("sha-42");

    const err = await request(app).get("/error");
    expect(err.headers["x-app-version"]).toBe("sha-42");
  });

  it("captures the version at middleware construction time", async () => {
    process.env.BUILD_HASH = "build-99";
    const app = express();
    app.use(appVersionMiddleware());
    app.get("/", (_req, res) => res.status(200).json({ ok: true }));

    // Env changes after construction should NOT retroactively change the
    // advertised header — one deploy, one version.
    process.env.BUILD_HASH = "build-999";
    const res = await request(app).get("/");
    expect(res.headers["x-app-version"]).toBe("build-99");
  });
});
