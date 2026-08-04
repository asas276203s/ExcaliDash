import { afterEach, describe, expect, it } from "vitest";
import {
  isTeamSharedMode,
  teamSharedCollectionListWhere,
  teamSharedDrawingAccessClauses,
} from "../teamSharedMode";

const originalValue = process.env.TEAM_SHARED_MODE;

afterEach(() => {
  if (originalValue === undefined) delete process.env.TEAM_SHARED_MODE;
  else process.env.TEAM_SHARED_MODE = originalValue;
});

describe("isTeamSharedMode", () => {
  it("defaults to false when unset (upstream behavior)", () => {
    delete process.env.TEAM_SHARED_MODE;
    expect(isTeamSharedMode()).toBe(false);
  });

  it("is false for falsey-ish values", () => {
    for (const value of ["", "false", "0", "no", "off", " "]) {
      process.env.TEAM_SHARED_MODE = value;
      expect(isTeamSharedMode()).toBe(false);
    }
  });

  it("is true for truthy values, case/space insensitive", () => {
    for (const value of ["true", "TRUE", " True ", "1", "yes", "on"]) {
      process.env.TEAM_SHARED_MODE = value;
      expect(isTeamSharedMode()).toBe(true);
    }
  });
});

describe("team shared query builders", () => {
  it("keeps other users' trash out of the drawing list", () => {
    const clauses = teamSharedDrawingAccessClauses("me", "trash:me");
    expect(clauses).toContainEqual({ collectionId: "trash:me" });
    expect(clauses).toContainEqual({ collectionId: null });
    const catchAll = clauses.find((c) => Array.isArray((c as any).AND));
    expect(catchAll).toBeDefined();
    expect((catchAll as any).AND).toContainEqual({
      NOT: { collectionId: { startsWith: "trash:" } },
    });
  });

  it("keeps other users' trash collections out of the collection list", () => {
    const where = teamSharedCollectionListWhere("me") as any;
    expect(where.OR[0]).toEqual({ userId: "me" });
    expect(where.OR[1].AND).toContainEqual({
      NOT: { id: { startsWith: "trash:" } },
    });
  });
});
