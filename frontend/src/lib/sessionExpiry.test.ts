import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeReturnTo,
  notifySessionExpired,
  onSessionExpired,
} from "./sessionExpiry";

const setLocation = (pathname: string, search = "", hash = "") => {
  window.history.replaceState({}, "", `${pathname}${search}${hash}`);
};

describe("computeReturnTo", () => {
  beforeEach(() => setLocation("/"));

  it("prefers an explicit same-origin path", () => {
    expect(computeReturnTo("/editor/abc?x=1")).toBe("/editor/abc?x=1");
  });

  it("falls back to the current location when no explicit path is given", () => {
    setLocation("/editor/xyz", "?a=1", "#h");
    expect(computeReturnTo()).toBe("/editor/xyz?a=1#h");
  });

  it("never returns to an auth screen (would look like a no-op login)", () => {
    expect(computeReturnTo("/login?returnTo=/x")).toBe("/");
    expect(computeReturnTo("/register")).toBe("/");
    expect(computeReturnTo("/reset-password")).toBe("/");
    expect(computeReturnTo("/auth-setup")).toBe("/");
  });

  it("rejects off-site / non-path candidates", () => {
    expect(computeReturnTo("https://evil.example.com")).toBe("/");
    expect(computeReturnTo("javascript:alert(1)")).toBe("/");
    // A non-path explicit value falls through to the (safe) current location.
    setLocation("/dashboard");
    expect(computeReturnTo("not-a-path")).toBe("/dashboard");
  });
});

describe("notifySessionExpired", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false when nobody is subscribed (caller must hard-nav)", () => {
    expect(notifySessionExpired("/editor/1")).toBe(false);
  });

  it("delivers a sanitized returnTo to subscribers and returns true", () => {
    const received: string[] = [];
    const unsubscribe = onSessionExpired((r) => received.push(r));
    try {
      expect(notifySessionExpired("/editor/1?tab=2")).toBe(true);
      expect(received).toEqual(["/editor/1?tab=2"]);
    } finally {
      unsubscribe();
    }
    // After unsubscribe there are no handlers again.
    expect(notifySessionExpired("/editor/2")).toBe(false);
  });

  it("isolates a throwing subscriber so recovery still fans out", () => {
    const good = vi.fn();
    const off1 = onSessionExpired(() => {
      throw new Error("boom");
    });
    const off2 = onSessionExpired(good);
    try {
      expect(() => notifySessionExpired("/editor/3")).not.toThrow();
      expect(good).toHaveBeenCalledWith("/editor/3");
    } finally {
      off1();
      off2();
    }
  });
});
