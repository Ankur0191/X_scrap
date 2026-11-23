import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchPersistentSession, inspectSignedInState } from "../auth/session.js";
import { profileDir } from "../auth/profile.js";
import { extractVisiblePost, detectStopCondition } from "./visible-post.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(fs.readFileSync(path.join(root, "config/competitors.json"), "utf8"));
const args = process.argv.slice(2);
const allAvailable = args.includes("--all-available");
const accountIndex = args.indexOf("--account");
const accountFilter = accountIndex >= 0 ? String(args[accountIndex + 1] || "").replace(/^@/, "").toLowerCase() : null;
const headless = process.env.X_HEADLESS === "1";

if (!Array.isArray(config.competitors) || !config.competitors.some((item) => item.enabled)) {
  throw new Error("No enabled competitors in config/competitors.json");
}
if (headless && !config.collection?.allowHeadless) {
  throw new Error("Headless mode is disabled in config/competitors.json. Use headed Chromium until written authorization covers headless operation.");
}
const competitors = config.competitors.filter((item) =>
  item.enabled && (!accountFilter || item.username.toLowerCase() === accountFilter)
);
if (!competitors.length) throw new Error("No enabled competitor matches --account.");

const settings = config.collection || {};
const timelines = settings.timelines || ["posts", "with_replies"];
const maxScrolls = allAvailable ? Number(settings.maxScrollsAll || 250) : Number(settings.maxScrollsLatest || 20);
const scrollDelayMs = Number(settings.scrollDelayMs || 2500);
const emptyPagesToStop = Number(settings.emptyPagesToStop || 3);

const outputDir = path.join(root, "data/output");
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "posts.jsonl");
const runLogPath = path.join(outputDir, "collection-runs.jsonl");
const seen = new Set();
if (fs.existsSync(outputPath)) {
  for (const line of fs.readFileSync(outputPath, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      const item = JSON.parse(line);
      seen.add(String(item.trackedCompetitor || item.authorUsername).toLowerCase() + ":" + String(item.id));
    } catch { /* preserve malformed old rows and continue */ }
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const runStarted = new Date().toISOString();
let context;
let acceptedTotal = 0;
const summary = {
  startedAt: runStarted,
  mode: headless ? "headless" : "headed",
  scan: allAvailable ? "all-available-bounded" : "latest",
  competitors: [],
  accepted: 0
};

try {
  console.log("X visible-frontend collector");
  console.log("Mode: " + summary.mode + " | Scan: " + summary.scan);
  console.log("Browser profile: " + profileDir);
  console.log("Collection reads visible page content only; no hidden endpoints or network interception.");

  context = await launchPersistentSession({ headless });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1800);
  const sessionState = await inspectSignedInState(page);
  if (sessionState === "signed_out") throw new Error("X session is signed out. Run npm run auth:check and sign in manually.");
  if (sessionState === "unknown") {
    console.log("The UI session detector is inconclusive. Confirm that the signed-in Home timeline is visible.");
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Type YES to confirm the visible signed-in session: ")).trim().toUpperCase();
    rl.close();
    if (answer !== "YES") throw new Error("Session not confirmed; collection cancelled.");
  }

  for (const competitor of competitors) {
    const handle = competitor.username.replace(/^@/, "").toLowerCase();
    const competitorSummary = { username: handle, timelines: [], accepted: 0 };
    console.log("\n=== " + handle + " ===");

    for (const timeline of timelines) {
      const route = timeline === "with_replies" ? "/" + handle + "/with_replies" : "/" + handle;
      const targetUrl = "https://x.com" + route;
      console.log("Opening visible timeline: " + targetUrl);
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(3500);

      let cardsFound = await page.locator('article[data-testid="tweet"]').count();
      if (!cardsFound) {
        await page.waitForTimeout(4500);
        cardsFound = await page.locator('article[data-testid="tweet"]').count();
      }
      if (!cardsFound) {
        const bodyText = await page.locator("body").innerText().catch(() => "");
        const stop = detectStopCondition(bodyText, page.url());
        if (stop) throw new Error("Stopped by platform state: " + stop + " on " + handle);
        competitorSummary.timelines.push({ timeline, status: "no_visible_post_cards" });
        console.warn("No visible post cards found for " + handle + " (" + timeline + ").");
        continue;
      }

      let emptyPages = 0;
      let totalNewForTimeline = 0;
      for (let scroll = 0; scroll <= maxScrolls; scroll += 1) {
        const articles = page.locator('article[data-testid="tweet"]');
        const count = await articles.count();
        let addedThisScreen = 0;
        let knownThisScreen = 0;

        for (let index = 0; index < count; index += 1) {
          const post = await extractVisiblePost(articles.nth(index), handle, timeline);
          if (!post) continue;
          const key = post.trackedCompetitor + ":" + post.id;
          if (seen.has(key)) {
            knownThisScreen += 1;
            continue;
          }
          seen.add(key);
          const record = { ...post, ingestedAt: new Date().toISOString() };
          fs.appendFileSync(outputPath, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
          addedThisScreen += 1;
          totalNewForTimeline += 1;
          acceptedTotal += 1;
        }

        competitorSummary.accepted += addedThisScreen;
        console.log("Screen " + scroll + ": " + count + " visible cards, " + addedThisScreen + " new, " + knownThisScreen + " already collected.");

        if (addedThisScreen === 0) emptyPages += 1;
        else emptyPages = 0;

        if (!allAvailable && knownThisScreen > 0 && addedThisScreen === 0) {
          console.log("Reached previously collected posts; latest-only scan complete.");
          break;
        }
        if (emptyPages >= emptyPagesToStop) {
          console.log("No new posts across " + emptyPages + " successive screens; ending timeline scan.");
          break;
        }
        if (scroll === maxScrolls) {
          console.log("Reached configured safety bound of " + maxScrolls + " scrolls.");
          break;
        }

        await page.mouse.wheel(0, 1250);
        await delay(scrollDelayMs);
        const bodyText = await page.locator("body").innerText().catch(() => "");
        const stop = detectStopCondition(bodyText, page.url());
        if (stop) throw new Error("Stopped by platform state: " + stop + ". No automated retries will be attempted.");
      }

      competitorSummary.timelines.push({ timeline, status: "completed", newPosts: totalNewForTimeline });
    }
    summary.competitors.push(competitorSummary);
  }

  summary.accepted = acceptedTotal;
  summary.completedAt = new Date().toISOString();
  fs.appendFileSync(runLogPath, JSON.stringify(summary) + "\n", "utf8");
  console.log("\nCollection summary:");
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  summary.accepted = acceptedTotal;
  summary.completedAt = new Date().toISOString();
  summary.error = error.message;
  fs.appendFileSync(runLogPath, JSON.stringify(summary) + "\n", "utf8");
  console.error("\nCollection stopped: " + error.message);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
}
