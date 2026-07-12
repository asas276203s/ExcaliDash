import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCoreRoutes, REFRESH_ROTATION_GRACE_MS } from "./coreRoutes";

const JWT_SECRET = "test-secret";
const USER_ID = "user-1";
const USER_EMAIL = "user1@example.com";

const signRefreshToken = (): string =>
  jwt.sign({ userId: USER_ID, email: USER_EMAIL, type: "refresh" }, JWT_SECRET, {
    expiresIn: "7d",
  });

type StoredTokenRow = {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  revoked: boolean;
  rotatedAt: Date | null;
};

const futureDate = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

const buildApp = (options: {
  storedToken: StoredTokenRow | null;
  updateManyCount?: number;
  /** Row returned by the post-race re-read (tx.refreshToken.findUnique). */
  reReadToken?: StoredTokenRow | null;
  /** Simulate optionalAuth attaching a signed-in user (for /logout). */
  logoutUser?: { id: string } | null;
}) => {
  const router = express.Router();

  const refreshTokenModel = {
    findFirst: vi.fn().mockResolvedValue(options.storedToken),
    findUnique: vi.fn().mockResolvedValue(options.reReadToken ?? null),
    updateMany: vi.fn().mockResolvedValue({ count: options.updateManyCount ?? 1 }),
    create: vi.fn().mockResolvedValue({}),
  };

  const prisma = {
    user: {
      count: vi.fn().mockResolvedValue(1),
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: USER_ID, email: USER_EMAIL, isActive: true }),
      create: vi.fn(),
    },
    refreshToken: refreshTokenModel,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ refreshToken: refreshTokenModel }),
    ),
  } as any;

  const setAuthCookies = vi.fn();
  const setAccessTokenCookie = vi.fn();

  registerCoreRoutes({
    router,
    prisma,
    requireAuth: ((_req: any, _res: any, next: any) => next()) as any,
    optionalAuth: ((req: any, _res: any, next: any) => {
      if (options.logoutUser) req.user = options.logoutUser;
      next();
    }) as any,
    loginAttemptRateLimiter: ((_req: any, _res: any, next: any) => next()) as any,
    ensureAuthEnabled: vi.fn().mockResolvedValue(true),
    ensureSystemConfig: vi.fn().mockResolvedValue({
      id: "default",
      authEnabled: true,
      authOnboardingCompleted: true,
      registrationEnabled: true,
      oidcJitProvisioningEnabled: null,
    }),
    findUserByIdentifier: vi.fn(),
    sanitizeText: (input: unknown) => String(input ?? "").trim(),
    requireCsrf: vi.fn().mockReturnValue(true),
    isJwtPayload: ((decoded: any) =>
      Boolean(decoded && typeof decoded.userId === "string")) as any,
    config: {
      authMode: "local",
      jwtSecret: JWT_SECRET,
      jwtAccessExpiresIn: "15m",
      enableRefreshTokenRotation: true,
      enableAuditLogging: false,
      oidc: {
        enabled: false,
        enforced: false,
        providerName: "Test OIDC",
        jitProvisioning: false,
      },
      bootstrapSetupCodeTtlMs: 900000,
      bootstrapSetupCodeMaxAttempts: 5,
      passwordPolicy: {
        minLength: 8,
        maxLength: 128,
        requireUppercase: false,
        requireLowercase: false,
        requireNumber: false,
        requireSymbol: false,
      },
    } as any,
    generateTokens: vi.fn().mockReturnValue({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
    }),
    getRefreshTokenExpiresAt: vi.fn().mockReturnValue(futureDate()),
    isMissingRefreshTokenTableError: vi.fn().mockReturnValue(false),
    bootstrapUserId: "bootstrap-user",
    defaultSystemConfigId: "default",
    clearAuthEnabledCache: vi.fn(),
    setAuthCookies,
    setAccessTokenCookie,
    clearAuthCookies: vi.fn(),
    readRefreshTokenFromRequest: vi.fn().mockReturnValue(signRefreshToken()),
  });

  const app = express();
  app.use(express.json());
  app.use(router);
  return { app, refreshTokenModel, setAuthCookies, setAccessTokenCookie };
};

const activeRow = (): StoredTokenRow => ({
  id: "token-row-1",
  userId: USER_ID,
  token: "hashed",
  expiresAt: futureDate(),
  revoked: false,
  rotatedAt: null,
});

describe("POST /refresh rotation grace window", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rotates normally and stamps rotatedAt on the revoked token", async () => {
    const { app, refreshTokenModel, setAuthCookies, setAccessTokenCookie } =
      buildApp({ storedToken: activeRow() });

    const response = await request(app).post("/refresh").send({});

    expect(response.status).toBe(200);
    expect(refreshTokenModel.updateMany).toHaveBeenCalledWith({
      where: { id: "token-row-1", revoked: false },
      data: { revoked: true, rotatedAt: expect.any(Date) },
    });
    expect(refreshTokenModel.create).toHaveBeenCalledTimes(1);
    expect(setAuthCookies).toHaveBeenCalledTimes(1);
    expect(setAccessTokenCookie).not.toHaveBeenCalled();
  });

  it("grants grace to a token rotated moments ago: 200, new access cookie, no re-rotation", async () => {
    const rotatedRecently: StoredTokenRow = {
      ...activeRow(),
      revoked: true,
      rotatedAt: new Date(Date.now() - 10_000),
    };
    const { app, refreshTokenModel, setAuthCookies, setAccessTokenCookie } =
      buildApp({ storedToken: rotatedRecently });

    const response = await request(app).post("/refresh").send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    // Grace must NOT rotate again nor touch the refresh cookie.
    expect(refreshTokenModel.updateMany).not.toHaveBeenCalled();
    expect(refreshTokenModel.create).not.toHaveBeenCalled();
    expect(setAuthCookies).not.toHaveBeenCalled();
    expect(setAccessTokenCookie).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "new-access-token",
    );
  });

  it("rejects a token rotated outside the grace window", async () => {
    const rotatedTooLongAgo: StoredTokenRow = {
      ...activeRow(),
      revoked: true,
      rotatedAt: new Date(Date.now() - REFRESH_ROTATION_GRACE_MS - 1_000),
    };
    const { app, setAccessTokenCookie } = buildApp({
      storedToken: rotatedTooLongAgo,
    });

    const response = await request(app).post("/refresh").send({});

    expect(response.status).toBe(401);
    expect(setAccessTokenCookie).not.toHaveBeenCalled();
  });

  it("rejects a logout-revoked token immediately (rotatedAt cleared => no grace)", async () => {
    const logoutRevoked: StoredTokenRow = {
      ...activeRow(),
      revoked: true,
      rotatedAt: null,
    };
    const { app, setAccessTokenCookie } = buildApp({ storedToken: logoutRevoked });

    const response = await request(app).post("/refresh").send({});

    expect(response.status).toBe(401);
    expect(setAccessTokenCookie).not.toHaveBeenCalled();
  });

  it("grants grace when losing the in-transaction race to a concurrent rotation", async () => {
    const { app, refreshTokenModel, setAuthCookies, setAccessTokenCookie } =
      buildApp({
        storedToken: activeRow(),
        updateManyCount: 0,
        reReadToken: {
          ...activeRow(),
          revoked: true,
          rotatedAt: new Date(),
        },
      });

    const response = await request(app).post("/refresh").send({});

    expect(response.status).toBe(200);
    expect(refreshTokenModel.create).not.toHaveBeenCalled();
    expect(setAuthCookies).not.toHaveBeenCalled();
    expect(setAccessTokenCookie).toHaveBeenCalledTimes(1);
  });

  it("rejects when losing the in-transaction race to a concurrent logout revoke", async () => {
    const { app, setAccessTokenCookie } = buildApp({
      storedToken: activeRow(),
      updateManyCount: 0,
      reReadToken: { ...activeRow(), revoked: true, rotatedAt: null },
    });

    const response = await request(app).post("/refresh").send({});

    expect(response.status).toBe(401);
    expect(setAccessTokenCookie).not.toHaveBeenCalled();
  });

  it("rejects an expired-but-graced token (grace never outlives the token's own expiry)", async () => {
    const expiredGrace: StoredTokenRow = {
      ...activeRow(),
      revoked: true,
      rotatedAt: new Date(Date.now() - 5_000),
      expiresAt: new Date(Date.now() - 1_000),
    };
    const { app } = buildApp({ storedToken: expiredGrace });

    const response = await request(app).post("/refresh").send({});

    expect(response.status).toBe(401);
  });
});

describe("POST /logout revocation clears rotation grace", () => {
  it("revokes ALL user tokens and nulls rotatedAt so no token retains grace", async () => {
    const { app, refreshTokenModel } = buildApp({
      storedToken: null,
      logoutUser: { id: USER_ID },
    });

    const response = await request(app).post("/logout").send({});

    expect(response.status).toBe(200);
    expect(refreshTokenModel.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: { revoked: true, rotatedAt: null },
    });
  });
});
