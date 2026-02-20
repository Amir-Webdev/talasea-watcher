import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";

type Action = "BUY" | "SELL" | "HOLD";

type Settings = {
  pollIntervalMs: number;
  predictionHorizonMin: number;
  freshnessMaxMin: number;
  buyThreshold: number;
  sellThreshold: number;
  minConfidence: number;
  actionCooldownMin: number;
  historyRetentionHours: number;
  maxInMemoryPoints: number;
  requestTimeoutMs: number;
};

type Profile = {
  cashIrr: number;
  goldGrams: number;
  avgBuyPrice: number;
  buyFeePct: number;
  sellFeePct: number;
};

type Field = {
  value: number | null;
  ts: number | null;
  ageMin: number | null;
  fresh: boolean;
  unitAdjusted?: boolean;
};

type Snapshot = {
  t: number;
  goldPrice: number;
  rawPrice: string;
  fields: Record<string, Field>;
};

type Signal = {
  score: number;
  pUp: number;
  confidence: number;
  coverage: number;
  freshness: number;
  freshFields: number;
  totalFields: number;
  price: number;
  timestamp: number;
  inputs: Record<string, number | null>;
};

type Zones = {
  rangePct: number;
  driftPct: number;
  expectedStop: number;
  upLow: number;
  upHigh: number;
  downLow: number;
  downHigh: number;
};

type Decision = {
  action: Action;
  reason: string;
  expectedPrice: number;
  buyEdgePct: number | null;
  sellEdgePct: number | null;
};

type PortfolioStats = Profile & {
  basisGross: number;
  basisWithBuyFee: number;
  goldMarkValue: number;
  goldLiquidationValue: number;
  portfolioMarkValue: number;
  portfolioLiquidationValue: number;
  netPnlAfterFees: number;
  netPnlPct: number | null;
  breakEvenSellPrice: number | null;
  affordableGrams: number;
  costPerGramBuy: number;
  proceedsPerGramSell: number;
};

type Metrics = { total: number; correct: number; brierSum: number };

type PublicState = {
  status: "idle" | "running" | "error";
  updatedAt: number;
  lastFetchAt: number | null;
  nextFetchAt: number | null;
  lastError: string | null;
  settings: Settings;
  profile: Profile;
  portfolioStats: PortfolioStats | null;
  signal: Signal | null;
  decision: Decision;
  zones: Zones | null;
  metrics: Metrics;
  historyPoints: number;
  priceHistory: Array<{ t: number; p: number }>;
  logs: string[];
  errors: string[];
};

const TGJU_URL =
  "https://call4.tgju.org/ajax.json?rev=4onobYe9NtlQDpR4lIpf5ZfBGO8uT37Hj0vJgT8iW7AqvM5BjisvF4BobKoT";
const TALASEA_URL = "https://api.talasea.ir/api/market/getGoldPrice";

const TALASEA_HEADERS = {
  accept: "application/json, text/plain, */*",
  "accept-encoding": "gzip, deflate, br, zstd",
  "accept-language": "en-US,en;q=0.9",
  origin: "https://talasea.ir",
  platform: "webClient",
  priority: "u=1, i",
  referer: "https://talasea.ir/",
  "sec-ch-ua":
    '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-site",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
} as const;

const TGJU_HEADERS = {
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  origin: "https://www.tgju.org",
  pragma: "no-cache",
  priority: "u=1, i",
  referer: "https://www.tgju.org/",
  "sec-ch-ua":
    '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-site",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
} as const;

const FEATURE_KEYS = [
  "price_dollar_rl",
  "ons",
  "tether_gold_xaut",
  "silver",
  "ratio_sp500",
  "ratio_silver",
  "ratio_xau",
  "ratio_crudeoil",
  "tgju_gold_irg18",
  "tgju_gold_irg18_buy",
  "usdt-irr",
] as const;

const TGJU_RIAL_TO_TOMAN_KEYS = new Set<(typeof FEATURE_KEYS)[number]>([
  "price_dollar_rl",
  "silver",
  "tgju_gold_irg18",
  "tgju_gold_irg18_buy",
]);

const RIAL_TO_TOMAN_DIVISOR = 10;
const TALASEA_TO_TOMAN_MULTIPLIER = 1_000;

const MAX_LOG_LINES = 40;
const CHART_POINTS = 300;
const SINGLETON_ID = 1;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envInt(name: string, fallback: number): number {
  return Math.floor(envNumber(name, fallback));
}

const RETENTION_SWEEP_INTERVAL_MS = envInt(
  "RETENTION_SWEEP_INTERVAL_MS",
  15 * 60_000,
);
const prisma = new PrismaClient();

function parseNumber(input: unknown): number | null {
  if (input == null) return null;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  const cleaned = String(input)
    .trim()
    .replace(/[^\d.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeTalaseaPriceToToman(price: number | null): number | null {
  if (!Number.isFinite(price ?? NaN)) return null;
  return (price as number) * TALASEA_TO_TOMAN_MULTIPLIER;
}

function normalizeTgjuFieldValueToToman(
  key: (typeof FEATURE_KEYS)[number],
  value: number | null,
  alreadyAdjusted: boolean,
): number | null {
  if (!Number.isFinite(value ?? NaN)) return null;
  if (!TGJU_RIAL_TO_TOMAN_KEYS.has(key)) return value as number;
  return alreadyAdjusted
    ? (value as number)
    : (value as number) / RIAL_TO_TOMAN_DIVISOR;
}

function parseTimestampMs(input: unknown): number | null {
  if (input instanceof Date) {
    const n = input.getTime();
    return Number.isFinite(n) ? n : null;
  }
  if (typeof input === "bigint") {
    const n = Number(input);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  if (!input) return null;
  const normalized = String(input).replace(" ", "T");
  const local = Date.parse(normalized);
  if (!Number.isNaN(local)) return local;
  const utc = Date.parse(`${normalized}Z`);
  return Number.isNaN(utc) ? null : utc;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function tanhNorm(v: number | null, scale: number): number {
  if (!Number.isFinite(v ?? NaN)) return 0;
  return Math.tanh((v as number) / Math.max(Math.abs(scale), 1e-9));
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((s, x) => s + x, 0) / values.length;
}

function stdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  if (m == null) return null;
  const variance =
    values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

function pctChange(
  current: number | null,
  previous: number | null,
): number | null {
  if (
    !Number.isFinite(current ?? NaN) ||
    !Number.isFinite(previous ?? NaN) ||
    !previous
  ) {
    return null;
  }
  return ((current as number) - previous) / Math.abs(previous);
}

function pushBounded<T>(arr: T[], item: T, max: number): void {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function toDbProfile(profile: Profile): Omit<Profile, never> {
  return {
    cashIrr: profile.cashIrr,
    goldGrams: profile.goldGrams,
    avgBuyPrice: profile.avgBuyPrice,
    buyFeePct: profile.buyFeePct,
    sellFeePct: profile.sellFeePct,
  };
}

function toDbSettings(settings: Settings): Omit<Settings, never> {
  return {
    pollIntervalMs: settings.pollIntervalMs,
    predictionHorizonMin: settings.predictionHorizonMin,
    freshnessMaxMin: settings.freshnessMaxMin,
    buyThreshold: settings.buyThreshold,
    sellThreshold: settings.sellThreshold,
    minConfidence: settings.minConfidence,
    actionCooldownMin: settings.actionCooldownMin,
    historyRetentionHours: settings.historyRetentionHours,
    maxInMemoryPoints: settings.maxInMemoryPoints,
    requestTimeoutMs: settings.requestTimeoutMs,
  };
}
class Engine {
  private settings: Settings = {
    pollIntervalMs: envInt("POLL_INTERVAL_MS", 60_000),
    predictionHorizonMin: envNumber("PREDICTION_HORIZON_MIN", 30),
    freshnessMaxMin: envNumber("FRESHNESS_MAX_MIN", 180),
    buyThreshold: envNumber("BUY_THRESHOLD", 0.6),
    sellThreshold: envNumber("SELL_THRESHOLD", 0.4),
    minConfidence: envNumber("MIN_CONFIDENCE", 0.2),
    actionCooldownMin: envNumber("ACTION_COOLDOWN_MIN", 8),
    historyRetentionHours: envNumber("HISTORY_RETENTION_HOURS", 24 * 30),
    maxInMemoryPoints: envInt("MAX_IN_MEMORY_POINTS", 50_000),
    requestTimeoutMs: envInt("REQUEST_TIMEOUT_MS", 15_000),
  };

  private profile: Profile = {
    cashIrr: envNumber("CASH_IRR", 0),
    goldGrams: envNumber("GOLD_GRAMS", 0),
    avgBuyPrice: envNumber("AVG_BUY_PRICE", 0),
    buyFeePct: envNumber("BUY_FEE_PCT", 0.003),
    sellFeePct: envNumber("SELL_FEE_PCT", 0.003),
  };

  private history: Snapshot[] = [];
  private pendingPredictions: Array<{
    t: number;
    basePrice: number;
    pUp: number;
  }> = [];
  private metrics: Metrics = { total: 0, correct: 0, brierSum: 0 };
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private initialized = false;
  private lastRetentionSweepAt = 0;
  private eventSeq = 0;
  private listeners = new Set<(state: PublicState) => void>();

  private state: PublicState = {
    status: "idle",
    updatedAt: Date.now(),
    lastFetchAt: null,
    nextFetchAt: null,
    lastError: null,
    settings: { ...this.settings },
    profile: { ...this.profile },
    portfolioStats: null,
    signal: null,
    decision: {
      action: "HOLD",
      reason: "waiting for first fetch",
      expectedPrice: 0,
      buyEdgePct: null,
      sellEdgePct: null,
    },
    zones: null,
    metrics: { ...this.metrics },
    historyPoints: 0,
    priceHistory: [],
    logs: [],
    errors: [],
  };

  constructor() {}

  public async start(): Promise<void> {
    if (!this.initialized) {
      await this.initializeFromDatabase();
      this.initialized = true;
    }
    await this.runTickSafely();
    this.timer = setInterval(
      () => void this.runTickSafely(),
      this.settings.pollIntervalMs,
    );
    this.state.status = "running";
    this.publish();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state.status = "idle";
    this.publish();
  }

  public async close(): Promise<void> {
    await prisma.$disconnect();
  }

  public subscribe(listener: (state: PublicState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  public getState(): PublicState {
    return JSON.parse(JSON.stringify(this.state)) as PublicState;
  }

  public getProfile(): Profile {
    return { ...this.profile };
  }

  public getSettings(): Settings {
    return { ...this.settings };
  }

  public async updateProfile(patch: Partial<Profile>): Promise<Profile> {
    this.profile = this.sanitizeProfile({ ...this.profile, ...patch });
    await prisma.profile.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...toDbProfile(this.profile) },
      update: toDbProfile(this.profile),
    });
    this.state.profile = { ...this.profile };
    if (this.history.length) {
      this.state.portfolioStats = this.computePortfolioStats(
        this.history[this.history.length - 1].goldPrice,
      );
    }
    this.state.updatedAt = Date.now();
    this.publish();
    return this.getProfile();
  }

  public async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const previousPoll = this.settings.pollIntervalMs;
    this.settings = this.sanitizeSettings({ ...this.settings, ...patch });
    await prisma.engineSetting.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...toDbSettings(this.settings) },
      update: toDbSettings(this.settings),
    });
    this.state.settings = { ...this.settings };
    if (this.timer && previousPoll !== this.settings.pollIntervalMs) {
      clearInterval(this.timer);
      this.timer = setInterval(
        () => void this.runTickSafely(),
        this.settings.pollIntervalMs,
      );
    }
    this.state.updatedAt = Date.now();
    this.publish();
    return this.getSettings();
  }

  public async forceTick(): Promise<void> {
    await this.runTickSafely();
  }

  private sanitizeProfile(p: Partial<Profile>): Profile {
    return {
      cashIrr: Math.max(0, Number(p.cashIrr ?? 0) || 0),
      goldGrams: Math.max(0, Number(p.goldGrams ?? 0) || 0),
      avgBuyPrice: Math.max(0, Number(p.avgBuyPrice ?? 0) || 0),
      buyFeePct: clamp(Math.max(0, Number(p.buyFeePct ?? 0) || 0), 0, 0.2),
      sellFeePct: clamp(Math.max(0, Number(p.sellFeePct ?? 0) || 0), 0, 0.2),
    };
  }

  private sanitizeSettings(s: Settings): Settings {
    const out = { ...s };
    out.pollIntervalMs = Math.round(
      clamp(out.pollIntervalMs, 10_000, 3_600_000),
    );
    out.predictionHorizonMin = clamp(out.predictionHorizonMin, 5, 1_440);
    out.freshnessMaxMin = clamp(out.freshnessMaxMin, 15, 1_440);
    out.buyThreshold = clamp(out.buyThreshold, 0.01, 0.99);
    out.sellThreshold = clamp(out.sellThreshold, 0.01, 0.99);
    out.minConfidence = clamp(out.minConfidence, 0, 1);
    out.actionCooldownMin = clamp(out.actionCooldownMin, 0, 360);
    out.historyRetentionHours = clamp(out.historyRetentionHours, 24, 24 * 365);
    out.maxInMemoryPoints = Math.round(
      clamp(out.maxInMemoryPoints, 1_000, 1_000_000),
    );
    out.requestTimeoutMs = Math.round(
      clamp(out.requestTimeoutMs, 3_000, 60_000),
    );
    if (out.buyThreshold <= out.sellThreshold) {
      throw new Error("BUY threshold must be higher than SELL threshold");
    }
    return out;
  }

  private publish(): void {
    const snapshot = this.getState();
    for (const fn of this.listeners) fn(snapshot);
  }

  private addLog(msg: string): void {
    pushBounded(this.state.logs, this.formatEventLine(msg), MAX_LOG_LINES);
  }

  private addError(msg: string): void {
    const line = this.formatEventLine(msg);
    pushBounded(this.state.errors, line, MAX_LOG_LINES);
    this.state.lastError = line;
    this.state.status = "error";
  }

  private formatEventLine(msg: string): string {
    const nowMs = Date.now();
    const iso = new Date(nowMs).toISOString();
    this.eventSeq += 1;
    return `[${iso}|${nowMs}|${this.eventSeq}] ${msg}`;
  }
  private async initializeFromDatabase(): Promise<void> {
    try {
      await prisma.$connect();

      const dbSettings = await prisma.engineSetting.upsert({
        where: { id: SINGLETON_ID },
        create: { id: SINGLETON_ID, ...toDbSettings(this.settings) },
        update: {},
      });
      this.settings = this.sanitizeSettings({
        pollIntervalMs: dbSettings.pollIntervalMs,
        predictionHorizonMin: dbSettings.predictionHorizonMin,
        freshnessMaxMin: dbSettings.freshnessMaxMin,
        buyThreshold: dbSettings.buyThreshold,
        sellThreshold: dbSettings.sellThreshold,
        minConfidence: dbSettings.minConfidence,
        actionCooldownMin: dbSettings.actionCooldownMin,
        historyRetentionHours: dbSettings.historyRetentionHours,
        maxInMemoryPoints: dbSettings.maxInMemoryPoints,
        requestTimeoutMs: dbSettings.requestTimeoutMs,
      });
      this.state.settings = { ...this.settings };

      const dbProfile = await prisma.profile.upsert({
        where: { id: SINGLETON_ID },
        create: { id: SINGLETON_ID, ...toDbProfile(this.profile) },
        update: {},
      });
      this.profile = this.sanitizeProfile({
        cashIrr: dbProfile.cashIrr,
        goldGrams: dbProfile.goldGrams,
        avgBuyPrice: dbProfile.avgBuyPrice,
        buyFeePct: dbProfile.buyFeePct,
        sellFeePct: dbProfile.sellFeePct,
      });
      this.state.profile = { ...this.profile };

      const minTs =
        Date.now() - this.settings.historyRetentionHours * 60 * 60 * 1000;
      const rows = await prisma.snapshot.findMany({
        where: { t: { gte: new Date(minTs) } },
        orderBy: { t: "desc" },
        take: this.settings.maxInMemoryPoints,
      });

      this.history = [];
      for (const row of rows.reverse()) {
        const snap = this.normalizeSnapshot({
          t: row.t.getTime(),
          goldPrice: row.goldPrice,
          rawPrice: row.rawPrice,
          fields: row.fields as Record<string, Field>,
        });
        if (snap) this.history.push(snap);
      }

      this.state.historyPoints = this.history.length;
      this.state.priceHistory = this.history
        .slice(-CHART_POINTS)
        .map((s) => ({ t: s.t, p: s.goldPrice }));

      if (this.history.length) {
        this.state.portfolioStats = this.computePortfolioStats(
          this.history[this.history.length - 1].goldPrice,
        );
      }

      await this.trimDatabaseHistory(Date.now());
      this.lastRetentionSweepAt = Date.now();
      this.addLog(`Loaded ${this.history.length} snapshots from PostgreSQL`);
    } catch (err) {
      this.addError(`Database initialization failed: ${errorMessage(err)}`);
      throw err;
    }
  }

  private async trimDatabaseHistory(nowMs: number): Promise<void> {
    const minDate = new Date(
      nowMs - this.settings.historyRetentionHours * 60 * 60 * 1000,
    );
    await Promise.all([
      prisma.signal.deleteMany({ where: { t: { lt: minDate } } }),
      prisma.snapshot.deleteMany({ where: { t: { lt: minDate } } }),
    ]);
  }

  private normalizeSnapshot(raw: Partial<Snapshot>): Snapshot | null {
    const t = parseTimestampMs(raw.t);
    const rawPrice = parseNumber(raw.rawPrice);
    let goldPrice = parseNumber(raw.goldPrice ?? raw.rawPrice);
    if (
      Number.isFinite(goldPrice ?? NaN) &&
      Number.isFinite(rawPrice ?? NaN) &&
      rawPrice
    ) {
      // Legacy rows stored unscaled Talasea price; normalize them to toman here.
      const ratio = (goldPrice as number) / (rawPrice as number);
      if (ratio > 0.99 && ratio < 1.01) {
        goldPrice = normalizeTalaseaPriceToToman(goldPrice);
      }
    }
    if (!Number.isFinite(t ?? NaN) || !Number.isFinite(goldPrice ?? NaN))
      return null;

    const fields: Record<string, Field> = {};
    for (const key of FEATURE_KEYS) {
      const v = raw.fields?.[key] as Partial<Field> | undefined;
      const rawValue = parseNumber(v?.value);
      const value = normalizeTgjuFieldValueToToman(
        key,
        rawValue,
        Boolean(v?.unitAdjusted),
      );
      const ts = parseTimestampMs(v?.ts);
      const ageMin = Number.isFinite(ts ?? NaN)
        ? ((t as number) - (ts as number)) / 60_000
        : null;
      fields[key] = {
        value,
        ts,
        ageMin,
        fresh:
          value != null &&
          Number.isFinite(ageMin ?? NaN) &&
          (ageMin as number) >= 0 &&
          (ageMin as number) <= this.settings.freshnessMaxMin,
        unitAdjusted: true,
      };
    }

    return {
      t: t as number,
      goldPrice: goldPrice as number,
      rawPrice: String(raw.rawPrice ?? goldPrice),
      fields,
    };
  }

  private trimHistory(nowMs: number): void {
    const minTs = nowMs - this.settings.historyRetentionHours * 60 * 60 * 1000;
    while (this.history.length && this.history[0].t < minTs)
      this.history.shift();
    if (this.history.length > this.settings.maxInMemoryPoints) {
      this.history.splice(
        0,
        this.history.length - this.settings.maxInMemoryPoints,
      );
    }
  }

  private getFieldValue(
    snapshot: Snapshot | null,
    key: (typeof FEATURE_KEYS)[number],
  ): number | null {
    if (!snapshot) return null;
    const field = snapshot.fields[key];
    return field?.fresh ? field.value : null;
  }

  private getSeriesValue(
    snapshot: Snapshot | null,
    key: string,
  ): number | null {
    if (!snapshot) return null;
    if (key === "gold") return snapshot.goldPrice;
    if (key === "tgju_gold") {
      return (
        this.getFieldValue(snapshot, "tgju_gold_irg18") ??
        this.getFieldValue(snapshot, "tgju_gold_irg18_buy")
      );
    }
    if ((FEATURE_KEYS as readonly string[]).includes(key)) {
      return this.getFieldValue(snapshot, key as (typeof FEATURE_KEYS)[number]);
    }
    return null;
  }

  private valueAtOrBefore(field: string, targetTs: number): number | null {
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const snap = this.history[i];
      if (snap.t > targetTs) continue;
      const v = this.getSeriesValue(snap, field);
      if (Number.isFinite(v ?? NaN)) return v;
    }
    return null;
  }

  private valueAtOrAfter(targetTs: number): number | null {
    for (const snap of this.history) {
      if (snap.t < targetTs) continue;
      if (Number.isFinite(snap.goldPrice)) return snap.goldPrice;
    }
    return null;
  }

  private momentum(field: string, lookbackMin: number): number | null {
    const latest = this.history[this.history.length - 1];
    if (!latest) return null;
    return pctChange(
      this.getSeriesValue(latest, field),
      this.valueAtOrBefore(field, latest.t - lookbackMin * 60_000),
    );
  }

  private returnsOver(field: string, lookbackMin: number): number[] {
    const latest = this.history[this.history.length - 1];
    if (!latest) return [];
    const cutoff = latest.t - lookbackMin * 60_000;
    const values: number[] = [];
    for (const snap of this.history) {
      if (snap.t < cutoff) continue;
      const v = this.getSeriesValue(snap, field);
      if (Number.isFinite(v ?? NaN)) values.push(v as number);
    }
    const returns: number[] = [];
    for (let i = 1; i < values.length; i += 1) {
      const r = pctChange(values[i], values[i - 1]);
      if (Number.isFinite(r ?? NaN)) returns.push(r as number);
    }
    return returns;
  }

  private rollingGoldRatioMean(lookbackMin: number): number | null {
    const latest = this.history[this.history.length - 1];
    if (!latest) return null;
    const cutoff = latest.t - lookbackMin * 60_000;
    const ratios: number[] = [];
    for (const snap of this.history) {
      if (snap.t < cutoff) continue;
      const tgju = this.getSeriesValue(snap, "tgju_gold");
      if (!Number.isFinite(tgju ?? NaN) || !tgju) continue;
      ratios.push(snap.goldPrice / (tgju as number));
    }
    return mean(ratios);
  }
  private async fetchJson(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.settings.requestTimeoutMs,
    );
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        throw new Error(
          `${url} -> HTTP ${response.status} ${response.statusText}`,
        );
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchSnapshot(): Promise<Snapshot> {
    const now = Date.now();
    const [tgjuRaw, talaseaRaw] = await Promise.all([
      this.fetchJson(TGJU_URL, {
        method: "GET",
        headers: TGJU_HEADERS,
        cache: "no-store",
      }),
      this.fetchJson(TALASEA_URL, {
        method: "GET",
        headers: TALASEA_HEADERS,
        cache: "no-store",
      }),
    ]);

    const tgju = (tgjuRaw as any).current ?? {};
    const rawTalaseaPrice = parseNumber((talaseaRaw as any).price);
    const price = normalizeTalaseaPriceToToman(rawTalaseaPrice);
    if (!Number.isFinite(price ?? NaN)) {
      throw new Error(
        `Talasea price parse failed: ${(talaseaRaw as any).price}`,
      );
    }

    const fields: Record<string, Field> = {};
    for (const key of FEATURE_KEYS) {
      const rawValue = parseNumber(tgju[key]?.p);
      const value = normalizeTgjuFieldValueToToman(key, rawValue, false);
      const ts = parseTimestampMs(tgju[key]?.ts);
      const ageMin = Number.isFinite(ts ?? NaN)
        ? (now - (ts as number)) / 60_000
        : null;
      fields[key] = {
        value,
        ts,
        ageMin,
        fresh:
          value != null &&
          Number.isFinite(ageMin ?? NaN) &&
          (ageMin as number) >= 0 &&
          (ageMin as number) <= this.settings.freshnessMaxMin,
        unitAdjusted: true,
      };
    }

    return {
      t: now,
      goldPrice: price as number,
      rawPrice: String((talaseaRaw as any).price),
      fields,
    };
  }

  private buildSignal(): Signal {
    const latest = this.history[this.history.length - 1];
    const inputs: Record<string, number | null> = {
      goldMom5: this.momentum("gold", 5),
      goldMom15: this.momentum("gold", 15),
      tgjuGoldMom5: this.momentum("tgju_gold", 5),
      dollarMom5: this.momentum("price_dollar_rl", 5),
      onsMom5: this.momentum("ons", 5),
      xautMom5: this.momentum("tether_gold_xaut", 5),
      silverMom5: this.momentum("silver", 5),
      volatility15: stdDev(this.returnsOver("gold", 15)),
      divergence: null,
    };

    if (!latest) {
      return {
        score: 0,
        pUp: 0.5,
        confidence: 0,
        coverage: 0,
        freshness: 0,
        freshFields: 0,
        totalFields: FEATURE_KEYS.length,
        price: 0,
        timestamp: Date.now(),
        inputs,
      };
    }

    const tgjuNow = this.getSeriesValue(latest, "tgju_gold");
    const ratioMean = this.rollingGoldRatioMean(
      Math.max(120, this.settings.predictionHorizonMin * 4),
    );
    if (
      Number.isFinite(tgjuNow ?? NaN) &&
      tgjuNow &&
      Number.isFinite(ratioMean ?? NaN)
    ) {
      inputs.divergence = pctChange(
        latest.goldPrice / (tgjuNow as number),
        ratioMean,
      );
    }

    const score =
      0.34 * tanhNorm(inputs.goldMom5, 0.0025) +
      0.24 * tanhNorm(inputs.goldMom15, 0.0045) +
      0.1 * tanhNorm(inputs.tgjuGoldMom5, 0.003) +
      0.14 * tanhNorm(inputs.dollarMom5, 0.0025) +
      0.1 * tanhNorm(inputs.onsMom5, 0.002) +
      0.08 * tanhNorm(inputs.xautMom5, 0.002) +
      0.06 * tanhNorm(inputs.silverMom5, 0.0025) +
      0.14 * -tanhNorm(inputs.divergence, 0.0035) +
      -0.22 * tanhNorm(inputs.volatility15, 0.003);

    const pUp = sigmoid(score * 2);
    const used = Object.values(inputs).filter((v) =>
      Number.isFinite(v ?? NaN),
    ).length;
    const coverage = used / Object.keys(inputs).length;
    const freshFields = Object.values(latest.fields).filter(
      (f) => f.fresh,
    ).length;
    const freshness = freshFields / FEATURE_KEYS.length;
    const edge = Math.abs(pUp - 0.5) * 2;
    const confidence = clamp(
      edge * (0.45 + 0.55 * coverage) * (0.5 + 0.5 * freshness),
      0,
      1,
    );

    return {
      score,
      pUp,
      confidence,
      coverage,
      freshness,
      freshFields,
      totalFields: FEATURE_KEYS.length,
      price: latest.goldPrice,
      timestamp: latest.t,
      inputs,
    };
  }

  private estimateZones(signal: Signal): Zones {
    const rets = this.returnsOver(
      "gold",
      Math.max(10, this.settings.predictionHorizonMin),
    );
    const vol = Number.isFinite(stdDev(rets) ?? NaN)
      ? (stdDev(rets) as number)
      : 0.0018;
    const stepMin = Math.max(0.5, this.settings.pollIntervalMs / 60_000);
    const steps = Math.max(1, this.settings.predictionHorizonMin / stepMin);
    const rangePct = clamp(vol * Math.sqrt(steps) * 1.2, 0.001, 0.05);
    const driftPct = (signal.pUp - 0.5) * 2 * rangePct * 1.15;
    const p = signal.price;
    const upLow = p * (1 + Math.max(0, driftPct) + rangePct * 0.3);
    const upHigh = p * (1 + Math.max(0, driftPct) + rangePct * 0.9);
    const downHigh = p * (1 - Math.max(0, -driftPct) - rangePct * 0.3);
    const downLow = p * (1 - Math.max(0, -driftPct) - rangePct * 0.9);

    return {
      rangePct,
      driftPct,
      expectedStop:
        signal.pUp >= 0.5 ? (upLow + upHigh) / 2 : (downLow + downHigh) / 2,
      upLow: Math.max(0, upLow),
      upHigh: Math.max(0, upHigh),
      downLow: Math.max(0, downLow),
      downHigh: Math.max(0, downHigh),
    };
  }
  private computePortfolioStats(price: number): PortfolioStats {
    const p = this.profile;
    const costPerGramBuy = price * (1 + p.buyFeePct);
    const proceedsPerGramSell = price * (1 - p.sellFeePct);
    const basisGross = p.goldGrams * p.avgBuyPrice;
    const basisWithBuyFee = p.goldGrams * p.avgBuyPrice * (1 + p.buyFeePct);
    const goldMarkValue = p.goldGrams * price;
    const goldLiquidationValue = p.goldGrams * proceedsPerGramSell;
    const portfolioMarkValue = p.cashIrr + goldMarkValue;
    const portfolioLiquidationValue = p.cashIrr + goldLiquidationValue;
    const netPnlAfterFees = goldLiquidationValue - basisWithBuyFee;

    return {
      ...p,
      basisGross,
      basisWithBuyFee,
      goldMarkValue,
      goldLiquidationValue,
      portfolioMarkValue,
      portfolioLiquidationValue,
      netPnlAfterFees,
      netPnlPct: basisWithBuyFee > 0 ? netPnlAfterFees / basisWithBuyFee : null,
      breakEvenSellPrice:
        p.avgBuyPrice > 0
          ? (p.avgBuyPrice * (1 + p.buyFeePct)) / (1 - p.sellFeePct)
          : null,
      affordableGrams: costPerGramBuy > 0 ? p.cashIrr / costPerGramBuy : 0,
      costPerGramBuy,
      proceedsPerGramSell,
    };
  }

  private chooseDecision(
    signal: Signal,
    zones: Zones,
    nowMs: number,
  ): Decision {
    let action: Action = "HOLD";
    let reason = "inside neutral zone";

    const expectedPrice = Number.isFinite(zones.expectedStop)
      ? zones.expectedStop
      : signal.price;

    const buyNowCost = signal.price * (1 + this.profile.buyFeePct);
    const sellNowProceeds = signal.price * (1 - this.profile.sellFeePct);
    const expectedSell = expectedPrice * (1 - this.profile.sellFeePct);
    const expectedRebuy = expectedPrice * (1 + this.profile.buyFeePct);
    const buyEdgePct =
      buyNowCost > 0 ? (expectedSell - buyNowCost) / buyNowCost : null;
    const sellEdgePct =
      sellNowProceeds > 0
        ? (sellNowProceeds - expectedRebuy) / sellNowProceeds
        : null;

    if (signal.confidence < this.settings.minConfidence) {
      reason = `confidence below ${(this.settings.minConfidence * 100).toFixed(1)}%`;
    } else if (signal.pUp >= this.settings.buyThreshold) {
      action = "BUY";
      reason = `P(up) >= ${(this.settings.buyThreshold * 100).toFixed(1)}%`;
    } else if (signal.pUp <= this.settings.sellThreshold) {
      action = "SELL";
      reason = `P(up) <= ${(this.settings.sellThreshold * 100).toFixed(1)}%`;
    }

    if (action === "BUY" && this.profile.cashIrr < buyNowCost) {
      action = "HOLD";
      reason = "not enough cash for 1g including fee";
    }
    if (action === "SELL" && this.profile.goldGrams <= 0) {
      action = "HOLD";
      reason = "no gold holdings to sell";
    }
    if (
      action === "BUY" &&
      Number.isFinite(buyEdgePct ?? NaN) &&
      (buyEdgePct as number) <= 0
    ) {
      action = "HOLD";
      reason = "BUY edge does not clear fees";
    }
    if (
      action === "SELL" &&
      Number.isFinite(sellEdgePct ?? NaN) &&
      (sellEdgePct as number) <= 0
    ) {
      action = "HOLD";
      reason = "SELL edge does not clear fees";
    }

    if (action !== "HOLD" && this.state.lastFetchAt) {
      const elapsed = (nowMs - this.state.lastFetchAt) / 60_000;
      if (
        elapsed < this.settings.actionCooldownMin &&
        this.state.decision.action !== "HOLD"
      ) {
        action = "HOLD";
        reason = `cooldown active (${Math.ceil(this.settings.actionCooldownMin - elapsed)}m left)`;
      }
    }

    return { action, reason, expectedPrice, buyEdgePct, sellEdgePct };
  }

  private updateMetrics(): void {
    const horizonMs = this.settings.predictionHorizonMin * 60_000;
    const unresolved: Array<{ t: number; basePrice: number; pUp: number }> = [];

    for (const pred of this.pendingPredictions) {
      const realized = this.valueAtOrAfter(pred.t + horizonMs);
      if (!Number.isFinite(realized ?? NaN)) {
        unresolved.push(pred);
        continue;
      }
      const actualUp = (realized as number) > pred.basePrice ? 1 : 0;
      const predictedUp = pred.pUp >= 0.5 ? 1 : 0;
      const p = clamp(pred.pUp, 0, 1);
      this.metrics.total += 1;
      this.metrics.correct += predictedUp === actualUp ? 1 : 0;
      this.metrics.brierSum += (p - actualUp) ** 2;
    }

    this.pendingPredictions = unresolved;
  }

  private async runTickSafely(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tick();
      this.state.status = "running";
      this.state.lastError = null;
    } catch (err) {
      this.addError(errorMessage(err));
    } finally {
      this.running = false;
      this.state.updatedAt = Date.now();
      this.publish();
    }
  }

  private async tick(): Promise<void> {
    const started = Date.now();
    this.state.lastFetchAt = started;
    this.state.nextFetchAt = started + this.settings.pollIntervalMs;

    const snapshot = await this.fetchSnapshot();
    this.history.push(snapshot);
    this.trimHistory(snapshot.t);
    const createdSnapshot = await prisma.snapshot.create({
      data: {
        t: new Date(snapshot.t),
        goldPrice: snapshot.goldPrice,
        rawPrice: snapshot.rawPrice,
        fields: snapshot.fields as any,
      },
      select: { id: true },
    });

    this.updateMetrics();

    const signal = this.buildSignal();
    const zones = this.estimateZones(signal);
    const decision = this.chooseDecision(signal, zones, snapshot.t);
    const portfolioStats = this.computePortfolioStats(snapshot.goldPrice);

    this.pendingPredictions.push({
      t: snapshot.t,
      basePrice: snapshot.goldPrice,
      pUp: signal.pUp,
    });

    this.state.signal = signal;
    this.state.zones = zones;
    this.state.decision = decision;
    this.state.metrics = { ...this.metrics };
    this.state.profile = { ...this.profile };
    this.state.portfolioStats = portfolioStats;
    this.state.historyPoints = this.history.length;
    this.state.priceHistory = this.history
      .slice(-CHART_POINTS)
      .map((x) => ({ t: x.t, p: x.goldPrice }));

    this.addLog(
      `Price=${snapshot.rawPrice} action=${decision.action} pUp=${(signal.pUp * 100).toFixed(1)}% conf=${(signal.confidence * 100).toFixed(1)}%`,
    );

    await prisma.signal.create({
      data: {
        t: new Date(snapshot.t),
        horizonMin: this.settings.predictionHorizonMin,
        price: snapshot.goldPrice,
        pUp: signal.pUp,
        pDown: 1 - signal.pUp,
        confidence: signal.confidence,
        action: decision.action,
        reason: decision.reason,
        expectedPrice: decision.expectedPrice,
        buyEdgePct: decision.buyEdgePct,
        sellEdgePct: decision.sellEdgePct,
        score: signal.score,
        stopZones: zones as any,
        portfolio: portfolioStats as any,
        inputs: signal.inputs as any,
        snapshotId: createdSnapshot.id,
      },
    });

    if (snapshot.t - this.lastRetentionSweepAt >= RETENTION_SWEEP_INTERVAL_MS) {
      await this.trimDatabaseHistory(snapshot.t);
      this.lastRetentionSweepAt = snapshot.t;
    }
  }
}
const engine = new Engine();
const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "gold-manager-api" });
});

app.get("/api/state", (_req, res) => {
  res.json(engine.getState());
});

app.get("/api/profile", (_req, res) => {
  res.json(engine.getProfile());
});

app.put("/api/profile", async (req, res) => {
  try {
    res.json(await engine.updateProfile(req.body as Partial<Profile>));
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

app.get("/api/settings", (_req, res) => {
  res.json(engine.getSettings());
});

app.put("/api/settings", async (req, res) => {
  try {
    res.json(await engine.updateSettings(req.body as Partial<Settings>));
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

app.post("/api/actions/fetch", async (_req, res) => {
  await engine.forceTick();
  res.json({ ok: true, state: engine.getState() });
});

app.get("/api/events", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const unsubscribe = engine.subscribe((state) => {
    res.write(`data: ${JSON.stringify(state)}\n\n`);
  });

  req.on("close", () => {
    unsubscribe();
    res.end();
  });
});

const port = envInt("API_PORT", 8787);
engine.start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Engine failed:", errorMessage(err));
});

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Gold Manager API listening on http://localhost:${port}`);
});

const shutdown = () => {
  engine.stop();
  server.close(() => {
    void engine.close().finally(() => process.exit(0));
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
