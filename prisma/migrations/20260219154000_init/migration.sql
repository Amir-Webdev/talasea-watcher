-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Profile" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "cashIrr" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "goldGrams" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgBuyPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "buyFeePct" DOUBLE PRECISION NOT NULL DEFAULT 0.003,
    "sellFeePct" DOUBLE PRECISION NOT NULL DEFAULT 0.003,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngineSetting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "pollIntervalMs" INTEGER NOT NULL DEFAULT 60000,
    "predictionHorizonMin" DOUBLE PRECISION NOT NULL DEFAULT 30,
    "freshnessMaxMin" DOUBLE PRECISION NOT NULL DEFAULT 180,
    "buyThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
    "sellThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.4,
    "minConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "actionCooldownMin" DOUBLE PRECISION NOT NULL DEFAULT 8,
    "historyRetentionHours" DOUBLE PRECISION NOT NULL DEFAULT 720,
    "maxInMemoryPoints" INTEGER NOT NULL DEFAULT 50000,
    "requestTimeoutMs" INTEGER NOT NULL DEFAULT 15000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngineSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Snapshot" (
    "id" BIGSERIAL NOT NULL,
    "t" TIMESTAMP(3) NOT NULL,
    "goldPrice" DOUBLE PRECISION NOT NULL,
    "rawPrice" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" BIGSERIAL NOT NULL,
    "t" TIMESTAMP(3) NOT NULL,
    "horizonMin" DOUBLE PRECISION NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "pUp" DOUBLE PRECISION NOT NULL,
    "pDown" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expectedPrice" DOUBLE PRECISION NOT NULL,
    "buyEdgePct" DOUBLE PRECISION,
    "sellEdgePct" DOUBLE PRECISION,
    "score" DOUBLE PRECISION NOT NULL,
    "stopZones" JSONB NOT NULL,
    "portfolio" JSONB NOT NULL,
    "inputs" JSONB NOT NULL,
    "snapshotId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Snapshot_t_idx" ON "Snapshot"("t");

-- CreateIndex
CREATE INDEX "Signal_t_idx" ON "Signal"("t");

-- CreateIndex
CREATE INDEX "Signal_snapshotId_idx" ON "Signal"("snapshotId");

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "Snapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

