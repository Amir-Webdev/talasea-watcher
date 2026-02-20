import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import notifier from "node-notifier";
import chalk from "chalk";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const TGJU_URL =
  "https://call4.tgju.org/ajax.json?rev=4onobYe9NtlQDpR4lIpf5ZfBGO8uT37Hj0vJgT8iW7AqvM5BjisvF4BobKoT";
const TALASEA_URL = "https://api.talasea.ir/api/market/getGoldPrice";

const TALASEA_HEADERS = {
  accept: "application/json, text/plain, */*",
  "accept-encoding": "gzip, deflate, br, zstd",
  "accept-language": "en-US,en;q=0.9",
  authorization:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY5ODRlNmNlNGZlZTdmNjlhNDUwZjQ1ZiIsInBob25lTnVtYmVyIjoiMDk5MjQ2NDQxMDUiLCJpcCI6Ijc5LjEyNy44My4zNSIsImlhdCI6MTc3MTE0MzAyNywiZXhwIjoxNzcxNzQ3ODI3fQ.94wQ7wFF84WhUuDuIlKL8ThoVYwh3_F6Su_3e4H2t54",
  cookie:
    "_gcl_au=1.1.360961919.1771142929; _ga=GA1.1.1211476574.1771142930; _clck=1ou9ifi%5E2%5Eg3l%5E0%5E2237; __arcsjs=4de43779e8104477326d82abe0b87646; __arcsjsc=arcookie-1771229695-fbccaf73c67cfb2770dbe0dec5fe1f77; _clsk=y7tiax%5E1771143300913%5E7%5E0%5Ev.clarity.ms%2Fcollect; _ga_EMSF7MVVGX=GS2.1.s1771142930$o1$g1$t1771143310$j49$l0$h99764290",
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
};

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
};

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
];

const MAX_LOG_LINES = 12;
const MAX_SPARK_POINTS = 60;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envInt(name, fallback) {
  const n = Math.floor(envNumber(name, fallback));
  return Number.isFinite(n) ? n : fallback;
}

const CONFIG = {
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
  runOnce: process.env.RUN_ONCE === "1",
  dataDir: process.env.DATA_DIR?.trim() || path.join(__dirname, "data"),
  historyFileName:
    process.env.HISTORY_FILE_NAME?.trim() || "gold-manager-history.jsonl",
  signalFileName:
    process.env.SIGNAL_FILE_NAME?.trim() || "gold-manager-signals.jsonl",
  profileFileName:
    process.env.PROFILE_FILE_NAME?.trim() || "gold-manager-profile.json",
};

const DEFAULT_PORTFOLIO = {
  cashIrr: envNumber("CASH_IRR", 0),
  goldGrams: envNumber("GOLD_GRAMS", 0),
  avgBuyPrice: envNumber("AVG_BUY_PRICE", 0),
  buyFeePct: envNumber("BUY_FEE_PCT", 0.003),
  sellFeePct: envNumber("SELL_FEE_PCT", 0.003),
};

const state = {
  history: [],
  pendingPredictions: [],
  metrics: {
    total: 0,
    correct: 0,
    brierSum: 0,
  },
  lastAction: "HOLD",
  lastActionAt: null,
  lastNotifiedAction: null,
  lastFetchAt: null,
  nextFetchAt: null,
  lastSnapshot: null,
  lastSignal: null,
  lastDecision: { action: "HOLD", reason: "waiting for first fetch" },
  lastZones: null,
  errors: [],
  rawLog: [],
  signalLog: [],
  portfolio: {
    ...DEFAULT_PORTFOLIO,
  },
  portfolioStats: null,
  paths: {
    historyFile: "",
    signalFile: "",
    profileFile: "",
  },
};

function parseNumber(input) {
  if (input == null) return null;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  const text = String(input).trim();
  if (!text) return null;
  const cleaned = text.replace(/[^\d.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseTimestampMs(ts) {
  if (typeof ts === "number") return Number.isFinite(ts) ? ts : null;
  if (!ts) return null;
  const normalized = String(ts).replace(" ", "T");
  const localParsed = Date.parse(normalized);
  if (!Number.isNaN(localParsed)) return localParsed;
  const utcParsed = Date.parse(`${normalized}Z`);
  return Number.isNaN(utcParsed) ? null : utcParsed;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sigmoid(x) {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function tanhNorm(value, scale) {
  if (!Number.isFinite(value)) return 0;
  const safeScale = Math.max(Math.abs(scale), 1e-9);
  return Math.tanh(value / safeScale);
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  if (m == null) return null;
  const variance =
    values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

function pctChange(current, previous) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous === 0
  ) {
    return null;
  }
  return (current - previous) / Math.abs(previous);
}

function formatNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return "--";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatPct(value, digits = 2) {
  if (!Number.isFinite(value)) return "--";
  return `${(value * 100).toFixed(digits)}%`;
}

function formatSignedPct(value, digits = 2) {
  if (!Number.isFinite(value)) return "--";
  const pct = value * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(digits)}%`;
}

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H");
}

function msToHuman(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function box(lines, width = 100) {
  const top = "+" + "-".repeat(width - 2) + "+";
  const bot = "+" + "-".repeat(width - 2) + "+";
  const body = lines.map((l) => {
    const plain = stripAnsi(l);
    const padded = l + " ".repeat(Math.max(0, width - 2 - plain.length));
    return "|" + padded + "|";
  });
  return [top, ...body, bot].join("\n");
}

function sparkline(values, width = 48) {
  const blocks = "..--==++##";
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2)
    return "-".repeat(Math.max(1, Math.min(width, v.length || 1)));

  const sampled = [];
  if (v.length <= width) {
    sampled.push(...v);
  } else {
    const step = v.length / width;
    for (let i = 0; i < width; i += 1) {
      sampled.push(v[Math.floor(i * step)]);
    }
  }

  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const range = max - min || 1;

  return sampled
    .map((x) => {
      const idx = Math.max(
        0,
        Math.min(
          blocks.length - 1,
          Math.floor(((x - min) / range) * (blocks.length - 1)),
        ),
      );
      return blocks[idx];
    })
    .join("");
}

function directionArrow(curr, prev) {
  if (!Number.isFinite(curr) || !Number.isFinite(prev)) return "-";
  if (curr > prev) return chalk.green("^");
  if (curr < prev) return chalk.red("v");
  return chalk.gray("-");
}

function pushBounded(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

function addError(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  pushBounded(state.errors, line, MAX_LOG_LINES);
}

function notifyDecision(decision, signal, zones, priceRaw) {
  if (decision.action === "HOLD") return;
  const edgeText =
    decision.action === "BUY"
      ? `edge ${formatPct(decision.buyEdgePct, 2)}`
      : `edge ${formatPct(decision.sellEdgePct, 2)}`;
  notifier.notify({
    title: `Gold Manager ${decision.action} Signal`,
    message: `Price ${priceRaw} | P(up) ${formatPct(signal.pUp, 1)} | ${edgeText} | Stop ${formatNumber(zones.expectedStop, 0)}`,
    sound: true,
    wait: false,
  });
}

function sanitizePortfolio(input) {
  return {
    cashIrr: Math.max(0, Number(input?.cashIrr) || 0),
    goldGrams: Math.max(0, Number(input?.goldGrams) || 0),
    avgBuyPrice: Math.max(0, Number(input?.avgBuyPrice) || 0),
    buyFeePct: clamp(Math.max(0, Number(input?.buyFeePct) || 0), 0, 0.2),
    sellFeePct: clamp(Math.max(0, Number(input?.sellFeePct) || 0), 0, 0.2),
  };
}

function computePortfolioStats(price) {
  if (!Number.isFinite(price)) return null;
  const p = sanitizePortfolio(state.portfolio);
  const costPerGramBuy = price * (1 + p.buyFeePct);
  const proceedsPerGramSell = price * (1 - p.sellFeePct);

  const basisGross = p.goldGrams * p.avgBuyPrice;
  const basisWithBuyFee = p.goldGrams * p.avgBuyPrice * (1 + p.buyFeePct);
  const goldMarkValue = p.goldGrams * price;
  const goldLiquidationValue = p.goldGrams * proceedsPerGramSell;

  const portfolioMarkValue = p.cashIrr + goldMarkValue;
  const portfolioLiquidationValue = p.cashIrr + goldLiquidationValue;

  const netPnlAfterFees = goldLiquidationValue - basisWithBuyFee;
  const netPnlPct =
    basisWithBuyFee > 0 ? netPnlAfterFees / basisWithBuyFee : null;
  const breakEvenSellPrice =
    p.avgBuyPrice > 0
      ? (p.avgBuyPrice * (1 + p.buyFeePct)) / (1 - p.sellFeePct)
      : null;
  const affordableGrams = costPerGramBuy > 0 ? p.cashIrr / costPerGramBuy : 0;

  return {
    ...p,
    basisGross,
    basisWithBuyFee,
    goldMarkValue,
    goldLiquidationValue,
    portfolioMarkValue,
    portfolioLiquidationValue,
    netPnlAfterFees,
    netPnlPct,
    breakEvenSellPrice,
    affordableGrams,
    costPerGramBuy,
    proceedsPerGramSell,
  };
}

function ensureStorage() {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  state.paths.historyFile = path.join(CONFIG.dataDir, CONFIG.historyFileName);
  state.paths.signalFile = path.join(CONFIG.dataDir, CONFIG.signalFileName);
  state.paths.profileFile = path.join(CONFIG.dataDir, CONFIG.profileFileName);
}

function appendJsonLine(filePath, payload) {
  try {
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  } catch (err) {
    addError(
      `Failed to write ${path.basename(filePath)}: ${err?.message || err}`,
    );
  }
}

function normalizeField(rawField, snapshotTs) {
  const value = parseNumber(rawField?.value ?? rawField?.p ?? null);
  const ts = parseTimestampMs(rawField?.ts);
  const ageMin =
    Number.isFinite(snapshotTs) && Number.isFinite(ts)
      ? (snapshotTs - ts) / 60_000
      : null;
  const fresh =
    value != null &&
    Number.isFinite(ageMin) &&
    ageMin >= 0 &&
    ageMin <= CONFIG.freshnessMaxMin;

  return { value, ts, ageMin, fresh };
}

function normalizeSnapshot(raw) {
  const t = parseTimestampMs(raw?.t);
  const goldPrice = parseNumber(raw?.goldPrice ?? raw?.price ?? raw?.rawPrice);
  if (!Number.isFinite(t) || !Number.isFinite(goldPrice)) return null;

  const fields = {};
  for (const key of FEATURE_KEYS) {
    fields[key] = normalizeField(raw?.fields?.[key], t);
  }

  return {
    t,
    goldPrice,
    rawPrice: String(raw?.rawPrice ?? goldPrice),
    fields,
  };
}

function loadHistoryFromDisk() {
  if (!fs.existsSync(state.paths.historyFile)) return;
  const raw = fs.readFileSync(state.paths.historyFile, "utf8");
  if (!raw.trim()) return;

  const snapshots = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const normalized = normalizeSnapshot(parsed);
      if (normalized) snapshots.push(normalized);
    } catch {
      // Ignore malformed lines and continue loading.
    }
  }

  snapshots.sort((a, b) => a.t - b.t);
  state.history = snapshots;
  trimHistory(Date.now());
}

function loadPortfolioProfile() {
  const fromEnv = sanitizePortfolio(DEFAULT_PORTFOLIO);
  state.portfolio = fromEnv;

  if (!fs.existsSync(state.paths.profileFile)) return;
  try {
    const raw = fs.readFileSync(state.paths.profileFile, "utf8");
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw);
    state.portfolio = sanitizePortfolio({
      ...fromEnv,
      ...parsed,
    });
  } catch (err) {
    addError(`Failed to load profile: ${err?.message || err}`);
  }
}

function savePortfolioProfile() {
  try {
    fs.writeFileSync(
      state.paths.profileFile,
      `${JSON.stringify(sanitizePortfolio(state.portfolio), null, 2)}\n`,
      "utf8",
    );
  } catch (err) {
    addError(`Failed to save profile: ${err?.message || err}`);
  }
}

function trimHistory(nowMs) {
  const minTs = nowMs - CONFIG.historyRetentionHours * 60 * 60 * 1000;
  while (state.history.length > 0 && state.history[0].t < minTs) {
    state.history.shift();
  }
  if (state.history.length > CONFIG.maxInMemoryPoints) {
    state.history.splice(0, state.history.length - CONFIG.maxInMemoryPoints);
  }
}

function getFieldValue(snapshot, key) {
  const field = snapshot?.fields?.[key];
  return field?.fresh ? field.value : null;
}

function getSeriesValue(snapshot, key) {
  if (!snapshot) return null;
  if (key === "gold") return snapshot.goldPrice;
  if (key === "tgju_gold") {
    return (
      getFieldValue(snapshot, "tgju_gold_irg18") ??
      getFieldValue(snapshot, "tgju_gold_irg18_buy")
    );
  }
  return getFieldValue(snapshot, key);
}

function valueAtOrBefore(field, targetTs) {
  for (let i = state.history.length - 1; i >= 0; i -= 1) {
    const snap = state.history[i];
    if (snap.t > targetTs) continue;
    const v = getSeriesValue(snap, field);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

function valueAtOrAfter(targetTs) {
  for (const snap of state.history) {
    if (snap.t < targetTs) continue;
    if (Number.isFinite(snap.goldPrice)) return snap.goldPrice;
  }
  return null;
}

function momentum(field, lookbackMin) {
  const latest = state.history[state.history.length - 1];
  if (!latest) return null;
  const currentValue = getSeriesValue(latest, field);
  if (!Number.isFinite(currentValue)) return null;
  const previousValue = valueAtOrBefore(field, latest.t - lookbackMin * 60_000);
  return pctChange(currentValue, previousValue);
}

function returnsOver(field, lookbackMin) {
  const latest = state.history[state.history.length - 1];
  if (!latest) return [];
  const cutoff = latest.t - lookbackMin * 60_000;
  const values = [];
  for (const snap of state.history) {
    if (snap.t < cutoff) continue;
    const v = getSeriesValue(snap, field);
    if (Number.isFinite(v)) values.push(v);
  }
  if (values.length < 2) return [];
  const returns = [];
  for (let i = 1; i < values.length; i += 1) {
    const r = pctChange(values[i], values[i - 1]);
    if (Number.isFinite(r)) returns.push(r);
  }
  return returns;
}

function rollingGoldRatioMean(lookbackMin) {
  const latest = state.history[state.history.length - 1];
  if (!latest) return null;
  const cutoff = latest.t - lookbackMin * 60_000;
  const ratios = [];
  for (const snap of state.history) {
    if (snap.t < cutoff) continue;
    const tgjuGold = getSeriesValue(snap, "tgju_gold");
    if (
      !Number.isFinite(snap.goldPrice) ||
      !Number.isFinite(tgjuGold) ||
      tgjuGold === 0
    ) {
      continue;
    }
    ratios.push(snap.goldPrice / tgjuGold);
  }
  return mean(ratios);
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
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

async function fetchSnapshot() {
  const now = Date.now();
  const [tgjuData, talaseaData] = await Promise.all([
    fetchJson(
      TGJU_URL,
      {
        method: "GET",
        headers: TGJU_HEADERS,
        cache: "no-store",
      },
      CONFIG.requestTimeoutMs,
    ),
    fetchJson(
      TALASEA_URL,
      {
        method: "GET",
        headers: TALASEA_HEADERS,
        cache: "no-store",
      },
      CONFIG.requestTimeoutMs,
    ),
  ]);

  const goldPrice = parseNumber(talaseaData?.price + "000");
  if (!Number.isFinite(goldPrice)) {
    throw new Error(
      `Talasea price parsing failed: ${String(talaseaData?.price)}`,
    );
  }

  const current = tgjuData?.current || {};
  const fields = {};
  for (const key of FEATURE_KEYS) {
    const value = parseNumber(current?.[key]?.p);
    const ts = parseTimestampMs(current?.[key]?.ts);
    const ageMin =
      Number.isFinite(ts) && ts <= now ? (now - ts) / 60_000 : null;
    const fresh =
      value != null &&
      Number.isFinite(ageMin) &&
      ageMin >= 0 &&
      ageMin <= CONFIG.freshnessMaxMin;
    fields[key] = { value, ts, ageMin, fresh };
  }

  return {
    t: now,
    goldPrice,
    rawPrice: String(talaseaData?.price),
    fields,
  };
}

function buildSignal() {
  const latest = state.history[state.history.length - 1];
  if (!latest) {
    return {
      score: 0,
      pUp: 0.5,
      confidence: 0,
      coverage: 0,
      freshness: 0,
      freshFields: 0,
      totalFields: FEATURE_KEYS.length,
      price: null,
      inputs: {},
    };
  }

  const inputs = {
    goldMom5: momentum("gold", 5),
    goldMom15: momentum("gold", 15),
    tgjuGoldMom5: momentum("tgju_gold", 5),
    dollarMom5: momentum("price_dollar_rl", 5),
    onsMom5: momentum("ons", 5),
    xautMom5: momentum("tether_gold_xaut", 5),
    silverMom5: momentum("silver", 5),
    volatility15: stdDev(returnsOver("gold", 15)),
    divergence: null,
  };

  const tgjuGoldNow = getSeriesValue(latest, "tgju_gold");
  const ratioMean = rollingGoldRatioMean(
    Math.max(120, CONFIG.predictionHorizonMin * 4),
  );
  if (
    Number.isFinite(tgjuGoldNow) &&
    tgjuGoldNow !== 0 &&
    Number.isFinite(ratioMean)
  ) {
    const ratioNow = latest.goldPrice / tgjuGoldNow;
    inputs.divergence = pctChange(ratioNow, ratioMean);
  }

  const components = {
    goldMom5: 0.34 * tanhNorm(inputs.goldMom5, 0.0025),
    goldMom15: 0.24 * tanhNorm(inputs.goldMom15, 0.0045),
    tgjuGoldMom5: 0.1 * tanhNorm(inputs.tgjuGoldMom5, 0.003),
    dollarMom5: 0.14 * tanhNorm(inputs.dollarMom5, 0.0025),
    onsMom5: 0.1 * tanhNorm(inputs.onsMom5, 0.002),
    xautMom5: 0.08 * tanhNorm(inputs.xautMom5, 0.002),
    silverMom5: 0.06 * tanhNorm(inputs.silverMom5, 0.0025),
    divergence: 0.14 * -tanhNorm(inputs.divergence, 0.0035),
    volatility15: -0.22 * tanhNorm(inputs.volatility15, 0.003),
  };

  const score = Object.values(components).reduce(
    (sum, value) => sum + value,
    0,
  );
  const pUp = sigmoid(score * 2);

  const usedSignals = Object.values(inputs).filter((v) =>
    Number.isFinite(v),
  ).length;
  const coverage = usedSignals / Object.keys(inputs).length;

  const freshFields = Object.values(latest.fields).filter(
    (v) => v.fresh,
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

function chooseAdvice(signal, zones, nowMs) {
  let action = "HOLD";
  let reason = "inside neutral zone";

  const expectedPrice = Number.isFinite(zones?.expectedStop)
    ? zones.expectedStop
    : signal.price;
  const p = sanitizePortfolio(state.portfolio);
  const buyNowCost = signal.price * (1 + p.buyFeePct);
  const sellNowProceeds = signal.price * (1 - p.sellFeePct);
  const expectedSellProceeds = expectedPrice * (1 - p.sellFeePct);
  const expectedRebuyCost = expectedPrice * (1 + p.buyFeePct);

  const buyEdgePct =
    Number.isFinite(expectedSellProceeds) && buyNowCost > 0
      ? (expectedSellProceeds - buyNowCost) / buyNowCost
      : null;
  const sellEdgePct =
    Number.isFinite(expectedRebuyCost) && sellNowProceeds > 0
      ? (sellNowProceeds - expectedRebuyCost) / sellNowProceeds
      : null;

  if (signal.confidence < CONFIG.minConfidence) {
    reason = `confidence below ${formatPct(CONFIG.minConfidence, 1)}`;
  } else if (signal.pUp >= CONFIG.buyThreshold) {
    action = "BUY";
    reason = `P(up) >= ${formatPct(CONFIG.buyThreshold, 1)}`;
  } else if (signal.pUp <= CONFIG.sellThreshold) {
    action = "SELL";
    reason = `P(up) <= ${formatPct(CONFIG.sellThreshold, 1)}`;
  }

  if (action === "BUY" && p.cashIrr < buyNowCost) {
    action = "HOLD";
    reason = "not enough cash for 1g including fee";
  }
  if (action === "SELL" && p.goldGrams <= 0) {
    action = "HOLD";
    reason = "no gold holdings to sell";
  }
  if (action === "BUY" && Number.isFinite(buyEdgePct) && buyEdgePct <= 0) {
    action = "HOLD";
    reason = "BUY edge does not clear fees";
  }
  if (action === "SELL" && Number.isFinite(sellEdgePct) && sellEdgePct <= 0) {
    action = "HOLD";
    reason = "SELL edge does not clear fees";
  }

  if (
    action !== "HOLD" &&
    state.lastActionAt != null &&
    action !== state.lastAction
  ) {
    const elapsedMin = (nowMs - state.lastActionAt) / 60_000;
    if (elapsedMin < CONFIG.actionCooldownMin) {
      action = "HOLD";
      reason = `cooldown active (${Math.ceil(CONFIG.actionCooldownMin - elapsedMin)}m left)`;
    }
  }

  return { action, reason, expectedPrice, buyEdgePct, sellEdgePct };
}

function estimateStopZones(signal) {
  const returnsWindow = returnsOver(
    "gold",
    Math.max(10, CONFIG.predictionHorizonMin),
  );
  const returnVol = stdDev(returnsWindow);
  const perStepVol = Number.isFinite(returnVol) ? returnVol : 0.0018;

  const stepMin = Math.max(0.5, CONFIG.pollIntervalMs / 60_000);
  const expectedSteps = Math.max(1, CONFIG.predictionHorizonMin / stepMin);
  const rangePct = clamp(
    perStepVol * Math.sqrt(expectedSteps) * 1.2,
    0.001,
    0.05,
  );
  const driftPct = (signal.pUp - 0.5) * 2 * rangePct * 1.15;

  const price = signal.price;
  const upLow = price * (1 + Math.max(0, driftPct) + rangePct * 0.3);
  const upHigh = price * (1 + Math.max(0, driftPct) + rangePct * 0.9);
  const downHigh = price * (1 - Math.max(0, -driftPct) - rangePct * 0.3);
  const downLow = price * (1 - Math.max(0, -driftPct) - rangePct * 0.9);

  const expectedStop =
    signal.pUp >= 0.5 ? (upLow + upHigh) / 2 : (downLow + downHigh) / 2;

  return {
    rangePct,
    driftPct,
    expectedStop,
    upLow: Math.max(0, upLow),
    upHigh: Math.max(0, upHigh),
    downLow: Math.max(0, downLow),
    downHigh: Math.max(0, downHigh),
  };
}

function updateReliabilityMetrics() {
  const horizonMs = CONFIG.predictionHorizonMin * 60_000;
  const unresolved = [];

  for (const pred of state.pendingPredictions) {
    const realizedPrice = valueAtOrAfter(pred.t + horizonMs);
    if (!Number.isFinite(realizedPrice)) {
      unresolved.push(pred);
      continue;
    }

    const actualUp = realizedPrice > pred.basePrice ? 1 : 0;
    const predictedUp = pred.pUp >= 0.5 ? 1 : 0;
    const p = clamp(pred.pUp, 0, 1);

    state.metrics.total += 1;
    state.metrics.correct += predictedUp === actualUp ? 1 : 0;
    state.metrics.brierSum += (p - actualUp) ** 2;
  }

  state.pendingPredictions = unresolved;
}

function headerLine() {
  const title =
    chalk.bold.cyan("GOLD MANAGER") + chalk.gray("  |  Probabilistic Advisor");

  const decision = state.lastDecision?.action || "HOLD";
  let modeBadge = chalk.bgYellow.black(" HOLD ");
  if (decision === "BUY") modeBadge = chalk.bgGreen.black(" BUY  ");
  if (decision === "SELL") modeBadge = chalk.bgRed.white(" SELL ");

  const alertBadge = state.lastNotifiedAction
    ? chalk.bgYellow.black(" ALERTED ")
    : chalk.bgBlue.white(" ARMED ");

  const nextIn = state.nextFetchAt
    ? msToHuman(state.nextFetchAt - Date.now())
    : "--:--";

  return `${title}   ${modeBadge} ${alertBadge}   ${chalk.gray("Next fetch in")} ${chalk.white(nextIn)}`;
}

function renderDashboard() {
  clearScreen();

  const width = 108;
  const line = "-".repeat(width - 2);

  const last = state.lastSnapshot?.goldPrice;
  const prev =
    state.history.length >= 2
      ? state.history[state.history.length - 2].goldPrice
      : null;
  const tick = pctChange(last, prev);

  const signal = state.lastSignal;
  const decision = state.lastDecision;
  const zones = state.lastZones;
  const portfolioStats = state.portfolioStats ?? computePortfolioStats(last);

  const accuracy =
    state.metrics.total > 0
      ? state.metrics.correct / state.metrics.total
      : null;
  const brier =
    state.metrics.total > 0
      ? state.metrics.brierSum / state.metrics.total
      : null;

  const sparkSeries = state.history
    .slice(-MAX_SPARK_POINTS)
    .map((s) => s.goldPrice)
    .filter((v) => Number.isFinite(v));

  const latestUsd = getFieldValue(state.lastSnapshot, "price_dollar_rl");
  const latestOns = getFieldValue(state.lastSnapshot, "ons");
  const pnlText =
    portfolioStats && Number.isFinite(portfolioStats.netPnlAfterFees)
      ? portfolioStats.netPnlAfterFees >= 0
        ? chalk.green(
            `${formatNumber(portfolioStats.netPnlAfterFees, 0)} (${formatPct(
              portfolioStats.netPnlPct,
              2,
            )})`,
          )
        : chalk.red(
            `${formatNumber(portfolioStats.netPnlAfterFees, 0)} (${formatPct(
              portfolioStats.netPnlPct,
              2,
            )})`,
          )
      : "--";

  const statsLines = [
    headerLine(),
    chalk.gray(line),
    `${chalk.gray("Last Updated:")} ${state.lastFetchAt ? new Date(state.lastFetchAt).toLocaleString() : "--"}`,
    "",
    `${chalk.gray("Gold Price:")} ${directionArrow(last, prev)} ${chalk.yellow(formatNumber(last, 0))}  ${chalk.gray("|")} ${chalk.gray("Tick:")} ${Number.isFinite(tick) ? formatSignedPct(tick, 3) : "--"}`,
    `${chalk.gray("P(up):")} ${signal ? chalk.green(formatPct(signal.pUp, 1)) : "--"}  ${chalk.gray("|")} ${chalk.gray("P(down):")} ${signal ? chalk.red(formatPct(1 - signal.pUp, 1)) : "--"}  ${chalk.gray("|")} ${chalk.gray("Confidence:")} ${signal ? formatPct(signal.confidence, 1) : "--"}`,
    `${chalk.gray("Advice:")} ${decision ? decision.action : "HOLD"}  ${chalk.gray("|")} ${chalk.gray("Reason:")} ${decision ? decision.reason : "--"}`,
    `${chalk.gray("Stop Zone Up:")} ${zones ? `${formatNumber(zones.upLow, 0)} -> ${formatNumber(zones.upHigh, 0)}` : "--"}`,
    `${chalk.gray("Stop Zone Down:")} ${zones ? `${formatNumber(zones.downLow, 0)} -> ${formatNumber(zones.downHigh, 0)}` : "--"}`,
    `${chalk.gray("Expected Stop:")} ${zones ? formatNumber(zones.expectedStop, 0) : "--"}  ${chalk.gray("|")} ${chalk.gray("Range Width:")} ${zones ? formatPct(zones.rangePct, 2) : "--"}`,
    `${chalk.gray("Edge After Fees:")} buy=${decision ? formatPct(decision.buyEdgePct, 2) : "--"} sell=${decision ? formatPct(decision.sellEdgePct, 2) : "--"}`,
    "",
    `${chalk.gray("Portfolio:")} cash=${formatNumber(portfolioStats?.cashIrr, 0)}  ${chalk.gray("|")} gold=${formatNumber(portfolioStats?.goldGrams, 4)}g  ${chalk.gray("|")} avgBuy=${formatNumber(portfolioStats?.avgBuyPrice, 0)}`,
    `${chalk.gray("Fees:")} buy=${formatPct(portfolioStats?.buyFeePct, 2)} sell=${formatPct(portfolioStats?.sellFeePct, 2)}  ${chalk.gray("|")} breakevenSell=${formatNumber(portfolioStats?.breakEvenSellPrice, 0)}`,
    `${chalk.gray("Value:")} mark=${formatNumber(portfolioStats?.portfolioMarkValue, 0)}  ${chalk.gray("|")} liquidation=${formatNumber(portfolioStats?.portfolioLiquidationValue, 0)}  ${chalk.gray("|")} netPnL=${pnlText}`,
    `${chalk.gray("Capacity:")} affordable now=${formatNumber(portfolioStats?.affordableGrams, 4)}g`,
    "",
    `${chalk.gray("Context:")} usd=${formatNumber(latestUsd, 0)} ons=${formatNumber(latestOns, 2)} fresh=${signal ? `${signal.freshFields}/${signal.totalFields}` : "--"}`,
    `${chalk.gray("Model:")} score=${signal ? signal.score.toFixed(3) : "--"} coverage=${signal ? formatPct(signal.coverage, 1) : "--"} horizon=${CONFIG.predictionHorizonMin}m poll=${Math.round(CONFIG.pollIntervalMs / 1000)}s`,
    `${chalk.gray("Reliability:")} ${state.metrics.total > 0 ? `accuracy=${formatPct(accuracy, 1)} brier=${brier.toFixed(4)} n=${state.metrics.total}` : `waiting for ${CONFIG.predictionHorizonMin}m outcomes`}`,
    "",
    `Chart: [${sparkline(sparkSeries, 56)}] (${sparkSeries.length} pts)`,
  ];

  const box1 = box(statsLines, width);

  const logsLines = state.rawLog
    .slice()
    .reverse()
    .map((l) => `* ${chalk.gray(l)}`);
  const signalLines = state.signalLog
    .slice()
    .reverse()
    .map((l) => `* ${chalk.gray(l)}`);
  const errorLines = state.errors
    .slice()
    .reverse()
    .map((l) => `* ${chalk.red(l)}`);

  const sideLines = [
    chalk.bold.white("Recent Fetches"),
    ...(logsLines.length ? logsLines : [chalk.gray("* none")]),
    "",
    chalk.bold.white("Recent Decisions"),
    ...(signalLines.length ? signalLines : [chalk.gray("* none")]),
    "",
    chalk.bold.white("Errors"),
    ...(errorLines.length ? errorLines : [chalk.gray("* none")]),
  ];

  const box2 = box(sideLines, width);

  console.log(box1);
  console.log();
  console.log(box2);
}

async function askNumber(rl, prompt, currentValue, validator, errorMessage) {
  while (true) {
    const ans = (await rl.question(`${prompt} [${currentValue}]: `)).trim();
    if (!ans) return currentValue;
    const n = Number(ans);
    if (Number.isFinite(n) && validator(n)) return n;
    console.log(`${errorMessage}\n`);
  }
}

async function promptRuntimeConfig() {
  if (CONFIG.runOnce) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;

  clearScreen();
  console.log(chalk.cyan.bold("Gold Manager (Dashboard Mode)\n"));
  console.log(chalk.gray("Press Enter to keep current value.\n"));

  const rl = readline.createInterface({ input, output });
  try {
    CONFIG.predictionHorizonMin = await askNumber(
      rl,
      "Prediction horizon (minutes)",
      CONFIG.predictionHorizonMin,
      (n) => n >= 5 && n <= 24 * 60,
      "Enter a value between 5 and 1440.",
    );

    const pollSec = await askNumber(
      rl,
      "Polling interval (seconds)",
      Math.round(CONFIG.pollIntervalMs / 1000),
      (n) => n >= 10 && n <= 3600,
      "Enter a value between 10 and 3600.",
    );
    CONFIG.pollIntervalMs = Math.round(pollSec * 1000);

    CONFIG.buyThreshold = await askNumber(
      rl,
      "BUY threshold P(up)",
      CONFIG.buyThreshold,
      (n) => n > 0 && n < 1,
      "Enter a value between 0 and 1.",
    );

    CONFIG.sellThreshold = await askNumber(
      rl,
      "SELL threshold P(up)",
      CONFIG.sellThreshold,
      (n) => n > 0 && n < 1,
      "Enter a value between 0 and 1.",
    );

    while (CONFIG.sellThreshold >= CONFIG.buyThreshold) {
      console.log("SELL threshold must be lower than BUY threshold.\n");
      CONFIG.buyThreshold = await askNumber(
        rl,
        "BUY threshold P(up)",
        CONFIG.buyThreshold,
        (n) => n > 0 && n < 1,
        "Enter a value between 0 and 1.",
      );
      CONFIG.sellThreshold = await askNumber(
        rl,
        "SELL threshold P(up)",
        CONFIG.sellThreshold,
        (n) => n > 0 && n < 1,
        "Enter a value between 0 and 1.",
      );
    }

    CONFIG.minConfidence = await askNumber(
      rl,
      "Min confidence",
      CONFIG.minConfidence,
      (n) => n >= 0 && n <= 1,
      "Enter a value between 0 and 1.",
    );

    CONFIG.freshnessMaxMin = await askNumber(
      rl,
      "Feature freshness max (minutes)",
      CONFIG.freshnessMaxMin,
      (n) => n >= 15 && n <= 24 * 60,
      "Enter a value between 15 and 1440.",
    );

    const currentPortfolio = sanitizePortfolio(state.portfolio);
    state.portfolio.cashIrr = await askNumber(
      rl,
      "Your cash (IRR)",
      currentPortfolio.cashIrr,
      (n) => n >= 0,
      "Enter a non-negative value.",
    );
    state.portfolio.goldGrams = await askNumber(
      rl,
      "Your gold amount (grams)",
      currentPortfolio.goldGrams,
      (n) => n >= 0,
      "Enter a non-negative value.",
    );
    state.portfolio.avgBuyPrice = await askNumber(
      rl,
      "Your average buy price (IRR per gram)",
      currentPortfolio.avgBuyPrice,
      (n) => n >= 0,
      "Enter a non-negative value.",
    );

    const buyFeePercent = await askNumber(
      rl,
      "Buy fee (percent, e.g. 0.35)",
      currentPortfolio.buyFeePct * 100,
      (n) => n >= 0 && n <= 20,
      "Enter a value between 0 and 20.",
    );
    const sellFeePercent = await askNumber(
      rl,
      "Sell fee (percent, e.g. 0.35)",
      currentPortfolio.sellFeePct * 100,
      (n) => n >= 0 && n <= 20,
      "Enter a value between 0 and 20.",
    );

    state.portfolio.buyFeePct = buyFeePercent / 100;
    state.portfolio.sellFeePct = sellFeePercent / 100;
    state.portfolio = sanitizePortfolio(state.portfolio);
    savePortfolioProfile();
  } finally {
    rl.close();
  }
}

async function tick() {
  const started = Date.now();
  state.lastFetchAt = started;
  state.nextFetchAt = started + CONFIG.pollIntervalMs;

  const snapshot = await fetchSnapshot();
  state.history.push(snapshot);
  trimHistory(snapshot.t);

  appendJsonLine(state.paths.historyFile, {
    t: snapshot.t,
    goldPrice: snapshot.goldPrice,
    rawPrice: snapshot.rawPrice,
    fields: snapshot.fields,
  });

  updateReliabilityMetrics();

  const signal = buildSignal();
  const zones = estimateStopZones(signal);
  const decision = chooseAdvice(signal, zones, snapshot.t);
  const portfolioStats = computePortfolioStats(snapshot.goldPrice);

  state.lastSnapshot = snapshot;
  state.lastSignal = signal;
  state.lastDecision = decision;
  state.lastZones = zones;
  state.portfolioStats = portfolioStats;

  if (decision.action !== "HOLD") {
    state.lastAction = decision.action;
    state.lastActionAt = snapshot.t;
  }

  state.pendingPredictions.push({
    t: snapshot.t,
    basePrice: snapshot.goldPrice,
    pUp: signal.pUp,
  });

  if (decision.action === "HOLD") {
    state.lastNotifiedAction = null;
  } else if (decision.action !== state.lastNotifiedAction) {
    notifyDecision(decision, signal, zones, snapshot.rawPrice);
    state.lastNotifiedAction = decision.action;
    pushBounded(
      state.rawLog,
      `[${new Date(snapshot.t).toLocaleTimeString()}] Alert sent: ${decision.action}`,
      MAX_LOG_LINES,
    );
  }

  const usd = getFieldValue(snapshot, "price_dollar_rl");
  const ons = getFieldValue(snapshot, "ons");

  pushBounded(
    state.rawLog,
    `[${new Date(snapshot.t).toLocaleTimeString()}] Price=${snapshot.rawPrice} usd=${formatNumber(usd, 0)} ons=${formatNumber(ons, 2)} cash=${formatNumber(portfolioStats?.cashIrr, 0)} gold=${formatNumber(portfolioStats?.goldGrams, 4)}g`,
    MAX_LOG_LINES,
  );

  pushBounded(
    state.signalLog,
    `[${new Date(snapshot.t).toLocaleTimeString()}] ${decision.action} P(up)=${formatPct(signal.pUp, 1)} conf=${formatPct(signal.confidence, 1)} edge(B/S)=${formatPct(decision.buyEdgePct, 2)}/${formatPct(decision.sellEdgePct, 2)}`,
    MAX_LOG_LINES,
  );

  appendJsonLine(state.paths.signalFile, {
    t: snapshot.t,
    horizonMin: CONFIG.predictionHorizonMin,
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
    stopZones: zones,
    portfolio: portfolioStats,
    inputs: signal.inputs,
  });

  renderDashboard();
}

let running = false;

async function runTickSafely() {
  if (running) {
    addError("Skipped one cycle because previous cycle is still running");
    renderDashboard();
    return;
  }

  running = true;
  try {
    await tick();
  } catch (err) {
    const message = err?.message || String(err);
    addError(message);
    renderDashboard();
  } finally {
    running = false;
  }
}

async function main() {
  ensureStorage();
  loadPortfolioProfile();
  loadHistoryFromDisk();

  await promptRuntimeConfig();

  if (CONFIG.buyThreshold <= CONFIG.sellThreshold) {
    throw new Error("BUY_THRESHOLD must be greater than SELL_THRESHOLD");
  }

  state.nextFetchAt = Date.now() + CONFIG.pollIntervalMs;
  renderDashboard();

  await runTickSafely();

  if (CONFIG.runOnce) return;

  setInterval(() => {
    void runTickSafely();
  }, CONFIG.pollIntervalMs);

  setInterval(() => {
    renderDashboard();
  }, 1000);
}

main().catch((err) => {
  console.error(chalk.red(`Fatal error: ${err?.message || err}`));
  process.exitCode = 1;
});
