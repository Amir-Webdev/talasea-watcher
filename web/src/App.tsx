import { useEffect, useMemo, useRef, useState } from "react";
import MetricCard from "./components/MetricCard";
import Panel from "./components/Panel";
import "./styles.css";

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

type Signal = {
  pUp: number;
  confidence: number;
  score: number;
  coverage: number;
  freshness: number;
  freshFields: number;
  totalFields: number;
  price: number;
  timestamp: number;
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
  buyEdgePct: number | null;
  sellEdgePct: number | null;
};

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
  metrics: { total: number; correct: number; brierSum: number };
  historyPoints: number;
  priceHistory: Array<{ t: number; p: number }>;
  logs: string[];
  errors: string[];
};

type ChartModel = {
  width: number;
  height: number;
  path: string;
  yTicks: Array<{ value: number; y: number }>;
  xTicks: Array<{ label: string; x: number }>;
  latest: { x: number; y: number; price: number };
  expectedY: number | null;
  rangeBand: { topY: number; bottomY: number } | null;
};

type TimelineItem = {
  id: string;
  kind: "log" | "error";
  text: string;
  timeLabel: string;
  order: number;
};

type ProfileErrors = Partial<Record<keyof Profile, string>>;
type SettingsErrors = Partial<
  Record<
    | "pollIntervalMs"
    | "predictionHorizonMin"
    | "freshnessMaxMin"
    | "buyThreshold"
    | "sellThreshold"
    | "minConfidence"
    | "actionCooldownMin"
    | "historyRetentionHours"
    | "maxInMemoryPoints"
    | "requestTimeoutMs",
    string
  >
>;

type ThemeMode = "light" | "dark";
type StreamStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";
type BannerTone = "error" | "success" | "info";

type BannerState = {
  tone: BannerTone;
  title: string;
  detail: string;
};

type AlertDirection = "above" | "below";

type AlertPrefs = {
  enabled: boolean;
  systemPush: boolean;
  playSound: boolean;
  buySellSignals: boolean;
  priceCrossing: boolean;
  crossDirection: AlertDirection;
  crossPrice: number;
  minConfidence: number;
  minGapSec: number;
};

type AlertEvent = {
  id: string;
  t: number;
  tone: "buy" | "sell" | "info";
  title: string;
  detail: string;
};

type TradeMode = "buy" | "sell";

type TradePreview = {
  mode: TradeMode;
  grams: number;
  grossValue: number;
  feeValue: number;
  netValue: number;
  cashAfter: number;
  goldAfter: number;
  breakEvenAfter: number | null;
  valid: boolean;
  issue: string | null;
};

type HelpTab = "overview" | "statuses" | "flows" | "data";
type HelpLang = "en" | "fa";

const ALERT_PREFS_KEY = "gm_alert_prefs_v1";
const ALERT_EVENTS_KEY = "gm_alert_events_v1";
const HELP_LANG_KEY = "gm_help_lang_v1";
const MAX_ALERT_EVENTS = 30;

type PushPermissionState = NotificationPermission | "unsupported";

const ALERT_PREFS_DEFAULT: AlertPrefs = {
  enabled: true,
  systemPush: true,
  playSound: true,
  buySellSignals: true,
  priceCrossing: false,
  crossDirection: "above",
  crossPrice: 0,
  minConfidence: 0.35,
  minGapSec: 120,
};

function fmtNumber(v: number | null | undefined, digits = 0): string {
  if (!Number.isFinite(v ?? Number.NaN)) return "--";
  return (v as number).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtPct(v: number | null | undefined, digits = 2): string {
  if (!Number.isFinite(v ?? Number.NaN)) return "--";
  return `${((v as number) * 100).toFixed(digits)}%`;
}

function fmtTimeShort(ts: number | null | undefined): string {
  if (!Number.isFinite(ts ?? Number.NaN)) return "--";
  return new Date(ts as number).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(totalSec: number | null): string {
  if (!Number.isFinite(totalSec ?? Number.NaN)) return "--";
  const seconds = Math.max(0, Math.round(totalSec as number));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtSigned(v: number | null | undefined, digits = 2): string {
  if (!Number.isFinite(v ?? Number.NaN)) return "--";
  const n = v as number;
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function reliabilityBand(
  sampleSize: number,
  meanBrier: number | null,
): {
  label: string;
  detail: string;
} {
  if (!sampleSize) {
    return {
      label: "Not enough data",
      detail: "Waiting for resolved predictions.",
    };
  }
  if (sampleSize < 15) {
    return {
      label: "Early signal",
      detail: "Calibration can change quickly with more samples.",
    };
  }
  if (meanBrier == null) {
    return { label: "Unknown", detail: "Brier score unavailable." };
  }
  if (meanBrier <= 0.16) {
    return {
      label: "Strong",
      detail: "Prediction quality is currently stable.",
    };
  }
  if (meanBrier <= 0.24) {
    return { label: "Moderate", detail: "Useful but requires caution." };
  }
  return {
    label: "Weak",
    detail: "Model confidence is not calibrated enough yet.",
  };
}

function timelineMetaFromText(
  line: string,
  fallbackOrder: number,
): {
  order: number;
  timeLabel: string;
  text: string;
} {
  const bracket = line.match(/^\[([^\]]+)]\s*(.*)$/);
  if (!bracket) {
    return { order: fallbackOrder, timeLabel: "--", text: line };
  }

  const inside = bracket[1];
  const message = bracket[2] || line;

  // Preferred format: [iso|epochMs|seq]
  const tokens = inside.split("|");
  const isoToken = tokens[0];
  const epochToken = tokens[1];
  const seqToken = tokens[2];

  const parsedEpoch = Number(epochToken);
  const parsedSeq = Number(seqToken);
  if (Number.isFinite(parsedEpoch)) {
    const seq = Number.isFinite(parsedSeq) ? parsedSeq : 0;
    return {
      order: parsedEpoch * 1_000 + seq,
      timeLabel: fmtTimeShort(parsedEpoch),
      text: message,
    };
  }

  const parsedIso = Date.parse(isoToken);
  if (!Number.isNaN(parsedIso)) {
    return {
      order: parsedIso * 1_000,
      timeLabel: fmtTimeShort(parsedIso),
      text: message,
    };
  }

  // Legacy format fallback: [HH:mm:ss]
  const hms = inside.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (hms) {
    const hour = Number(hms[1]);
    const minute = Number(hms[2]);
    const second = Number(hms[3]);
    if (
      Number.isFinite(hour) &&
      Number.isFinite(minute) &&
      Number.isFinite(second)
    ) {
      const candidate = new Date();
      candidate.setHours(hour, minute, second, 0);
      let candidateMs = candidate.getTime();
      // Avoid future ordering when logs are from previous day around midnight.
      if (candidateMs > Date.now() + 60 * 60 * 1000) {
        candidateMs -= 24 * 60 * 60 * 1000;
      }
      return {
        order: candidateMs * 1_000 + fallbackOrder,
        timeLabel: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
        text: message,
      };
    }
  }

  return { order: fallbackOrder, timeLabel: "--", text: message };
}

function parseNumberInput(raw: string): number {
  if (!raw.trim()) return Number.NaN;
  return Number(raw);
}

function toInputValue(v: number | null | undefined): string {
  return Number.isFinite(v ?? Number.NaN) ? String(v) : "";
}

function parseError(err: unknown): string {
  if (err instanceof Error) {
    try {
      const parsed = JSON.parse(err.message) as { error?: string };
      if (parsed?.error) return parsed.error;
    } catch {
      return err.message;
    }
    return err.message;
  }
  return String(err);
}

function buildErrorBanner(err: unknown, context: string): BannerState {
  const message = parseError(err);
  const lower = message.toLowerCase();

  if (
    lower.includes("threshold") ||
    lower.includes("must be") ||
    lower.includes("range") ||
    lower.includes("invalid")
  ) {
    return {
      tone: "error",
      title: "Validation Error",
      detail: `${context}: ${message}`,
    };
  }

  if (
    lower.includes("disconnected") ||
    lower.includes("eventsource") ||
    lower.includes("stream")
  ) {
    return {
      tone: "error",
      title: "Connection Error",
      detail: `${context}: ${message}`,
    };
  }

  if (
    lower.includes("fetch") ||
    lower.includes("http") ||
    lower.includes("network") ||
    lower.includes("timeout")
  ) {
    return {
      tone: "error",
      title: "Request Error",
      detail: `${context}: ${message}`,
    };
  }

  return {
    tone: "error",
    title: "Unexpected Error",
    detail: `${context}: ${message}`,
  };
}

function hasAnyErrors(errors: Record<string, string | undefined>): boolean {
  return Object.values(errors).some((msg) => Boolean(msg));
}

function getInitialTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";
  const saved = window.localStorage.getItem("gm_theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function getInitialHelpLang(): HelpLang {
  if (typeof window === "undefined") return "en";
  const saved = window.localStorage.getItem(HELP_LANG_KEY);
  return saved === "fa" ? "fa" : "en";
}

function getInitialAlertPrefs(): AlertPrefs {
  if (typeof window === "undefined") return { ...ALERT_PREFS_DEFAULT };
  const raw = window.localStorage.getItem(ALERT_PREFS_KEY);
  if (!raw) return { ...ALERT_PREFS_DEFAULT };
  try {
    const parsed = JSON.parse(raw) as Partial<AlertPrefs>;
    return {
      enabled: Boolean(parsed.enabled ?? ALERT_PREFS_DEFAULT.enabled),
      systemPush: Boolean(parsed.systemPush ?? ALERT_PREFS_DEFAULT.systemPush),
      playSound: Boolean(parsed.playSound ?? ALERT_PREFS_DEFAULT.playSound),
      buySellSignals: Boolean(
        parsed.buySellSignals ?? ALERT_PREFS_DEFAULT.buySellSignals,
      ),
      priceCrossing: Boolean(
        parsed.priceCrossing ?? ALERT_PREFS_DEFAULT.priceCrossing,
      ),
      crossDirection: parsed.crossDirection === "below" ? "below" : "above",
      crossPrice: Number.isFinite(parsed.crossPrice ?? Number.NaN)
        ? Math.max(0, parsed.crossPrice as number)
        : ALERT_PREFS_DEFAULT.crossPrice,
      minConfidence: Number.isFinite(parsed.minConfidence ?? Number.NaN)
        ? clamp01(parsed.minConfidence as number)
        : ALERT_PREFS_DEFAULT.minConfidence,
      minGapSec: Number.isFinite(parsed.minGapSec ?? Number.NaN)
        ? Math.max(0, Math.round(parsed.minGapSec as number))
        : ALERT_PREFS_DEFAULT.minGapSec,
    };
  } catch {
    return { ...ALERT_PREFS_DEFAULT };
  }
}

function getInitialAlertEvents(): AlertEvent[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(ALERT_EVENTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<Partial<AlertEvent>>;
    if (!Array.isArray(parsed)) return [];
    const normalized = parsed
      .map((item, index) => {
        const tone =
          item.tone === "buy" || item.tone === "sell" || item.tone === "info"
            ? item.tone
            : "info";
        const t = Number(item.t);
        if (!Number.isFinite(t)) return null;
        return {
          id: String(item.id ?? `persisted-${index}-${t}`),
          t,
          tone,
          title: String(item.title ?? "Alert"),
          detail: String(item.detail ?? ""),
        } satisfies AlertEvent;
      })
      .filter((item): item is AlertEvent => item != null)
      .sort((a, b) => b.t - a.t)
      .slice(0, MAX_ALERT_EVENTS);
    return normalized;
  } catch {
    return [];
  }
}

function profileEqual(a: Profile | null, b: Profile | null): boolean {
  if (!a || !b) return false;
  return (
    a.cashIrr === b.cashIrr &&
    a.goldGrams === b.goldGrams &&
    a.avgBuyPrice === b.avgBuyPrice &&
    a.buyFeePct === b.buyFeePct &&
    a.sellFeePct === b.sellFeePct
  );
}

function settingsEqual(a: Settings | null, b: Settings | null): boolean {
  if (!a || !b) return false;
  return (
    a.pollIntervalMs === b.pollIntervalMs &&
    a.predictionHorizonMin === b.predictionHorizonMin &&
    a.freshnessMaxMin === b.freshnessMaxMin &&
    a.buyThreshold === b.buyThreshold &&
    a.sellThreshold === b.sellThreshold &&
    a.minConfidence === b.minConfidence &&
    a.actionCooldownMin === b.actionCooldownMin &&
    a.historyRetentionHours === b.historyRetentionHours &&
    a.maxInMemoryPoints === b.maxInMemoryPoints &&
    a.requestTimeoutMs === b.requestTimeoutMs
  );
}

function playAlertBeep(tone: "buy" | "sell" | "info"): void {
  if (typeof window === "undefined") return;
  const AudioContextCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextCtor) return;
  const ctx = new AudioContextCtor();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = "sine";
  osc.frequency.value = tone === "buy" ? 880 : tone === "sell" ? 330 : 520;
  gain.gain.value = 0.06;
  osc.start();
  osc.stop(ctx.currentTime + 0.12);
  window.setTimeout(() => void ctx.close(), 180);
}

function validateProfileDraft(profile: Profile | null): ProfileErrors {
  if (!profile) return {};
  const errors: ProfileErrors = {};

  if (!Number.isFinite(profile.cashIrr) || profile.cashIrr < 0) {
    errors.cashIrr = "Cash must be a number greater than or equal to 0.";
  }
  if (!Number.isFinite(profile.goldGrams) || profile.goldGrams < 0) {
    errors.goldGrams =
      "Gold grams must be a number greater than or equal to 0.";
  }
  if (!Number.isFinite(profile.avgBuyPrice) || profile.avgBuyPrice < 0) {
    errors.avgBuyPrice =
      "Average buy price must be a number greater than or equal to 0.";
  }
  if (
    !Number.isFinite(profile.buyFeePct) ||
    profile.buyFeePct < 0 ||
    profile.buyFeePct > 0.2
  ) {
    errors.buyFeePct = "Buy fee must be between 0% and 20%.";
  }
  if (
    !Number.isFinite(profile.sellFeePct) ||
    profile.sellFeePct < 0 ||
    profile.sellFeePct > 0.2
  ) {
    errors.sellFeePct = "Sell fee must be between 0% and 20%.";
  }

  return errors;
}

function validateSettingsDraft(settings: Settings | null): SettingsErrors {
  if (!settings) return {};
  const errors: SettingsErrors = {};

  if (
    !Number.isFinite(settings.pollIntervalMs) ||
    settings.pollIntervalMs < 10_000 ||
    settings.pollIntervalMs > 3_600_000
  ) {
    errors.pollIntervalMs =
      "Poll interval must be between 10,000 and 3,600,000 ms.";
  }
  if (
    !Number.isFinite(settings.predictionHorizonMin) ||
    settings.predictionHorizonMin < 5 ||
    settings.predictionHorizonMin > 1_440
  ) {
    errors.predictionHorizonMin =
      "Prediction horizon must be between 5 and 1,440 minutes.";
  }
  if (
    !Number.isFinite(settings.freshnessMaxMin) ||
    settings.freshnessMaxMin < 15 ||
    settings.freshnessMaxMin > 1_440
  ) {
    errors.freshnessMaxMin = "Freshness must be between 15 and 1,440 minutes.";
  }
  if (
    !Number.isFinite(settings.buyThreshold) ||
    settings.buyThreshold < 0.01 ||
    settings.buyThreshold > 0.99
  ) {
    errors.buyThreshold = "BUY threshold must be between 0.01 and 0.99.";
  }
  if (
    !Number.isFinite(settings.sellThreshold) ||
    settings.sellThreshold < 0.01 ||
    settings.sellThreshold > 0.99
  ) {
    errors.sellThreshold = "SELL threshold must be between 0.01 and 0.99.";
  }
  if (
    !Number.isFinite(settings.minConfidence) ||
    settings.minConfidence < 0 ||
    settings.minConfidence > 1
  ) {
    errors.minConfidence = "Min confidence must be between 0 and 1.";
  }
  if (
    !Number.isFinite(settings.actionCooldownMin) ||
    settings.actionCooldownMin < 0 ||
    settings.actionCooldownMin > 360
  ) {
    errors.actionCooldownMin =
      "Action cooldown must be between 0 and 360 minutes.";
  }
  if (
    !Number.isFinite(settings.historyRetentionHours) ||
    settings.historyRetentionHours < 24 ||
    settings.historyRetentionHours > 24 * 365
  ) {
    errors.historyRetentionHours =
      "History retention must be between 24 and 8,760 hours.";
  }
  if (
    !Number.isFinite(settings.maxInMemoryPoints) ||
    settings.maxInMemoryPoints < 1_000 ||
    settings.maxInMemoryPoints > 1_000_000
  ) {
    errors.maxInMemoryPoints =
      "Max in-memory points must be between 1,000 and 1,000,000.";
  }
  if (
    !Number.isFinite(settings.requestTimeoutMs) ||
    settings.requestTimeoutMs < 3_000 ||
    settings.requestTimeoutMs > 60_000
  ) {
    errors.requestTimeoutMs =
      "Request timeout must be between 3,000 and 60,000 ms.";
  }

  if (
    !errors.buyThreshold &&
    !errors.sellThreshold &&
    settings.buyThreshold <= settings.sellThreshold
  ) {
    errors.buyThreshold = "BUY threshold must be greater than SELL threshold.";
    errors.sellThreshold = "SELL threshold must be lower than BUY threshold.";
  }

  return errors;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return (await res.json()) as T;
}

export default function App() {
  const [state, setState] = useState<PublicState | null>(null);
  const [profileDraft, setProfileDraft] = useState<Profile | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [banner, setBanner] = useState<BannerState | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");
  const [lastStreamEventAt, setLastStreamEventAt] = useState<number | null>(
    null,
  );
  const [nowMs, setNowMs] = useState<number>(Date.now());
  const [alertPrefs, setAlertPrefs] =
    useState<AlertPrefs>(getInitialAlertPrefs);
  const [alertEvents, setAlertEvents] = useState<AlertEvent[]>(
    getInitialAlertEvents,
  );
  const [pushPermission, setPushPermission] = useState<PushPermissionState>(
    () => {
      if (typeof window === "undefined" || typeof Notification === "undefined")
        return "unsupported";
      return Notification.permission;
    },
  );
  const [tradeMode, setTradeMode] = useState<TradeMode>("buy");
  const [tradeGramsInput, setTradeGramsInput] = useState<string>("1");
  const [helpLang, setHelpLang] = useState<HelpLang>(getInitialHelpLang);
  const [helpTab, setHelpTab] = useState<HelpTab>("overview");

  const prevActionRef = useRef<Action | null>(null);
  const prevPriceRef = useRef<number | null>(null);
  const lastAlertAtRef = useRef<number>(0);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("gm_theme", theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem(HELP_LANG_KEY, helpLang);
  }, [helpLang]);

  useEffect(() => {
    window.localStorage.setItem(ALERT_PREFS_KEY, JSON.stringify(alertPrefs));
  }, [alertPrefs]);

  useEffect(() => {
    window.localStorage.setItem(
      ALERT_EVENTS_KEY,
      JSON.stringify(alertEvents.slice(0, MAX_ALERT_EVENTS)),
    );
  }, [alertEvents]);

  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let closed = false;
    setStreamStatus("connecting");

    api<PublicState>("/api/state")
      .then((s) => {
        if (closed) return;
        setState(s);
        setProfileDraft(s.profile);
        setSettingsDraft(s.settings);
        setLastStreamEventAt(Date.now());
      })
      .catch((e) => setBanner(buildErrorBanner(e, "Loading initial state")));

    const es = new EventSource("/api/events");
    es.onopen = () => {
      if (closed) return;
      setStreamStatus("connected");
      setBanner((prev) => (prev?.title === "Connection Error" ? null : prev));
    };
    es.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data) as PublicState;
        setState(next);
        setLastStreamEventAt(Date.now());
        setStreamStatus("connected");
      } catch {
        // ignore malformed events
      }
    };
    es.onerror = () => {
      if (closed) return;
      setStreamStatus("reconnecting");
      setBanner({
        tone: "info",
        title: "Live Stream Reconnecting",
        detail: "Live updates dropped. The app is retrying automatically.",
      });
    };

    return () => {
      closed = true;
      setStreamStatus("disconnected");
      es.close();
    };
  }, []);

  useEffect(() => {
    if (!state) return;
    if (!profileDraft) setProfileDraft(state.profile);
    if (!settingsDraft) setSettingsDraft(state.settings);
  }, [state, profileDraft, settingsDraft]);

  useEffect(() => {
    if (typeof Notification === "undefined") {
      setPushPermission("unsupported");
      return;
    }
    setPushPermission(Notification.permission);
  }, []);

  useEffect(() => {
    if (!banner || banner.tone === "error") return;
    const timer = window.setTimeout(() => setBanner(null), 4500);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const isLoading = !state;
  const pollIntervalMs = state?.settings.pollIntervalMs ?? null;

  useEffect(() => {
    if (!pollIntervalMs || !lastStreamEventAt) return;
    if (streamStatus !== "connected") return;
    const staleCutoffMs = Math.max(pollIntervalMs * 2, 45_000);
    if (nowMs - lastStreamEventAt > staleCutoffMs) {
      setStreamStatus("disconnected");
      setBanner({
        tone: "error",
        title: "Connection Error",
        detail:
          "No live stream updates received recently. Try Fetch Now or check network.",
      });
    }
  }, [pollIntervalMs, lastStreamEventAt, nowMs, streamStatus]);

  const profileErrors = useMemo(
    () => validateProfileDraft(profileDraft),
    [profileDraft],
  );
  const settingsErrors = useMemo(
    () => validateSettingsDraft(settingsDraft),
    [settingsDraft],
  );
  const profileHasErrors = hasAnyErrors(profileErrors);
  const settingsHasErrors = hasAnyErrors(settingsErrors);
  const profileDirty = useMemo(
    () =>
      profileDraft != null &&
      state != null &&
      !profileEqual(profileDraft, state.profile),
    [profileDraft, state],
  );
  const settingsDirty = useMemo(
    () =>
      settingsDraft != null &&
      state != null &&
      !settingsEqual(settingsDraft, state.settings),
    [settingsDraft, state],
  );
  const hasUnsavedChanges = profileDirty || settingsDirty;

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedChanges]);

  const nextFetchInSec =
    state?.nextFetchAt != null
      ? Math.max(0, Math.round((state.nextFetchAt - nowMs) / 1000))
      : null;
  const dataAgeSec =
    state?.lastFetchAt != null
      ? Math.max(0, Math.round((nowMs - state.lastFetchAt) / 1000))
      : null;
  const dataIsStale =
    pollIntervalMs != null && dataAgeSec != null
      ? dataAgeSec * 1000 > pollIntervalMs * 2
      : false;

  const totalPredictions = state?.metrics.total ?? 0;
  const hitRate =
    totalPredictions > 0
      ? (state?.metrics.correct ?? 0) / totalPredictions
      : null;
  const meanBrier =
    totalPredictions > 0
      ? (state?.metrics.brierSum ?? 0) / totalPredictions
      : null;
  const reliability = reliabilityBand(totalPredictions, meanBrier);

  const thresholdSummary = useMemo(() => {
    const pUp = state?.signal?.pUp;
    const buy = settingsDraft?.buyThreshold;
    const sell = settingsDraft?.sellThreshold;
    if (
      !Number.isFinite(pUp ?? Number.NaN) ||
      !Number.isFinite(buy ?? Number.NaN) ||
      !Number.isFinite(sell ?? Number.NaN)
    ) {
      return { label: "No threshold data yet", tone: "neutral" as const };
    }
    if ((pUp as number) <= (sell as number)) {
      return { label: "Current signal is in SELL zone", tone: "sell" as const };
    }
    if ((pUp as number) >= (buy as number)) {
      return { label: "Current signal is in BUY zone", tone: "buy" as const };
    }
    return { label: "Current signal is in HOLD zone", tone: "hold" as const };
  }, [
    state?.signal?.pUp,
    settingsDraft?.buyThreshold,
    settingsDraft?.sellThreshold,
  ]);

  const sellThresholdPct = clamp01(settingsDraft?.sellThreshold ?? 0) * 100;
  const buyThresholdPct = clamp01(settingsDraft?.buyThreshold ?? 0) * 100;
  const pUpPct = clamp01(state?.signal?.pUp ?? 0) * 100;
  const holdZoneWidthPct = Math.max(0, buyThresholdPct - sellThresholdPct);

  const timelineItems = useMemo<TimelineItem[]>(() => {
    if (!state) return [];
    const logs = (state.logs ?? []).map((line, idx) => {
      const meta = timelineMetaFromText(line, idx * 2);
      return {
        id: `log-${idx}-${line}`,
        kind: "log" as const,
        text: meta.text,
        timeLabel: meta.timeLabel,
        order: meta.order,
      };
    });
    const errors = (state.errors ?? []).map((line, idx) => {
      const meta = timelineMetaFromText(line, idx * 2 + 1);
      return {
        id: `error-${idx}-${line}`,
        kind: "error" as const,
        text: meta.text,
        timeLabel: meta.timeLabel,
        order: meta.order,
      };
    });
    return [...logs, ...errors].sort((a, b) => b.order - a.order).slice(0, 40);
  }, [state]);

  const chartModel = useMemo<ChartModel | null>(() => {
    if (!state?.priceHistory?.length) return null;
    const points = state.priceHistory;
    const width = 760;
    const height = 220;
    const padLeft = 58;
    const padRight = 16;
    const padTop = 14;
    const padBottom = 32;

    const values = points.map((p) => p.p);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const range = max - min;

    const xAt = (index: number): number => {
      const innerWidth = width - padLeft - padRight;
      return padLeft + (index / Math.max(1, points.length - 1)) * innerWidth;
    };
    const yAt = (price: number): number => {
      const innerHeight = height - padTop - padBottom;
      return padTop + (1 - (price - min) / range) * innerHeight;
    };

    const path = points
      .map(
        (point, i) =>
          `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(point.p).toFixed(1)}`,
      )
      .join(" ");

    const yTicks = [max, min + range * 0.5, min].map((value) => ({
      value,
      y: yAt(value),
    }));

    const firstTs = points[0].t;
    const midTs = points[Math.floor(points.length / 2)].t;
    const lastTs = points[points.length - 1].t;
    const xTicks = [
      { label: fmtTimeShort(firstTs), x: xAt(0) },
      { label: fmtTimeShort(midTs), x: xAt(Math.floor(points.length / 2)) },
      { label: fmtTimeShort(lastTs), x: xAt(points.length - 1) },
    ];

    const latestPriceValue = points[points.length - 1].p;
    const latest = {
      x: xAt(points.length - 1),
      y: yAt(latestPriceValue),
      price: latestPriceValue,
    };

    const expected = state.zones?.expectedStop;
    const expectedY = Number.isFinite(expected ?? Number.NaN)
      ? yAt(expected as number)
      : null;

    const downLow = state.zones?.downLow;
    const upHigh = state.zones?.upHigh;
    const rangeBand =
      Number.isFinite(downLow ?? Number.NaN) &&
      Number.isFinite(upHigh ?? Number.NaN)
        ? {
            topY: yAt(upHigh as number),
            bottomY: yAt(downLow as number),
          }
        : null;

    return {
      width,
      height,
      path,
      yTicks,
      xTicks,
      latest,
      expectedY,
      rangeBand,
    };
  }, [state]);

  const latestPrice =
    state && state.priceHistory.length
      ? state.priceHistory[state.priceHistory.length - 1].p
      : null;

  const adviceAction = state?.decision.action ?? "HOLD";
  const tradePreview = useMemo<TradePreview | null>(() => {
    if (!profileDraft || !Number.isFinite(latestPrice ?? Number.NaN))
      return null;
    const grams = parseNumberInput(tradeGramsInput);
    const price = latestPrice as number;
    const safeGrams = Number.isFinite(grams) ? Math.max(0, grams) : Number.NaN;
    const invalidBase: TradePreview = {
      mode: tradeMode,
      grams: Number.isFinite(safeGrams) ? safeGrams : 0,
      grossValue: 0,
      feeValue: 0,
      netValue: 0,
      cashAfter: profileDraft.cashIrr,
      goldAfter: profileDraft.goldGrams,
      breakEvenAfter:
        profileDraft.goldGrams > 0
          ? (profileDraft.avgBuyPrice * (1 + profileDraft.buyFeePct)) /
            (1 - profileDraft.sellFeePct)
          : null,
      valid: false,
      issue: "Enter a grams value greater than 0.",
    };

    if (!Number.isFinite(safeGrams) || safeGrams <= 0) return invalidBase;

    const grossValue = safeGrams * price;
    if (tradeMode === "buy") {
      const feeValue = grossValue * profileDraft.buyFeePct;
      const netValue = grossValue + feeValue;
      const cashAfter = profileDraft.cashIrr - netValue;
      const goldAfter = profileDraft.goldGrams + safeGrams;
      const avgBuyAfter =
        goldAfter > 0
          ? (profileDraft.goldGrams * profileDraft.avgBuyPrice +
              safeGrams * price) /
            goldAfter
          : 0;
      return {
        mode: "buy",
        grams: safeGrams,
        grossValue,
        feeValue,
        netValue,
        cashAfter,
        goldAfter,
        breakEvenAfter:
          goldAfter > 0
            ? (avgBuyAfter * (1 + profileDraft.buyFeePct)) /
              (1 - profileDraft.sellFeePct)
            : null,
        valid: cashAfter >= 0,
        issue:
          cashAfter >= 0
            ? null
            : "Not enough cash for this buy size including fees.",
      };
    }

    const feeValue = grossValue * profileDraft.sellFeePct;
    const netValue = grossValue - feeValue;
    const cashAfter = profileDraft.cashIrr + netValue;
    const goldAfter = profileDraft.goldGrams - safeGrams;
    return {
      mode: "sell",
      grams: safeGrams,
      grossValue,
      feeValue,
      netValue,
      cashAfter,
      goldAfter,
      breakEvenAfter:
        goldAfter > 0
          ? (profileDraft.avgBuyPrice * (1 + profileDraft.buyFeePct)) /
            (1 - profileDraft.sellFeePct)
          : null,
      valid: goldAfter >= 0,
      issue:
        goldAfter >= 0 ? null : "Not enough gold holdings for this sell size.",
    };
  }, [latestPrice, profileDraft, tradeGramsInput, tradeMode]);

  const ruleCount =
    Number(alertPrefs.buySellSignals) + Number(alertPrefs.priceCrossing);
  const alertStateLabel = !alertPrefs.enabled
    ? "Paused"
    : ruleCount === 0
      ? "No active rules"
      : `${ruleCount} active rule${ruleCount > 1 ? "s" : ""}`;
  const pushStatusLabel =
    pushPermission === "granted"
      ? "Push enabled"
      : pushPermission === "unsupported"
        ? "Push unsupported"
        : pushPermission === "denied"
          ? "Push blocked"
          : "Push permission needed";

  const requestNotificationPermission = async () => {
    if (
      pushPermission === "unsupported" ||
      typeof Notification === "undefined"
    ) {
      setBanner({
        tone: "error",
        title: "Notification Unsupported",
        detail: "This browser does not support system notifications.",
      });
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      setPushPermission(permission);
      setBanner(
        permission === "granted"
          ? {
              tone: "success",
              title: "Push Notifications Enabled",
              detail: "System notifications will be used for future alerts.",
            }
          : {
              tone: "info",
              title: "Push Permission Not Granted",
              detail:
                "In-app alerts still work. You can change permission in browser settings.",
            },
      );
    } catch (e) {
      setBanner(buildErrorBanner(e, "Requesting push permission"));
    }
  };

  useEffect(() => {
    if (!state || !state.signal || !Number.isFinite(latestPrice ?? Number.NaN))
      return;
    const currentAction = state.decision.action;
    const currentPrice = latestPrice as number;
    const previousAction = prevActionRef.current;
    const previousPrice = prevPriceRef.current;
    const now = Date.now();
    const minGapMs = Math.max(0, Math.round(alertPrefs.minGapSec * 1000));
    const canAlert = now - lastAlertAtRef.current >= minGapMs;

    let tone: AlertEvent["tone"] | null = null;
    let title = "";
    let detail = "";

    if (alertPrefs.enabled && canAlert) {
      if (
        alertPrefs.buySellSignals &&
        (currentAction === "BUY" || currentAction === "SELL") &&
        currentAction !== previousAction &&
        state.signal.confidence >= alertPrefs.minConfidence
      ) {
        tone = currentAction === "BUY" ? "buy" : "sell";
        title = `${currentAction} Signal`;
        detail = `Price ${fmtNumber(currentPrice, 0)} | P(up) ${fmtPct(state.signal.pUp, 1)} | Confidence ${fmtPct(state.signal.confidence, 1)}`;
      } else if (
        alertPrefs.priceCrossing &&
        alertPrefs.crossPrice > 0 &&
        Number.isFinite(previousPrice ?? Number.NaN)
      ) {
        const crossedAbove =
          alertPrefs.crossDirection === "above" &&
          (previousPrice as number) < alertPrefs.crossPrice &&
          currentPrice >= alertPrefs.crossPrice;
        const crossedBelow =
          alertPrefs.crossDirection === "below" &&
          (previousPrice as number) > alertPrefs.crossPrice &&
          currentPrice <= alertPrefs.crossPrice;
        if (crossedAbove || crossedBelow) {
          tone = "info";
          title = crossedAbove ? "Price Crossed Up" : "Price Crossed Down";
          detail = `Current ${fmtNumber(currentPrice, 0)} | Target ${fmtNumber(alertPrefs.crossPrice, 0)}`;
        }
      }
    }

    if (tone) {
      const event: AlertEvent = {
        id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
        t: now,
        tone,
        title,
        detail,
      };
      setAlertEvents((prev) => [event, ...prev].slice(0, MAX_ALERT_EVENTS));
      if (alertPrefs.playSound) playAlertBeep(tone);
      if (
        alertPrefs.systemPush &&
        typeof Notification !== "undefined" &&
        pushPermission === "granted"
      ) {
        new Notification(title, { body: detail });
      }
      lastAlertAtRef.current = now;
    }

    prevActionRef.current = currentAction;
    prevPriceRef.current = currentPrice;
  }, [alertPrefs, latestPrice, pushPermission, state]);

  const resetProfileDraft = () => {
    if (!state) return;
    setProfileDraft(state.profile);
    setBanner({
      tone: "info",
      title: "Portfolio Draft Cleared",
      detail: "Portfolio form was reset to saved values.",
    });
  };

  const resetSettingsDraft = () => {
    if (!state) return;
    setSettingsDraft(state.settings);
    setBanner({
      tone: "info",
      title: "Settings Draft Cleared",
      detail: "Strategy settings were reset to saved values.",
    });
  };

  const saveProfile = async () => {
    if (!profileDraft) return;
    if (profileHasErrors) {
      setBanner({
        tone: "error",
        title: "Validation Error",
        detail: "Fix portfolio validation errors before saving.",
      });
      return;
    }
    setSaving("profile");
    setBanner(null);
    try {
      await api<Profile>("/api/profile", {
        method: "PUT",
        body: JSON.stringify(profileDraft),
      });
      setBanner({
        tone: "success",
        title: "Portfolio Saved",
        detail: `Portfolio values saved at ${fmtTimeShort(Date.now())}.`,
      });
    } catch (e) {
      setBanner(buildErrorBanner(e, "Saving portfolio"));
    } finally {
      setSaving(null);
    }
  };

  const saveSettings = async () => {
    if (!settingsDraft) return;
    if (settingsHasErrors) {
      setBanner({
        tone: "error",
        title: "Validation Error",
        detail: "Fix strategy validation errors before saving.",
      });
      return;
    }
    setSaving("settings");
    setBanner(null);
    try {
      await api<Settings>("/api/settings", {
        method: "PUT",
        body: JSON.stringify(settingsDraft),
      });
      setBanner({
        tone: "success",
        title: "Settings Saved",
        detail: `Strategy settings saved at ${fmtTimeShort(Date.now())}.`,
      });
    } catch (e) {
      setBanner(buildErrorBanner(e, "Saving settings"));
    } finally {
      setSaving(null);
    }
  };

  const triggerFetch = async () => {
    setSaving("fetch");
    setBanner(null);
    try {
      await api<{ ok: boolean }>("/api/actions/fetch", { method: "POST" });
      setBanner({
        tone: "info",
        title: "Manual Fetch Triggered",
        detail: "Requested an immediate data refresh.",
      });
    } catch (e) {
      setBanner(buildErrorBanner(e, "Triggering manual fetch"));
    } finally {
      setSaving(null);
    }
  };

  const toggleTheme = () => {
    setTheme((current) => (current === "light" ? "dark" : "light"));
  };

  const streamLabel: Record<StreamStatus, string> = {
    connecting: "Connecting",
    connected: "Connected",
    reconnecting: "Reconnecting",
    disconnected: "Disconnected",
  };

  const lifecycleLabel = dataIsStale ? "Stale" : "Fresh";
  const isHelpFa = helpLang === "fa";
  const helpPanelTitle = isHelpFa ? "مرکز راهنما" : "Help Center";
  const helpPanelRight = isHelpFa
    ? "راهنمای کاربران جدید"
    : "Guide for new users";
  const helpIntro = isHelpFa
    ? "این بخش توضیح می‌دهد هر قسمت برنامه چه کاری انجام می‌دهد، داده‌ها چطور پردازش می‌شوند، و در هر وضعیت چه اقدام عملی باید انجام دهید."
    : "This section explains what each part of Gold Manager means, how data moves through the app, and what action to take when a status changes.";
  const helpSectionsAria = isHelpFa ? "بخش‌های راهنما" : "Help sections";
  const meaningLabel = isHelpFa ? "مفهوم" : "Meaning";
  const actionLabel = isHelpFa ? "اقدام" : "Action";

  const helpTabs: Array<{ id: HelpTab; label: string }> = [
    { id: "overview", label: isHelpFa ? "نمای کلی" : "Overview" },
    { id: "statuses", label: isHelpFa ? "وضعیت‌ها" : "Statuses" },
    { id: "flows", label: isHelpFa ? "جریان‌ها" : "Flows" },
    { id: "data", label: isHelpFa ? "داده و فرمول‌ها" : "Data & Formulas" },
  ];

  const streamLabelHelp: Record<StreamStatus, string> = isHelpFa
    ? {
        connecting: "در حال اتصال",
        connected: "متصل",
        reconnecting: "در حال تلاش مجدد",
        disconnected: "قطع",
      }
    : streamLabel;

  const lifecycleLabelHelp = isHelpFa
    ? dataIsStale
      ? "قدیمی"
      : "به‌روز"
    : lifecycleLabel;
  const adviceActionHelp = isHelpFa
    ? adviceAction === "BUY"
      ? "خرید"
      : adviceAction === "SELL"
        ? "فروش"
        : "نگه‌داری"
    : adviceAction;
  const thresholdHelpLabel = isHelpFa
    ? thresholdSummary.tone === "sell"
      ? "سیگنال در محدوده فروش است"
      : thresholdSummary.tone === "buy"
        ? "سیگنال در محدوده خرید است"
        : thresholdSummary.tone === "hold"
          ? "سیگنال در محدوده نگه‌داری است"
          : "داده آستانه کافی نیست"
    : thresholdSummary.label;
  const alertStateLabelHelp = isHelpFa
    ? !alertPrefs.enabled
      ? "متوقف"
      : ruleCount === 0
        ? "قانون فعالی ندارد"
        : `${ruleCount} قانون فعال`
    : alertStateLabel;
  const pushStatusLabelHelp = isHelpFa
    ? pushPermission === "granted"
      ? "اعلان فعال"
      : pushPermission === "unsupported"
        ? "اعلان پشتیبانی نمی‌شود"
        : pushPermission === "denied"
          ? "اعلان مسدود است"
          : "نیاز به مجوز اعلان"
    : pushStatusLabel;
  const draftStateHelp = isHelpFa
    ? hasUnsavedChanges
      ? "تغییرات ذخیره نشده"
      : "ذخیره شده"
    : hasUnsavedChanges
      ? "Unsaved changes"
      : "Saved";

  const statusGuide = [
    {
      key: "engine",
      label: isHelpFa ? "وضعیت موتور" : "Engine Status",
      current: isHelpFa
        ? state?.status === "running"
          ? "در حال اجرا"
          : state?.status === "error"
            ? "خطا"
            : state?.status === "idle"
              ? "بیکار"
              : "در حال بارگذاری"
        : (state?.status ?? "loading"),
      meaning: isHelpFa
        ? state?.status === "running"
          ? "جمع‌آوری داده و تصمیم‌گیری به شکل عادی در حال انجام است."
          : state?.status === "error"
            ? "حداقل یک مرحله دریافت یا پردازش داده با خطا مواجه شده است."
            : "موتور متوقف است یا هنوز شروع نشده است."
        : state?.status === "running"
          ? "Fetcher and decision engine are processing normally."
          : state?.status === "error"
            ? "At least one fetch/process step failed."
            : "Engine is idle or starting.",
      action: isHelpFa
        ? state?.status === "error"
          ? "تایم‌لاین و خطاها را بررسی کنید، سپس Fetch Now را بزنید."
          : "نیاز به اقدام خاصی نیست."
        : state?.status === "error"
          ? "Check Activity Timeline and Errors, then use Fetch Now."
          : "No action needed.",
    },
    {
      key: "stream",
      label: isHelpFa ? "استریم زنده" : "Live Stream",
      current: streamLabelHelp[streamStatus],
      meaning: isHelpFa
        ? streamStatus === "connected"
          ? "رابط کاربری در لحظه به‌روزرسانی دریافت می‌کند."
          : "ممکن است نمایش رابط کاربری موقتاً عقب‌تر از وضعیت واقعی باشد."
        : streamStatus === "connected"
          ? "UI is receiving live state updates."
          : "UI may be temporarily behind the backend state.",
      action: isHelpFa
        ? streamStatus === "connected"
          ? "نیاز به اقدام خاصی نیست."
          : "برای اتصال مجدد صبر کنید. اگر پایدار نشد صفحه را رفرش کنید."
        : streamStatus === "connected"
          ? "No action needed."
          : "Wait for reconnect, then refresh page if it remains disconnected.",
    },
    {
      key: "freshness",
      label: isHelpFa ? "تازگی داده" : "Data Freshness",
      current: isHelpFa
        ? `${lifecycleLabelHelp} (سن داده ${fmtDuration(dataAgeSec)})`
        : `${lifecycleLabelHelp} (age ${fmtDuration(dataAgeSec)})`,
      meaning: isHelpFa
        ? lifecycleLabelHelp === "به‌روز"
          ? "آخرین تیک بازار در بازه زمانی مورد انتظار دریافت شده است."
          : "از آخرین دریافت داده زمان بیشتری از حد انتظار گذشته است."
        : lifecycleLabelHelp === "Fresh"
          ? "Latest market tick is within expected interval."
          : "Last fetch is older than expected.",
      action: isHelpFa
        ? lifecycleLabelHelp === "به‌روز"
          ? "نیاز به اقدام خاصی نیست."
          : "Fetch Now را بزنید و اتصال شبکه/API را بررسی کنید."
        : lifecycleLabelHelp === "Fresh"
          ? "No action needed."
          : "Use Fetch Now and verify API/network access.",
    },
    {
      key: "advice",
      label: isHelpFa ? "پیشنهاد فعلی" : "Current Advice",
      current: `${adviceActionHelp} | ${thresholdHelpLabel}`,
      meaning:
        state?.decision.reason ??
        (isHelpFa ? "دلیل پیشنهاد هنوز آماده نیست." : "No advice reason yet."),
      action: isHelpFa
        ? adviceAction === "HOLD"
          ? "برای سیگنال قوی‌تر صبر کنید یا آستانه‌ها را تنظیم کنید."
          : "قبل از اقدام، با قوانین ریسک خودتان تطبیق دهید."
        : adviceAction === "HOLD"
          ? "Wait for stronger signal or adjust thresholds."
          : "Validate with your own risk rules before acting.",
    },
    {
      key: "alerts",
      label: isHelpFa ? "هشدارها" : "Alerts",
      current: `${alertStateLabelHelp} | ${pushStatusLabelHelp}`,
      meaning: isHelpFa
        ? alertPrefs.enabled && ruleCount > 0
          ? "قوانین هشدار برای نوسانات سریع فعال هستند."
          : "فعلاً قانون هشداری فعال نیست."
        : alertPrefs.enabled && ruleCount > 0
          ? "Alert rules are armed for fast fluctuations."
          : "No alert rule is currently active.",
      action: isHelpFa
        ? alertPrefs.enabled && ruleCount > 0
          ? "برای کنترل نویز، cooldown و min confidence را بازبینی کنید."
          : "در Alerts Center هشدار را فعال کنید و حداقل یک قانون بسازید."
        : alertPrefs.enabled && ruleCount > 0
          ? "Review cooldown and confidence to avoid noise."
          : "Enable alerts and at least one rule in Alerts Center.",
    },
    {
      key: "drafts",
      label: isHelpFa ? "تغییرات فرم" : "Draft Changes",
      current: draftStateHelp,
      meaning: isHelpFa
        ? hasUnsavedChanges
          ? "تنظیمات یا پرتفوی ویرایش شده‌اند اما هنوز اعمال نشده‌اند."
          : "فرم‌ها با وضعیت ذخیره‌شده همگام هستند."
        : hasUnsavedChanges
          ? "Portfolio or settings have local edits not applied to engine."
          : "Forms match backend state.",
      action: isHelpFa
        ? hasUnsavedChanges
          ? "از دکمه Save یا Reset Draft استفاده کنید."
          : "نیاز به اقدام خاصی نیست."
        : hasUnsavedChanges
          ? "Use Save or Reset Draft buttons."
          : "No action needed.",
    },
  ];

  const quickStartTitle = isHelpFa ? "شروع سریع" : "Quick Start";
  const quickStartSteps = isHelpFa
    ? [
        "پرتفوی را با موجودی نقد، گرم طلا، میانگین خرید و کارمزدها پر کنید.",
        "تنظیمات استراتژی را مشخص کنید، مخصوصا horizon و thresholdها.",
        "منتظر داده تازه بمانید یا برای دریافت فوری از Fetch Now استفاده کنید.",
        "پیشنهاد فعلی را بخوانید و با مدیریت ریسک خودتان تطبیق دهید.",
        "برای از دست ندادن نوسان‌های سریع، هشدارها را فعال کنید.",
      ]
    : [
        "Fill Portfolio with your cash, grams, average buy, and fees.",
        "Configure Strategy Settings (especially horizon and thresholds).",
        "Wait for fresh data or use Fetch Now for an immediate tick.",
        "Read Current Advice, then validate with your own risk rules.",
        "Enable alerts so fast fluctuations are not missed.",
      ];

  const featureMapTitle = isHelpFa ? "نقشه قابلیت‌ها" : "Feature Map";
  const featureGuide = isHelpFa
    ? [
        "کارت‌های اصلی: نمای سریع از پیشنهاد، قیمت لحظه‌ای و قدرت سیگنال.",
        "نمودار قیمت: مسیر اخیر قیمت به‌همراه بازه پیش‌بینی و توقف مورد انتظار.",
        "کیفیت مدل: روند hit-rate و Brier برای اعتبار پیش‌بینی.",
        "زون‌های قیمت: محدوده‌های سناریوی صعودی/نزولی در افق زمانی انتخابی.",
        "تحلیل پرتفوی: ارزش‌گذاری با کارمزد، سر‌به‌سر و توان خرید گرم.",
        "تایم‌لاین فعالیت: آخرین لاگ‌ها و خطاها به ترتیب زمانی.",
        "مرکز هشدار: هشدار سیگنال و عبور قیمت با اعلان/صدا.",
        "برنامه‌ریز سریع معامله: اثر خرید/فروش فرضی قبل از اقدام.",
        "فرم پرتفوی: نقدینگی، موجودی طلا، قیمت خرید میانگین و کارمزدها.",
        "تنظیمات استراتژی: بازه دریافت، افق پیش‌بینی، آستانه‌ها و محدودیت‌ها.",
      ]
    : [
        "Hero cards: fast snapshot of advice, current price, and signal strength.",
        "Live Price chart: recent price path plus predicted range and expected stop.",
        "Model Quality: hit-rate and Brier calibration trend.",
        "Price Zones: up/down scenario ranges for horizon-based planning.",
        "Portfolio Analytics: fee-aware valuation, break-even, and affordable grams.",
        "Activity Timeline: recent logs/errors in chronological order.",
        "Alerts Center: signal and price-crossing alerts with push/sound options.",
        "Quick Trade Planner: what-if buy/sell impact before taking action.",
        "Portfolio form: your cash, holdings, average entry, and fees.",
        "Strategy Settings: polling, horizon, thresholds, confidence, and retention controls.",
      ];

  const flowGuide = isHelpFa
    ? [
        {
          title: "جریان داده بازار",
          detail:
            "1) برنامه داده Talasea و TGJU را دریافت می‌کند. 2) مقادیر به تومان نرمال می‌شوند. 3) اسنپ‌شات ذخیره و به تاریخچه اضافه می‌شود.",
        },
        {
          title: "جریان سیگنال و تصمیم",
          detail:
            "1) موتور شاخص‌های مومنتوم، واگرایی و نوسان را می‌سازد. 2) امتیاز را به P(up) و confidence تبدیل می‌کند. 3) زون‌ها را می‌سازد و با درنظر گرفتن کارمزد و cooldown تصمیم BUY/SELL/HOLD می‌گیرد.",
        },
        {
          title: "جریان پرتفوی",
          detail:
            "1) اطلاعات پرتفوی محدودیت‌های واقعی شما را تعیین می‌کند. 2) ارزش فروش، سود/زیان پس از کارمزد و قیمت سربه‌سر محاسبه می‌شود. 3) پیشنهاد نهایی با موجودی نقد و طلا فیلتر می‌شود.",
        },
        {
          title: "جریان هشدار",
          detail:
            "1) تیک جدید می‌رسد. 2) قوانین عبور قیمت یا تغییر سیگنال بررسی می‌شوند. 3) اگر شرط confidence و cooldown برقرار باشد، هشدار ثبت و در صورت فعال بودن به مرورگر ارسال می‌شود.",
        },
      ]
    : [
        {
          title: "Market Data Flow",
          detail:
            "1) App fetches Talasea + TGJU data. 2) Values are normalized to toman. 3) Snapshot is stored and added to history.",
        },
        {
          title: "Signal & Decision Flow",
          detail:
            "1) Engine computes momentum, divergence, and volatility features. 2) Converts score to P(up) and confidence. 3) Builds zones and selects BUY/SELL/HOLD with fee and cooldown checks.",
        },
        {
          title: "Portfolio Flow",
          detail:
            "1) Profile inputs define your real constraints. 2) Engine computes liquidation value, PnL after fees, and break-even. 3) Advice is filtered by cash/holding availability.",
        },
        {
          title: "Alert Flow",
          detail:
            "1) New tick arrives. 2) Rules evaluate action transitions and price crossings. 3) If conditions pass confidence and cooldown, alert is logged and optionally pushed to browser.",
        },
      ];

  const dataGlossaryTitle = isHelpFa ? "واژه‌نامه داده‌ها" : "Data Glossary";
  const dataGlossary = isHelpFa
    ? [
        "تمام مقادیر پولی در برنامه به تومان نمایش داده می‌شود.",
        "P(up): احتمال اینکه قیمت در پایان افق زمانی بالاتر باشد.",
        "Confidence: میزان اتکا به سیگنال فعلی (بین 0 تا 1).",
        "Score: امتیاز خام مدل قبل از تبدیل سیگموید.",
        "Range Width / Volatility: اندازه دامنه حرکت مورد انتظار.",
        "Expected Stop: مرکز محتمل‌ترین محدوده توقف با توجه به سیگنال فعلی.",
        "Buy/Sell Edge: مزیت مورد انتظار اقدام فعلی با لحاظ کارمزد.",
        "Mean Brier: خطای کالیبراسیون احتمال (هرچه کمتر بهتر).",
        "Hit Rate: دقت جهت حرکت در پیش‌بینی‌های حل‌شده.",
      ]
    : [
        "All monetary values are shown in toman.",
        "P(up): estimated probability price will be higher at horizon end.",
        "Confidence: reliability of current signal (0 to 1).",
        "Score: raw model score before sigmoid conversion.",
        "Range Width / Volatility: expected movement envelope size.",
        "Expected Stop: center of most likely stop zone based on current signal.",
        "Buy/Sell Edge: fee-aware expected advantage of acting now.",
        "Mean Brier: probability calibration error (lower is better).",
        "Hit Rate: directional accuracy on resolved predictions.",
      ];

  const importantNotesTitle = isHelpFa ? "نکات مهم" : "Important Notes";
  const importantNote1 = isHelpFa
    ? "پیشنهادها کمکی هستند و تضمین نتیجه نیستند. آستانه‌ها و confidence میزان تهاجمی بودن تصمیم‌ها را کنترل می‌کنند."
    : "Advice is model-assisted and should be treated as decision support, not guaranteed outcome. Thresholds and confidence control how aggressive the app becomes.";
  const importantNote2 = isHelpFa
    ? "اگر وضعیت‌ها داده قدیمی یا قطع اتصال را نشان می‌دهند، تا زمان به‌روز شدن و اتصال پایدار از اقدام خودداری کنید."
    : "If statuses show stale data or disconnections, avoid acting until data returns to fresh and connected.";
  return (
    <main className="page">
      <header className="topbar">
        <h1 className="brandTitle">
          <span className="brandMark" aria-hidden="true" />
          Gold Manager
        </h1>
        <div className="statusWrap">
          <button className="themeToggle" onClick={toggleTheme}>
            Theme: {theme === "light" ? "Light" : "Dark"}
          </button>
          <span className={`pill ${state?.status ?? "idle"}`}>
            {state?.status ?? "loading"}
          </span>
          <span className={`streamPill ${streamStatus}`}>
            {streamLabel[streamStatus]}
          </span>
          <button onClick={triggerFetch} disabled={saving === "fetch"}>
            Fetch Now
          </button>
        </div>
      </header>

      <section className="opsStrip" aria-label="System status">
        <span className={`opsChip ${dataIsStale ? "warn" : "ok"}`}>
          Data: {lifecycleLabel}
        </span>
        <span className="opsChip">Data age: {fmtDuration(dataAgeSec)}</span>
        <span className="opsChip">
          Next fetch: {fmtDuration(nextFetchInSec)}
        </span>
        <span className="opsChip">
          Last stream:{" "}
          {lastStreamEventAt ? fmtTimeShort(lastStreamEventAt) : "--"}
        </span>
        <span className={`opsChip ${hasUnsavedChanges ? "warn" : "ok"}`}>
          Drafts: {hasUnsavedChanges ? "Unsaved changes" : "Saved"}
        </span>
        <span className="opsChip">Alerts: {alertStateLabel}</span>
      </section>

      {banner ? (
        <div className={`banner ${banner.tone}`} role="alert">
          <strong>{banner.title}</strong>
          <span>{banner.detail}</span>
        </div>
      ) : null}

      <section className="grid heroStats">
        <MetricCard
          label="Current Advice"
          loading={isLoading}
          className="heroCard"
          valueClassName="heroBody"
          value={
            <>
              <div className="heroValueRow">
                <span className={`adviceBadge ${adviceAction.toLowerCase()}`}>
                  {adviceAction}
                </span>
                <span className="heroSubtle">
                  {fmtPct(state?.signal?.confidence, 1)} confidence
                </span>
              </div>
              <p className="heroReason">{state?.decision.reason ?? "--"}</p>
              <div className="edgeRow">
                <span className="edgeChip">
                  Buy edge: {fmtPct(state?.decision.buyEdgePct, 2)}
                </span>
                <span className="edgeChip">
                  Sell edge: {fmtPct(state?.decision.sellEdgePct, 2)}
                </span>
              </div>
            </>
          }
        />

        <MetricCard
          label="Gold Price"
          loading={isLoading}
          className="heroCard"
          value={<span className="heroValue">{fmtNumber(latestPrice, 0)}</span>}
          hint={`Last update ${state?.lastFetchAt ? fmtTimeShort(state.lastFetchAt) : "--"}`}
        />

        <MetricCard
          label="Signal Snapshot"
          loading={isLoading}
          className="heroCard"
          valueClassName="heroBody"
          value={
            <div className="signalSplit">
              <div>
                <p className="signalLabel">P(up)</p>
                <span className="signalValue">
                  {fmtPct(state?.signal?.pUp, 1)}
                </span>
              </div>
              <div>
                <p className="signalLabel">Score</p>
                <span className="signalValue">
                  {fmtNumber(state?.signal?.score, 2)}
                </span>
              </div>
            </div>
          }
        />
      </section>

      <section className="grid cards secondaryStats">
        <MetricCard
          label="Expected Stop"
          loading={isLoading}
          value={fmtNumber(state?.zones?.expectedStop, 0)}
        />
        <MetricCard
          label="Net PnL"
          loading={isLoading}
          value={`${fmtNumber(state?.portfolioStats?.netPnlAfterFees, 0)} (${fmtPct(state?.portfolioStats?.netPnlPct, 2)})`}
        />
        <MetricCard
          label="Range Width"
          loading={isLoading}
          value={fmtPct(state?.zones?.rangePct, 2)}
        />
        <MetricCard
          label="History Points"
          loading={isLoading}
          value={fmtNumber(state?.historyPoints, 0)}
        />
      </section>

      <Panel
        title="Live Price"
        right={
          state?.lastFetchAt
            ? new Date(state.lastFetchAt).toLocaleString()
            : "--"
        }
      >
        {chartModel ? (
          <>
            <svg
              viewBox={`0 0 ${chartModel.width} ${chartModel.height}`}
              className="chart"
              role="img"
              aria-label="Gold price chart with range and expected stop"
            >
              <g>
                {chartModel.yTicks.map((tick, index) => (
                  <line
                    key={`grid-${index}`}
                    x1={58}
                    y1={tick.y}
                    x2={chartModel.width - 16}
                    y2={tick.y}
                    className="chartGridLine"
                  />
                ))}
              </g>
              {chartModel.rangeBand ? (
                <rect
                  x={58}
                  y={Math.min(
                    chartModel.rangeBand.topY,
                    chartModel.rangeBand.bottomY,
                  )}
                  width={chartModel.width - 74}
                  height={Math.abs(
                    chartModel.rangeBand.bottomY - chartModel.rangeBand.topY,
                  )}
                  className="chartBand"
                />
              ) : null}
              {chartModel.expectedY != null ? (
                <line
                  x1={58}
                  y1={chartModel.expectedY}
                  x2={chartModel.width - 16}
                  y2={chartModel.expectedY}
                  className="chartExpectedLine"
                />
              ) : null}
              <path d={chartModel.path} className="line" />
              <circle
                cx={chartModel.latest.x}
                cy={chartModel.latest.y}
                r={3.8}
                className="chartLatestDot"
              />
              {chartModel.yTicks.map((tick, index) => (
                <text
                  key={`y-label-${index}`}
                  x={50}
                  y={tick.y + 4}
                  textAnchor="end"
                  className="chartAxisText"
                >
                  {fmtNumber(tick.value, 0)}
                </text>
              ))}
              {chartModel.xTicks.map((tick, index) => (
                <text
                  key={`x-label-${index}`}
                  x={tick.x}
                  y={chartModel.height - 8}
                  textAnchor="middle"
                  className="chartAxisText"
                >
                  {tick.label}
                </text>
              ))}
            </svg>
            <div className="chartLegend">
              <span>
                <span className="legendSwatch live" /> Live price
              </span>
              <span>
                <span className="legendSwatch expected" /> Expected stop
              </span>
              <span>
                <span className="legendSwatch range" /> Predicted range band
              </span>
            </div>
          </>
        ) : (
          <div className="chartEmpty">
            {isLoading
              ? "Loading live feed and chart data..."
              : "No chart points yet. Wait for next poll or click Fetch Now."}
          </div>
        )}
      </Panel>

      <section className="grid twoCol">
        <Panel title="Alerts Center" right={pushStatusLabel}>
          <div className="alertControlGrid">
            <label className="toggleRow">
              <input
                type="checkbox"
                checked={alertPrefs.enabled}
                onChange={(e) =>
                  setAlertPrefs((p) => ({
                    ...p,
                    enabled: e.target.checked,
                  }))
                }
              />
              <span>Enable all alerts</span>
            </label>
            <label className="toggleRow">
              <input
                type="checkbox"
                checked={alertPrefs.systemPush}
                onChange={(e) =>
                  setAlertPrefs((p) => ({
                    ...p,
                    systemPush: e.target.checked,
                  }))
                }
              />
              <span>Use browser push alerts</span>
            </label>
            <label className="toggleRow">
              <input
                type="checkbox"
                checked={alertPrefs.playSound}
                onChange={(e) =>
                  setAlertPrefs((p) => ({
                    ...p,
                    playSound: e.target.checked,
                  }))
                }
              />
              <span>Play sound on alert</span>
            </label>
            <label className="toggleRow">
              <input
                type="checkbox"
                checked={alertPrefs.buySellSignals}
                onChange={(e) =>
                  setAlertPrefs((p) => ({
                    ...p,
                    buySellSignals: e.target.checked,
                  }))
                }
              />
              <span>Alert on BUY/SELL signal changes</span>
            </label>
            <label className="toggleRow">
              <input
                type="checkbox"
                checked={alertPrefs.priceCrossing}
                onChange={(e) =>
                  setAlertPrefs((p) => ({
                    ...p,
                    priceCrossing: e.target.checked,
                  }))
                }
              />
              <span>Alert on price crossing trigger</span>
            </label>
            <div className="inlineField">
              <label className="fieldLabel" htmlFor="alertDirection">
                Direction
              </label>
              <select
                id="alertDirection"
                value={alertPrefs.crossDirection}
                onChange={(e) =>
                  setAlertPrefs((p) => ({
                    ...p,
                    crossDirection:
                      e.target.value === "below" ? "below" : "above",
                  }))
                }
              >
                <option value="above">Crossing above</option>
                <option value="below">Crossing below</option>
              </select>
            </div>
            <div className="inlineField">
              <label className="fieldLabel" htmlFor="alertCrossPrice">
                Target Price
              </label>
              <input
                id="alertCrossPrice"
                type="number"
                min="0"
                value={toInputValue(alertPrefs.crossPrice)}
                onChange={(e) =>
                  setAlertPrefs((p) => {
                    const next = parseNumberInput(e.target.value);
                    return {
                      ...p,
                      crossPrice: Number.isFinite(next) ? Math.max(0, next) : 0,
                    };
                  })
                }
              />
            </div>
            <div className="inlineField">
              <label className="fieldLabel" htmlFor="alertMinConfidence">
                Min Confidence
              </label>
              <input
                id="alertMinConfidence"
                type="number"
                step="0.01"
                min="0"
                max="1"
                value={toInputValue(alertPrefs.minConfidence)}
                onChange={(e) =>
                  setAlertPrefs((p) => {
                    const next = parseNumberInput(e.target.value);
                    return {
                      ...p,
                      minConfidence: Number.isFinite(next) ? clamp01(next) : 0,
                    };
                  })
                }
              />
            </div>
            <div className="inlineField">
              <label className="fieldLabel" htmlFor="alertCooldown">
                Cooldown (sec)
              </label>
              <input
                id="alertCooldown"
                type="number"
                min="0"
                value={toInputValue(alertPrefs.minGapSec)}
                onChange={(e) =>
                  setAlertPrefs((p) => {
                    const next = parseNumberInput(e.target.value);
                    return {
                      ...p,
                      minGapSec: Number.isFinite(next)
                        ? Math.max(0, Math.round(next))
                        : 0,
                    };
                  })
                }
              />
            </div>
          </div>
          <div className="actions splitActions">
            <button
              className="buttonSecondary"
              onClick={requestNotificationPermission}
              disabled={pushPermission === "unsupported"}
            >
              Allow Push
            </button>
            <button
              className="buttonSecondary"
              onClick={() => setAlertEvents([])}
              disabled={!alertEvents.length}
            >
              Clear Alerts
            </button>
          </div>
          <ul className="alertList">
            {alertEvents.length ? (
              alertEvents.map((item) => (
                <li key={item.id} className={`alertItem ${item.tone}`}>
                  <div className="alertItemHead">
                    <strong>{item.title}</strong>
                    <small>{new Date(item.t).toLocaleTimeString()}</small>
                  </div>
                  <p>{item.detail}</p>
                </li>
              ))
            ) : (
              <li className="emptyListItem">
                No alerts yet. Rules are armed and listening.
              </li>
            )}
          </ul>
        </Panel>

        <Panel
          title="Quick Trade Planner"
          right={tradePreview?.valid ? "Ready" : "Check values"}
        >
          <div className="plannerControls">
            <div className="segSwitch" role="tablist" aria-label="Trade mode">
              <button
                className={`segBtn ${tradeMode === "buy" ? "active" : ""}`}
                onClick={() => setTradeMode("buy")}
              >
                Buy
              </button>
              <button
                className={`segBtn ${tradeMode === "sell" ? "active" : ""}`}
                onClick={() => setTradeMode("sell")}
              >
                Sell
              </button>
            </div>
            <div className="inlineField">
              <label className="fieldLabel" htmlFor="tradeGrams">
                Grams
              </label>
              <input
                id="tradeGrams"
                type="number"
                step="0.001"
                min="0"
                value={tradeGramsInput}
                onChange={(e) => setTradeGramsInput(e.target.value)}
              />
            </div>
            <div className="quickRow">
              {[0.5, 1, 2, 5].map((g) => (
                <button
                  key={g}
                  className="chipBtn"
                  onClick={() => setTradeGramsInput(String(g))}
                >
                  {g}g
                </button>
              ))}
              <button
                className="chipBtn"
                onClick={() =>
                  setTradeGramsInput(
                    String(
                      tradeMode === "buy"
                        ? Math.max(
                            0,
                            state?.portfolioStats?.affordableGrams ?? 0,
                          )
                        : Math.max(0, profileDraft?.goldGrams ?? 0),
                    ),
                  )
                }
              >
                Max
              </button>
            </div>
          </div>
          {tradePreview ? (
            <>
              <dl className="kvList plannerKv">
                <div>
                  <dt>Gross Value</dt>
                  <dd>{fmtNumber(tradePreview.grossValue, 0)}</dd>
                </div>
                <div>
                  <dt>Fee Estimate</dt>
                  <dd>{fmtNumber(tradePreview.feeValue, 0)}</dd>
                </div>
                <div>
                  <dt>Net Cash Move</dt>
                  <dd>
                    {fmtSigned(
                      tradePreview.mode === "buy"
                        ? -tradePreview.netValue
                        : tradePreview.netValue,
                      0,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Cash After</dt>
                  <dd>{fmtNumber(tradePreview.cashAfter, 0)}</dd>
                </div>
                <div>
                  <dt>Gold After</dt>
                  <dd>{fmtNumber(tradePreview.goldAfter, 4)} g</dd>
                </div>
                <div>
                  <dt>Break-even After</dt>
                  <dd>{fmtNumber(tradePreview.breakEvenAfter, 0)}</dd>
                </div>
              </dl>
              <div
                className={`plannerIssue ${tradePreview.valid ? "ok" : "error"}`}
              >
                {tradePreview.valid
                  ? `${tradePreview.mode.toUpperCase()} plan clears inventory checks.`
                  : tradePreview.issue}
              </div>
            </>
          ) : (
            <div className="emptyListItem">
              Waiting for profile and live price data.
            </div>
          )}
        </Panel>
      </section>

      <section className="grid twoCol">
        <Panel
          title="Model Quality"
          right={
            totalPredictions > 0
              ? `${fmtNumber(totalPredictions, 0)} resolved`
              : "Calibrating"
          }
        >
          <div className="insightGrid">
            <MetricCard
              label="Hit Rate"
              loading={isLoading}
              value={fmtPct(hitRate, 2)}
              hint={`${fmtNumber(state?.metrics.correct ?? null, 0)} correct`}
            />
            <MetricCard
              label="Mean Brier"
              loading={isLoading}
              value={fmtNumber(meanBrier, 3)}
              hint="Lower is better"
            />
            <MetricCard
              label="Reliability"
              loading={isLoading}
              value={reliability.label}
              hint={reliability.detail}
            />
            <MetricCard
              label="Feature Freshness"
              loading={isLoading}
              value={fmtPct(state?.signal?.freshness, 1)}
              hint={`${fmtNumber(state?.signal?.freshFields, 0)}/${fmtNumber(state?.signal?.totalFields, 0)} fresh`}
            />
          </div>
        </Panel>

        <Panel
          title="Price Zones"
          right={state?.zones ? "30m horizon zone map" : "--"}
        >
          <dl className="kvList">
            <div>
              <dt>Up Range</dt>
              <dd>
                {fmtNumber(state?.zones?.upLow, 0)} to{" "}
                {fmtNumber(state?.zones?.upHigh, 0)}
              </dd>
            </div>
            <div>
              <dt>Down Range</dt>
              <dd>
                {fmtNumber(state?.zones?.downLow, 0)} to{" "}
                {fmtNumber(state?.zones?.downHigh, 0)}
              </dd>
            </div>
            <div>
              <dt>Expected Stop</dt>
              <dd>{fmtNumber(state?.zones?.expectedStop, 0)}</dd>
            </div>
            <div>
              <dt>Drift Bias</dt>
              <dd>{fmtPct(state?.zones?.driftPct, 2)}</dd>
            </div>
            <div>
              <dt>Volatility Range</dt>
              <dd>{fmtPct(state?.zones?.rangePct, 2)}</dd>
            </div>
          </dl>
        </Panel>
      </section>

      <section className="grid twoCol">
        <Panel
          title="Portfolio Analytics"
          right={state?.portfolioStats ? "Fee-aware valuation" : "--"}
        >
          <div className="insightGrid">
            <MetricCard
              label="Break-even Sell"
              loading={isLoading}
              value={fmtNumber(state?.portfolioStats?.breakEvenSellPrice, 0)}
            />
            <MetricCard
              label="Liquidation Value"
              loading={isLoading}
              value={fmtNumber(
                state?.portfolioStats?.portfolioLiquidationValue,
                0,
              )}
            />
            <MetricCard
              label="Basis w/ Buy Fee"
              loading={isLoading}
              value={fmtNumber(state?.portfolioStats?.basisWithBuyFee, 0)}
            />
            <MetricCard
              label="Affordable Gold"
              loading={isLoading}
              value={`${fmtNumber(state?.portfolioStats?.affordableGrams, 4)} g`}
            />
            <MetricCard
              label="Buy Cost / g"
              loading={isLoading}
              value={fmtNumber(state?.portfolioStats?.costPerGramBuy, 0)}
            />
            <MetricCard
              label="Sell Proceeds / g"
              loading={isLoading}
              value={fmtNumber(state?.portfolioStats?.proceedsPerGramSell, 0)}
            />
          </div>
        </Panel>

        <Panel
          title="Activity Timeline"
          right={
            timelineItems.length ? `${timelineItems.length} entries` : "--"
          }
        >
          <ul className="timelineList">
            {timelineItems.length ? (
              timelineItems.map((item) => (
                <li key={item.id} className={`timelineItem ${item.kind}`}>
                  <span className={`timelineTag ${item.kind}`}>
                    {item.kind === "error" ? "ERROR" : "LOG"}
                  </span>
                  <span className="timelineText">
                    <small className="timelineTime">{item.timeLabel}</small>
                    {item.text}
                  </span>
                </li>
              ))
            ) : (
              <li className="emptyListItem">
                {isLoading ? "Loading timeline..." : "No timeline events yet."}
              </li>
            )}
          </ul>
        </Panel>
      </section>

      <section className="grid twoCol">
        <Panel title="Portfolio">
          <div className="formGrid">
            <div className="field">
              <label className="fieldLabel" htmlFor="cashIrr">
                Cash (IRR)
              </label>
              <input
                id="cashIrr"
                type="number"
                className={profileErrors.cashIrr ? "invalid" : ""}
                aria-invalid={Boolean(profileErrors.cashIrr)}
                aria-describedby="cashIrr-hint"
                value={toInputValue(profileDraft?.cashIrr)}
                onChange={(e) =>
                  setProfileDraft((p) =>
                    p ? { ...p, cashIrr: parseNumberInput(e.target.value) } : p,
                  )
                }
              />
              <small
                id="cashIrr-hint"
                className={`fieldHint ${profileErrors.cashIrr ? "error" : ""}`}
              >
                {profileErrors.cashIrr ?? "Minimum: 0"}
              </small>
            </div>

            <div className="field">
              <label className="fieldLabel" htmlFor="goldGrams">
                Gold (grams)
              </label>
              <input
                id="goldGrams"
                type="number"
                step="0.0001"
                className={profileErrors.goldGrams ? "invalid" : ""}
                aria-invalid={Boolean(profileErrors.goldGrams)}
                aria-describedby="goldGrams-hint"
                value={toInputValue(profileDraft?.goldGrams)}
                onChange={(e) =>
                  setProfileDraft((p) =>
                    p
                      ? { ...p, goldGrams: parseNumberInput(e.target.value) }
                      : p,
                  )
                }
              />
              <small
                id="goldGrams-hint"
                className={`fieldHint ${profileErrors.goldGrams ? "error" : ""}`}
              >
                {profileErrors.goldGrams ?? "Minimum: 0"}
              </small>
            </div>

            <div className="field">
              <label className="fieldLabel" htmlFor="avgBuyPrice">
                Avg Buy Price
              </label>
              <input
                id="avgBuyPrice"
                type="number"
                className={profileErrors.avgBuyPrice ? "invalid" : ""}
                aria-invalid={Boolean(profileErrors.avgBuyPrice)}
                aria-describedby="avgBuyPrice-hint"
                value={toInputValue(profileDraft?.avgBuyPrice)}
                onChange={(e) =>
                  setProfileDraft((p) =>
                    p
                      ? { ...p, avgBuyPrice: parseNumberInput(e.target.value) }
                      : p,
                  )
                }
              />
              <small
                id="avgBuyPrice-hint"
                className={`fieldHint ${profileErrors.avgBuyPrice ? "error" : ""}`}
              >
                {profileErrors.avgBuyPrice ?? "Minimum: 0"}
              </small>
            </div>

            <div className="field">
              <label className="fieldLabel" htmlFor="buyFeePct">
                Buy Fee %
              </label>
              <input
                id="buyFeePct"
                type="number"
                step="0.01"
                className={profileErrors.buyFeePct ? "invalid" : ""}
                aria-invalid={Boolean(profileErrors.buyFeePct)}
                aria-describedby="buyFeePct-hint"
                value={toInputValue(
                  (profileDraft?.buyFeePct ?? Number.NaN) * 100,
                )}
                onChange={(e) =>
                  setProfileDraft((p) =>
                    p
                      ? {
                          ...p,
                          buyFeePct: parseNumberInput(e.target.value) / 100,
                        }
                      : p,
                  )
                }
              />
              <small
                id="buyFeePct-hint"
                className={`fieldHint ${profileErrors.buyFeePct ? "error" : ""}`}
              >
                {profileErrors.buyFeePct ?? "Range: 0% to 20%"}
              </small>
            </div>

            <div className="field">
              <label className="fieldLabel" htmlFor="sellFeePct">
                Sell Fee %
              </label>
              <input
                id="sellFeePct"
                type="number"
                step="0.01"
                className={profileErrors.sellFeePct ? "invalid" : ""}
                aria-invalid={Boolean(profileErrors.sellFeePct)}
                aria-describedby="sellFeePct-hint"
                value={toInputValue(
                  (profileDraft?.sellFeePct ?? Number.NaN) * 100,
                )}
                onChange={(e) =>
                  setProfileDraft((p) =>
                    p
                      ? {
                          ...p,
                          sellFeePct: parseNumberInput(e.target.value) / 100,
                        }
                      : p,
                  )
                }
              />
              <small
                id="sellFeePct-hint"
                className={`fieldHint ${profileErrors.sellFeePct ? "error" : ""}`}
              >
                {profileErrors.sellFeePct ?? "Range: 0% to 20%"}
              </small>
            </div>
          </div>
          <div className="actions">
            <button
              className="buttonSecondary"
              onClick={resetProfileDraft}
              disabled={!profileDirty || saving === "profile"}
            >
              Reset Draft
            </button>
            <button
              onClick={saveProfile}
              disabled={
                saving === "profile" ||
                profileHasErrors ||
                !profileDraft ||
                !profileDirty
              }
            >
              {saving === "profile"
                ? "Saving..."
                : profileDirty
                  ? "Save Portfolio"
                  : "Saved"}
            </button>
          </div>
        </Panel>

        <Panel title="Strategy Settings" right={thresholdSummary.label}>
          <div className={`thresholdGuide ${thresholdSummary.tone}`}>
            <div className="thresholdTrack">
              <div
                className="zoneSell"
                style={{ width: `${sellThresholdPct}%` }}
              />
              <div
                className="zoneHold"
                style={{
                  left: `${sellThresholdPct}%`,
                  width: `${holdZoneWidthPct}%`,
                }}
              />
              <div
                className="zoneBuy"
                style={{
                  left: `${buyThresholdPct}%`,
                  width: `${100 - buyThresholdPct}%`,
                }}
              />
              <span
                className="thresholdMarker sell"
                style={{ left: `${sellThresholdPct}%` }}
              />
              <span
                className="thresholdMarker buy"
                style={{ left: `${buyThresholdPct}%` }}
              />
              <span
                className="thresholdMarker current"
                style={{ left: `${pUpPct}%` }}
              />
            </div>
            <div className="thresholdLabels">
              <span>
                SELL {"<="} {fmtPct(settingsDraft?.sellThreshold, 2)}
              </span>
              <span>P(up): {fmtPct(state?.signal?.pUp, 2)}</span>
              <span>
                BUY {">="} {fmtPct(settingsDraft?.buyThreshold, 2)}
              </span>
            </div>
          </div>
          <div className="formGrid">
            <div className="field">
              <label className="fieldLabel" htmlFor="pollIntervalMs">
                Poll (ms)
              </label>
              <input
                id="pollIntervalMs"
                type="number"
                className={settingsErrors.pollIntervalMs ? "invalid" : ""}
                aria-invalid={Boolean(settingsErrors.pollIntervalMs)}
                aria-describedby="pollIntervalMs-hint"
                value={toInputValue(settingsDraft?.pollIntervalMs)}
                onChange={(e) =>
                  setSettingsDraft((s) =>
                    s
                      ? {
                          ...s,
                          pollIntervalMs: parseNumberInput(e.target.value),
                        }
                      : s,
                  )
                }
              />
              <small
                id="pollIntervalMs-hint"
                className={`fieldHint ${settingsErrors.pollIntervalMs ? "error" : ""}`}
              >
                {settingsErrors.pollIntervalMs ??
                  "Range: 10,000 to 3,600,000 ms"}
              </small>
            </div>

            <div className="field">
              <label className="fieldLabel" htmlFor="predictionHorizonMin">
                Horizon (min)
              </label>
              <input
                id="predictionHorizonMin"
                type="number"
                className={settingsErrors.predictionHorizonMin ? "invalid" : ""}
                aria-invalid={Boolean(settingsErrors.predictionHorizonMin)}
                aria-describedby="predictionHorizonMin-hint"
                value={toInputValue(settingsDraft?.predictionHorizonMin)}
                onChange={(e) =>
                  setSettingsDraft((s) =>
                    s
                      ? {
                          ...s,
                          predictionHorizonMin: parseNumberInput(
                            e.target.value,
                          ),
                        }
                      : s,
                  )
                }
              />
              <small
                id="predictionHorizonMin-hint"
                className={`fieldHint ${settingsErrors.predictionHorizonMin ? "error" : ""}`}
              >
                {settingsErrors.predictionHorizonMin ?? "Range: 5 to 1,440 min"}
              </small>
            </div>

            <div className="field">
              <label className="fieldLabel" htmlFor="freshnessMaxMin">
                Freshness (min)
              </label>
              <input
                id="freshnessMaxMin"
                type="number"
                className={settingsErrors.freshnessMaxMin ? "invalid" : ""}
                aria-invalid={Boolean(settingsErrors.freshnessMaxMin)}
                aria-describedby="freshnessMaxMin-hint"
                value={toInputValue(settingsDraft?.freshnessMaxMin)}
                onChange={(e) =>
                  setSettingsDraft((s) =>
                    s
                      ? {
                          ...s,
                          freshnessMaxMin: parseNumberInput(e.target.value),
                        }
                      : s,
                  )
                }
              />
              <small
                id="freshnessMaxMin-hint"
                className={`fieldHint ${settingsErrors.freshnessMaxMin ? "error" : ""}`}
              >
                {settingsErrors.freshnessMaxMin ?? "Range: 15 to 1,440 min"}
              </small>
            </div>

            <div className="field">
              <label className="fieldLabel" htmlFor="buyThreshold">
                BUY Threshold
              </label>
              <input
                id="buyThreshold"
                type="number"
                step="0.01"
                className={settingsErrors.buyThreshold ? "invalid" : ""}
                aria-invalid={Boolean(settingsErrors.buyThreshold)}
                aria-describedby="buyThreshold-hint"
                value={toInputValue(settingsDraft?.buyThreshold)}
                onChange={(e) =>
                  setSettingsDraft((s) =>
                    s
                      ? { ...s, buyThreshold: parseNumberInput(e.target.value) }
                      : s,
                  )
                }
              />
              <small
                id="buyThreshold-hint"
                className={`fieldHint ${settingsErrors.buyThreshold ? "error" : ""}`}
              >
                {settingsErrors.buyThreshold ??
                  "Range: 0.01 to 0.99 and must be above SELL"}
              </small>
            </div>

            <div className="field">
              <label className="fieldLabel" htmlFor="sellThreshold">
                SELL Threshold
              </label>
              <input
                id="sellThreshold"
                type="number"
                step="0.01"
                className={settingsErrors.sellThreshold ? "invalid" : ""}
                aria-invalid={Boolean(settingsErrors.sellThreshold)}
                aria-describedby="sellThreshold-hint"
                value={toInputValue(settingsDraft?.sellThreshold)}
                onChange={(e) =>
                  setSettingsDraft((s) =>
                    s
                      ? {
                          ...s,
                          sellThreshold: parseNumberInput(e.target.value),
                        }
                      : s,
                  )
                }
              />
              <small
                id="sellThreshold-hint"
                className={`fieldHint ${settingsErrors.sellThreshold ? "error" : ""}`}
              >
                {settingsErrors.sellThreshold ??
                  "Range: 0.01 to 0.99 and must be below BUY"}
              </small>
            </div>

            <div className="field">
              <label className="fieldLabel" htmlFor="minConfidence">
                Min Confidence
              </label>
              <input
                id="minConfidence"
                type="number"
                step="0.01"
                className={settingsErrors.minConfidence ? "invalid" : ""}
                aria-invalid={Boolean(settingsErrors.minConfidence)}
                aria-describedby="minConfidence-hint"
                value={toInputValue(settingsDraft?.minConfidence)}
                onChange={(e) =>
                  setSettingsDraft((s) =>
                    s
                      ? {
                          ...s,
                          minConfidence: parseNumberInput(e.target.value),
                        }
                      : s,
                  )
                }
              />
              <small
                id="minConfidence-hint"
                className={`fieldHint ${settingsErrors.minConfidence ? "error" : ""}`}
              >
                {settingsErrors.minConfidence ?? "Range: 0 to 1"}
              </small>
            </div>

            <div className="field">
              <label className="fieldLabel" htmlFor="actionCooldownMin">
                Action Cooldown (min)
              </label>
              <input
                id="actionCooldownMin"
                type="number"
                className={settingsErrors.actionCooldownMin ? "invalid" : ""}
                aria-invalid={Boolean(settingsErrors.actionCooldownMin)}
                aria-describedby="actionCooldownMin-hint"
                value={toInputValue(settingsDraft?.actionCooldownMin)}
                onChange={(e) =>
                  setSettingsDraft((s) =>
                    s
                      ? {
                          ...s,
                          actionCooldownMin: parseNumberInput(e.target.value),
                        }
                      : s,
                  )
                }
              />
              <small
                id="actionCooldownMin-hint"
                className={`fieldHint ${settingsErrors.actionCooldownMin ? "error" : ""}`}
              >
                {settingsErrors.actionCooldownMin ?? "Range: 0 to 360 min"}
              </small>
            </div>

            <div className="field">
              <label className="fieldLabel" htmlFor="historyRetentionHours">
                History Retention (hours)
              </label>
              <input
                id="historyRetentionHours"
                type="number"
                className={
                  settingsErrors.historyRetentionHours ? "invalid" : ""
                }
                aria-invalid={Boolean(settingsErrors.historyRetentionHours)}
                aria-describedby="historyRetentionHours-hint"
                value={toInputValue(settingsDraft?.historyRetentionHours)}
                onChange={(e) =>
                  setSettingsDraft((s) =>
                    s
                      ? {
                          ...s,
                          historyRetentionHours: parseNumberInput(
                            e.target.value,
                          ),
                        }
                      : s,
                  )
                }
              />
              <small
                id="historyRetentionHours-hint"
                className={`fieldHint ${settingsErrors.historyRetentionHours ? "error" : ""}`}
              >
                {settingsErrors.historyRetentionHours ?? "Range: 24 to 8,760 h"}
              </small>
            </div>

            <div className="field">
              <label className="fieldLabel" htmlFor="maxInMemoryPoints">
                Max In-memory Points
              </label>
              <input
                id="maxInMemoryPoints"
                type="number"
                className={settingsErrors.maxInMemoryPoints ? "invalid" : ""}
                aria-invalid={Boolean(settingsErrors.maxInMemoryPoints)}
                aria-describedby="maxInMemoryPoints-hint"
                value={toInputValue(settingsDraft?.maxInMemoryPoints)}
                onChange={(e) =>
                  setSettingsDraft((s) =>
                    s
                      ? {
                          ...s,
                          maxInMemoryPoints: parseNumberInput(e.target.value),
                        }
                      : s,
                  )
                }
              />
              <small
                id="maxInMemoryPoints-hint"
                className={`fieldHint ${settingsErrors.maxInMemoryPoints ? "error" : ""}`}
              >
                {settingsErrors.maxInMemoryPoints ??
                  "Range: 1,000 to 1,000,000"}
              </small>
            </div>

            <div className="field">
              <label className="fieldLabel" htmlFor="requestTimeoutMs">
                Request Timeout (ms)
              </label>
              <input
                id="requestTimeoutMs"
                type="number"
                className={settingsErrors.requestTimeoutMs ? "invalid" : ""}
                aria-invalid={Boolean(settingsErrors.requestTimeoutMs)}
                aria-describedby="requestTimeoutMs-hint"
                value={toInputValue(settingsDraft?.requestTimeoutMs)}
                onChange={(e) =>
                  setSettingsDraft((s) =>
                    s
                      ? {
                          ...s,
                          requestTimeoutMs: parseNumberInput(e.target.value),
                        }
                      : s,
                  )
                }
              />
              <small
                id="requestTimeoutMs-hint"
                className={`fieldHint ${settingsErrors.requestTimeoutMs ? "error" : ""}`}
              >
                {settingsErrors.requestTimeoutMs ?? "Range: 3,000 to 60,000 ms"}
              </small>
            </div>
          </div>
          <div className="actions">
            <button
              className="buttonSecondary"
              onClick={resetSettingsDraft}
              disabled={!settingsDirty || saving === "settings"}
            >
              Reset Draft
            </button>
            <button
              onClick={saveSettings}
              disabled={
                saving === "settings" ||
                settingsHasErrors ||
                !settingsDraft ||
                !settingsDirty
              }
            >
              {saving === "settings"
                ? "Saving..."
                : settingsDirty
                  ? "Save Settings"
                  : "Saved"}
            </button>
          </div>
        </Panel>
      </section>
      <Panel title={helpPanelTitle} right={helpPanelRight}>
        <div
          className={`helpRoot ${isHelpFa ? "fa" : "en"}`}
          dir={isHelpFa ? "rtl" : "ltr"}
        >
          <div className="helpLangBar">
            <span className="helpLangLabel">
              {isHelpFa ? "زبان راهنما" : "Help language"}
            </span>
            <div
              className="helpLangSwitch"
              role="group"
              aria-label={isHelpFa ? "انتخاب زبان" : "Language selection"}
            >
              <button
                className={`helpLangBtn ${helpLang === "en" ? "active" : ""}`}
                onClick={() => setHelpLang("en")}
              >
                EN
              </button>
              <button
                className={`helpLangBtn ${helpLang === "fa" ? "active" : ""}`}
                onClick={() => setHelpLang("fa")}
              >
                FA
              </button>
            </div>
          </div>

          <p className="helpIntro">{helpIntro}</p>
          <div
            className="helpTabBar"
            role="tablist"
            aria-label={helpSectionsAria}
          >
            {helpTabs.map((tab) => (
              <button
                key={tab.id}
                className={`helpTab ${helpTab === tab.id ? "active" : ""}`}
                onClick={() => setHelpTab(tab.id)}
                aria-selected={helpTab === tab.id}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {helpTab === "overview" ? (
            <section className="helpGrid">
              <article className="helpCard">
                <h3>{quickStartTitle}</h3>
                <ol className="helpList">
                  {quickStartSteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </article>
              <article className="helpCard">
                <h3>{featureMapTitle}</h3>
                <ul className="helpList">
                  {featureGuide.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>
            </section>
          ) : null}

          {helpTab === "statuses" ? (
            <section className="statusGuide">
              {statusGuide.map((item) => (
                <article key={item.key} className="statusGuideCard">
                  <p className="statusGuideLabel">{item.label}</p>
                  <p className="statusGuideCurrent">{item.current}</p>
                  <p className="statusGuideText">
                    <strong>{meaningLabel}:</strong> {item.meaning}
                  </p>
                  <p className="statusGuideText">
                    <strong>{actionLabel}:</strong> {item.action}
                  </p>
                </article>
              ))}
            </section>
          ) : null}

          {helpTab === "flows" ? (
            <section className="helpGrid">
              {flowGuide.map((flow) => (
                <article key={flow.title} className="helpCard">
                  <h3>{flow.title}</h3>
                  <p className="helpText">{flow.detail}</p>
                </article>
              ))}
            </section>
          ) : null}

          {helpTab === "data" ? (
            <section className="helpGrid">
              <article className="helpCard">
                <h3>{dataGlossaryTitle}</h3>
                <ul className="helpList">
                  {dataGlossary.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>
              <article className="helpCard">
                <h3>{importantNotesTitle}</h3>
                <p className="helpText">{importantNote1}</p>
                <p className="helpText">{importantNote2}</p>
              </article>
            </section>
          ) : null}
        </div>
      </Panel>
    </main>
  );
}
