-- Row-safe: nullable column, no backfill required. Existing revoked tokens keep
-- rotatedAt = NULL, which means "no rotation grace" (correct for historical rows).
ALTER TABLE "RefreshToken" ADD COLUMN "rotatedAt" TIMESTAMP(3);
