import notifier from "node-notifier";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const URL = "https://api.talasea.ir/api/market/getGoldPrice";
const INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

// Mock headers as you provided (kept as-is)
const HEADERS = {
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
};

function nowStamp() {
  return new Date().toLocaleString();
}

// data.price is a string (maybe "52,340,000" etc). This turns it into a Number safely.
function parsePriceString(priceStr) {
  if (typeof priceStr !== "string") return null;
  const cleaned = priceStr.replace(/[^\d.]/g, ""); // keep digits + dot
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function notify(priceStr, thresholdStr) {
  notifier.notify({
    title: "Talasea Gold Alert",
    message: `Price ${priceStr} >= ${thresholdStr}`,
    sound: true, // tries to play a sound (depends on system)
    wait: false,
  });
}

async function askThreshold() {
  const rl = readline.createInterface({ input, output });

  while (true) {
    const answer = (
      await rl.question("Enter target price (e.g. 50000000 or 50,000,000): ")
    ).trim();

    const num = parsePriceString(answer);
    if (num != null) {
      rl.close();
      return { thresholdNum: num, thresholdRaw: answer };
    }

    console.log("Invalid number. Try again.\n");
  }
}

let lastAlerted = false; // notify once per crossing above threshold

async function pollOnce(thresholdNum, thresholdRaw) {
  try {
    const response = await fetch(URL, { method: "GET", headers: HEADERS });

    if (!response.ok) {
      console.log(
        `[${nowStamp()}] HTTP ${response.status} ${response.statusText}`,
      );
      return;
    }

    const data = await response.json();

    // You asked to log it like this:
    // console.log(`[${nowStamp()}] `, data.price);

    const priceNum = parsePriceString(data.price);
    if (priceNum == null) {
      console.log(
        `[${nowStamp()}] Could not parse data.price (string). Value was:`,
        data.price,
      );
      return;
    }

    console.log(
      `[${nowStamp()}] Parsed price=${priceNum.toLocaleString()} | threshold=${thresholdNum.toLocaleString()}`,
    );

    if (priceNum >= thresholdNum) {
      if (!lastAlerted) {
        console.log(
          `*** ALERT TRIGGERED: ${priceNum.toLocaleString()} >= ${thresholdNum.toLocaleString()} ***`,
        );
        notify(String(data.price), String(thresholdRaw));
        lastAlerted = true;
      }
    } else {
      // re-arm when it goes below threshold
      lastAlerted = false;
    }
  } catch (err) {
    console.log(`[${nowStamp()}] Error:`, err?.message || err);
  }
}

async function main() {
  console.log("Talasea watcher starting...\n");

  const { thresholdNum, thresholdRaw } = await askThreshold();

  console.log(
    `\nWatching every ${INTERVAL_MS / 1000}s. Alert when >= ${thresholdNum.toLocaleString()}\n`,
  );

  await pollOnce(thresholdNum, thresholdRaw);
  setInterval(() => pollOnce(thresholdNum, thresholdRaw), INTERVAL_MS);
}

main();
