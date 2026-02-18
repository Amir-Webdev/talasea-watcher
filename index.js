import notifier from "node-notifier";
import chalk from "chalk";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const URL = "https://api.talasea.ir/api/market/getGoldPrice";
const INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

// Keep your headers (token/cookie mock data stays as-is)
const HEADERS = {
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

// ===== Helpers =====
function parsePriceString(priceStr) {
  if (typeof priceStr !== "string") return null;
  const cleaned = priceStr.replace(/[^\d.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function formatNum(n) {
  return Number(n).toLocaleString();
}

function padRight(s, len) {
  s = String(s);
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function padLeft(s, len) {
  s = String(s);
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

function msToHuman(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

function sparkline(values, width = 32) {
  // Unicode blocks: low -> high
  const blocks = "▁▂▃▄▅▆▇█";
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2)
    return chalk.gray("∙".repeat(Math.min(width, Math.max(1, v.length))));

  // Downsample to width
  const sampled = [];
  if (v.length <= width) {
    sampled.push(...v);
  } else {
    const step = v.length / width;
    for (let i = 0; i < width; i++) {
      sampled.push(v[Math.floor(i * step)]);
    }
  }

  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const range = max - min || 1;

  return sampled
    .map((x) => {
      const idx = Math.max(0, Math.min(7, Math.floor(((x - min) / range) * 7)));
      return blocks[idx];
    })
    .join("");
}

function directionArrow(curr, prev) {
  if (prev == null) return chalk.gray("•");
  if (curr > prev) return chalk.green("▲");
  if (curr < prev) return chalk.red("▼");
  return chalk.gray("•");
}

function notify({ mode, priceStr, targetStr }) {
  const op = mode === "sell" ? ">=" : "<=";
  notifier.notify({
    title: `Talasea Gold ${mode.toUpperCase()} Alert`,
    message: `Price ${priceStr} ${op} ${targetStr}`,
    sound: true,
    wait: false,
  });
}

function isTriggered(mode, priceNum, targetNum) {
  return mode === "sell" ? priceNum >= targetNum : priceNum <= targetNum;
}

function rearmCondition(mode, priceNum, targetNum) {
  return mode === "sell" ? priceNum < targetNum : priceNum > targetNum;
}

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H");
}

// ===== CLI prompts =====
async function askMode(rl) {
  while (true) {
    const ans = (await rl.question("Mode (sell/buy): ")).trim().toLowerCase();
    if (ans === "sell" || ans === "buy") return ans;
    console.log("Type 'sell' or 'buy'.\n");
  }
}

async function askTarget(rl) {
  while (true) {
    const ans = (await rl.question("Target price: ")).trim();
    const n = parsePriceString(ans);
    if (n != null) return { targetNum: n, targetRaw: ans };
    console.log("Invalid number. Example: 50000000 or 50,000,000\n");
  }
}

// ===== State =====
const state = {
  mode: "sell",
  targetNum: 0,
  targetRaw: "0",
  lastAlerted: false,
  lastFetchAt: null,
  nextFetchAt: null,
  lastRawPriceStr: null, // for "Price: data.price"
  lastPriceNum: null,
  prices: [], // numeric history
  rawLog: [], // last N raw strings
  errors: [],
};

const MAX_POINTS = 60; // history window
const MAX_LOG_LINES = 10;

function pushBounded(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

function headerLine() {
  const title =
    chalk.bold.cyan("TALASEA WATCH") +
    chalk.gray("  •  ") +
    chalk.white("Gold Price");
  const modeBadge =
    state.mode === "sell"
      ? chalk.bgRed.white(" SELL ")
      : chalk.bgGreen.black(" BUY  ");

  const armedBadge = state.lastAlerted
    ? chalk.bgYellow.black(" ALERTED ")
    : chalk.bgBlue.white(" ARMED ");

  const nextIn = state.nextFetchAt
    ? msToHuman(state.nextFetchAt - Date.now())
    : "--:--";
  const nextText = chalk.gray("Next fetch in ") + chalk.white(nextIn);

  return `${title}   ${modeBadge} ${armedBadge}   ${nextText}`;
}

function box(lines, width = 78) {
  const top = "┌" + "─".repeat(width - 2) + "┐";
  const bot = "└" + "─".repeat(width - 2) + "┘";
  const body = lines.map((l) => {
    const plain = stripAnsi(l);
    const padded = l + " ".repeat(Math.max(0, width - 2 - plain.length));
    return "│" + padded + "│";
  });
  return [top, ...body, bot].join("\n");
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function renderDashboard() {
  clearScreen();

  const width = 92;
  const line = "─".repeat(width);

  const last = state.lastPriceNum;
  const prev =
    state.prices.length >= 2 ? state.prices[state.prices.length - 2] : null;

  const arrow = last != null ? directionArrow(last, prev) : chalk.gray("•");

  const target = state.targetNum;
  const delta = last != null ? last - target : null;
  const deltaAbs = delta != null ? Math.abs(delta) : null;

  const op = state.mode === "sell" ? ">=" : "<=";
  const conditionMet =
    last != null ? isTriggered(state.mode, last, target) : false;

  const priceColor =
    last == null ? chalk.gray : conditionMet ? chalk.greenBright : chalk.white;

  const deltaColor =
    delta == null
      ? chalk.gray
      : state.mode === "sell"
        ? delta >= 0
          ? chalk.greenBright
          : chalk.redBright
        : delta <= 0
          ? chalk.greenBright
          : chalk.redBright;

  const pct =
    last != null && prev != null && prev !== 0
      ? ((last - prev) / prev) * 100
      : null;

  const pctText =
    pct == null
      ? chalk.gray("--")
      : pct > 0
        ? chalk.green(`+${pct.toFixed(3)}%`)
        : pct < 0
          ? chalk.red(`${pct.toFixed(3)}%`)
          : chalk.gray("0.000%");

  const min = state.prices.length ? Math.min(...state.prices) : null;
  const max = state.prices.length ? Math.max(...state.prices) : null;

  const lastUpdated = state.lastFetchAt
    ? chalk.gray(new Date(state.lastFetchAt).toLocaleString())
    : chalk.gray("--");

  const spark = sparkline(state.prices, 48);
  const sparkLine = `Chart: ${chalk.gray("[")} ${spark} ${chalk.gray("]")}  ${chalk.gray(`(${state.prices.length} pts)`)}`;

  const rawLine =
    state.lastRawPriceStr == null
      ? chalk.gray("Price: --")
      : chalk.white("Price: ") + chalk.yellow(state.lastRawPriceStr);

  // Your requested log line exactly (shown in dashboard area)
  const exactLogLine =
    state.lastRawPriceStr == null
      ? chalk.gray('console.log("Price:", data.price);  // Price: --')
      : chalk.gray('console.log("Price:", data.price);') +
        chalk.gray("  // ") +
        chalk.white("Price: ") +
        chalk.yellow(state.lastRawPriceStr);

  const statsLines = [
    headerLine(),
    chalk.gray(line),
    `${chalk.gray("Last Updated:")} ${lastUpdated}`,
    "",
    `${chalk.gray("Live Price:")} ${arrow} ${priceColor(last != null ? formatNum(last) : "--")}  ${chalk.gray("|")}  ${chalk.gray("Tick:")} ${pctText}`,
    `${chalk.gray("Target:")} ${chalk.white(`${op} ${formatNum(target)}`)}  ${chalk.gray("|")}  ${chalk.gray("Distance:")} ${deltaColor(delta != null ? `${delta < 0 ? "-" : ""}${formatNum(deltaAbs)}` : "--")}`,
    `${chalk.gray("Range (window):")} ${chalk.white(min != null ? formatNum(min) : "--")} ${chalk.gray("to")} ${chalk.white(max != null ? formatNum(max) : "--")}`,
    "",
    sparkLine,
    "",
    rawLine,
    exactLogLine,
  ];

  const box1 = box(statsLines, width);

  const logsTitle = chalk.bold.white("Recent Fetches");
  const logs = state.rawLog
    .slice()
    .reverse()
    .map((l) => `• ${chalk.gray(l)}`);
  const errTitle = chalk.bold.white("Errors");
  const errs = state.errors
    .slice()
    .reverse()
    .map((e) => `• ${chalk.red(e)}`);

  const rightLines = [
    logsTitle,
    ...logs,
    "",
    errTitle,
    ...(errs.length ? errs : [chalk.gray("• none")]),
  ];

  const box2 = box(rightLines, width);

  console.log(box1);
  console.log();
  console.log(box2);
}

async function fetchOnce() {
  const started = Date.now();
  state.lastFetchAt = started;
  state.nextFetchAt = started + INTERVAL_MS;

  try {
    const response = await fetch(URL, { method: "GET", headers: HEADERS });

    if (!response.ok) {
      const msg = `[${new Date().toLocaleTimeString()}] HTTP ${response.status} ${response.statusText}`;
      pushBounded(state.errors, msg, MAX_LOG_LINES);
      renderDashboard();
      return;
    }

    const data = await response.json();

    // Required style: log the price like this:
    // const data = await response.json();
    // console.log("Price:", data.price);
    // We'll store it and show it as part of the "terminal screen" each fetch.
    state.lastRawPriceStr = data.price;
    pushBounded(
      state.rawLog,
      `[${new Date().toLocaleTimeString()}] Price: ${String(data.price)}`,
      MAX_LOG_LINES,
    );

    const priceNum = parsePriceString(data.price);
    if (priceNum == null) {
      pushBounded(
        state.errors,
        `[${new Date().toLocaleTimeString()}] Could not parse price: ${String(data.price)}`,
        MAX_LOG_LINES,
      );
      renderDashboard();
      return;
    }

    state.lastPriceNum = priceNum;
    pushBounded(state.prices, priceNum, MAX_POINTS);

    // Alert logic
    const triggered = isTriggered(state.mode, priceNum, state.targetNum);

    if (triggered) {
      if (!state.lastAlerted) {
        notify({
          mode: state.mode,
          priceStr: String(data.price),
          targetStr: String(state.targetRaw),
        });
        state.lastAlerted = true;
      }
    } else if (rearmCondition(state.mode, priceNum, state.targetNum)) {
      state.lastAlerted = false;
    }

    renderDashboard();
  } catch (err) {
    pushBounded(
      state.errors,
      `[${new Date().toLocaleTimeString()}] Network error: ${err?.message || err}`,
      MAX_LOG_LINES,
    );
    renderDashboard();
  }
}

async function main() {
  clearScreen();
  console.log(chalk.cyan.bold("Talasea Gold Watcher (Trader Screen)\n"));

  const rl = readline.createInterface({ input, output });
  state.mode = await askMode(rl);
  const { targetNum, targetRaw } = await askTarget(rl);
  state.targetNum = targetNum;
  state.targetRaw = targetRaw;
  rl.close();

  state.nextFetchAt = Date.now() + INTERVAL_MS;
  renderDashboard();

  // First fetch immediately
  await fetchOnce();

  // Then every 2 minutes
  setInterval(fetchOnce, INTERVAL_MS);

  // Update countdown display smoothly (optional but nice)
  setInterval(renderDashboard, 1000);
}

main();
