-- CreateTable
CREATE TABLE "DiagnosticReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL DEFAULT 'client',
    "sessionId" TEXT,
    "drawingId" TEXT,
    "appVersion" TEXT,
    "userId" TEXT,
    "userAgent" TEXT,
    "entries" TEXT NOT NULL,
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ServerLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "level" TEXT NOT NULL DEFAULT 'info',
    "type" TEXT NOT NULL,
    "sessionId" TEXT,
    "drawingId" TEXT,
    "requestId" TEXT,
    "route" TEXT,
    "method" TEXT,
    "status" INTEGER,
    "durationMs" INTEGER,
    "message" TEXT,
    "payload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "DiagnosticReport_createdAt_idx" ON "DiagnosticReport"("createdAt");

-- CreateIndex
CREATE INDEX "DiagnosticReport_source_createdAt_idx" ON "DiagnosticReport"("source", "createdAt");

-- CreateIndex
CREATE INDEX "DiagnosticReport_sessionId_idx" ON "DiagnosticReport"("sessionId");

-- CreateIndex
CREATE INDEX "DiagnosticReport_drawingId_idx" ON "DiagnosticReport"("drawingId");

-- CreateIndex
CREATE INDEX "ServerLog_createdAt_idx" ON "ServerLog"("createdAt");

-- CreateIndex
CREATE INDEX "ServerLog_type_createdAt_idx" ON "ServerLog"("type", "createdAt");

-- CreateIndex
CREATE INDEX "ServerLog_sessionId_idx" ON "ServerLog"("sessionId");

-- CreateIndex
CREATE INDEX "ServerLog_drawingId_idx" ON "ServerLog"("drawingId");
