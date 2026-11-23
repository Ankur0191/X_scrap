import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchPersistentSession, inspectSignedInState } from "../auth/session.js";
import { profileDir } from "../auth/profile.js";
import { extractVisiblePost, detectStopCondition } from "./visible-post.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(fs.readFileSync(path.join(root, "config/competitors.json"), "utf8"));
const args = process.argv.slice(2);
const backfillWindow = args.includes("--backfill") || args.includes("--all-available");
const accountIndex = args.indexOf("--account");
const accountFilter = accountIndex >= 0 ? String(args[accountIndex + 1] || "").replace(/^@/, "").toLowerCase() : null;
const daysIndex = args.indexOf("--window-days");
const requestedDays = daysIndex >= 0 ? Number(args[daysIndex + 1]) : Number(config.collection?.windowDays || 365);
const windowDays = Number.isFinite(requestedDays) && requestedDays > 0 ? Math.min(requestedDays, 3650) : 365;
const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
const headless = process.env.X_HEADLESS === "1";

if (!Array.isArray(config.competitors) || !config.competitors.some((item) => item.enabled)) {
  throw new Error("No enabled competitors in config/competitors.json");
}
if (headless && !config.collection?.allowHeadless) {
  throw new Error("Headless mode is disabled in config/competitors.json. Keep the first validation headed.");
}
const competitors = config.competitors.filter((item) =>
  item.enabled && (!accountFilter || item.username.toLowerCase() === accountFilter)
);
if (!competitors.length) throw new Error("No enabled competitor matches --account.");

const settings = config.collection || {};
const timelines = settings.timelines || ["posts", "with_replies"];
const maxScrolls = backfillWindow
  ? Number(settings.maxScrollsBackfill || 1200)
  : Number(settings.maxScrollsLatest || 20);
const scrollDelayMs = Number(settings.scrollDelayMs || 3000);
const boundaryScreensRequired = Number(settings.boundaryScreensRequired || 3);
const noNewScreensRequired = Number(settings.noNewScreensRequired || 3);
const engagementSnapshotIntervalHours = Number(settings.engagementSnapshotIntervalHours || 6);

const outputDir = path.join(root, "data/output");
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const outputPath = path.join(outputDir, "posts.jsonl");
const runLogPath = path.join(outputDir, "collection-runs.jsonl");
const snapshotsPath = path.join(outputDir, "engagement-snapshots.jsonl");
const checkpointPath = path.join(outputDir, "backfill-checkpoints.json");
let checkpointState = { version: 1, entries: {} };
if (fs.existsSync(checkpointPath)) {
  try {
    const saved = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    if (saved && typeof saved.entries === "object") checkpointState = saved;
  } catch {
    console.warn("Backfill checkpoint file is invalid; starting without resume checkpoints.");
  }
}
const saveCheckpointState = () => {
  const temporaryPath = checkpointPath + ".tmp";
  fs.writeFileSync(temporaryPath, JSON.stringify(checkpointState, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(temporaryPath, checkpointPath);
};
const seen = new Set();
const seenForSnapshotThisRun = new Set();
const latestSnapshotByPost = new Map();
if (fs.existsSync(outputPath)) {
  for (const line of fs.readFileSync(outputPath, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      const item = JSON.parse(line);
      seen.add(String(item.trackedCompetitor || item.authorUsername).toLowerCase() + ":" + String(item.id));
    } catch { /* preserve malformed historical lines */ }
  }
}
if (fs.existsSync(snapshotsPath)) {
  for (const line of fs.readFileSync(snapshotsPath, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      const item = JSON.parse(line);
      const key = String(item.trackedCompetitor || "").toLowerCase() + ":" + String(item.postId || "");
      const previous = latestSnapshotByPost.get(key);
      if (!previous || new Date(item.snapshotAt) >= new Date(previous.snapshotAt)) {
        latestSnapshotByPost.set(key, item);
      }
    } catch { /* preserve malformed snapshot rows */ }
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const visibleAlerts = async (page) => {
  const alerts = page.locator('[role="alert"], [data-testid="toast"]');
  const texts = [];
  for (let index = 0; index < await alerts.count(); index += 1) {
    const alert = alerts.nth(index);
    if (await alert.isVisible()) texts.push(await alert.innerText());
  }
  return texts.join("\n");
};

const startedAt = new Date().toISOString();
let context;
let acceptedTotal = 0;
let engagementSnapshotsAdded = 0;
const summary = {
  startedAt,
  mode: headless ? "headless" : "headed",
  scan: backfillWindow ? "rolling-window-backfill" : "latest-incremental",
  windowDays,
  cutoff: cutoff.toISOString(),
  timelineOrderAssumption: "newest_first",
  competitors: [],
  accepted: 0,
  engagementSnapshotsAdded: 0,
  outOfWindowSkipped: 0
};

try {
  console.log("X visible-frontend collector");
  console.log("Mode: " + summary.mode + " | Scan: " + summary.scan);
  console.log("Rolling window: " + cutoff.toISOString() + " through " + new Date().toISOString());
  console.log("Browser profile: " + profileDir);
  console.log("Only posts inside the rolling window are written. Existing older rows remain untouched.");
  console.log("Collection reads rendered page content only; no hidden endpoints or network interception.");

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

      const navigationStop = detectStopCondition(await visibleAlerts(page), page.url());
      if (navigationStop) throw new Error("Stopped by platform state: " + navigationStop + " on " + handle);

      let cardsFound = await page.locator('article[data-testid="tweet"]').count();
      if (!cardsFound) {
        await page.waitForTimeout(4500);
        cardsFound = await page.locator('article[data-testid="tweet"]').count();
      }
      if (!cardsFound) {
        const bodyText = await page.locator("body").innerText().catch(() => "");
        const stop = detectStopCondition(bodyText, page.url());
        if (stop) throw new Error("Stopped by platform state: " + stop + " on " + handle);
        competitorSummary.timelines.push({ timeline, status: "no_visible_post_cards", complete: false });
        console.warn("No visible post cards found for " + handle + " (" + timeline + ").");
        continue;
      }

      const checkpointKey = handle + ":" + timeline;
      let resumeCheckpoint = backfillWindow ? checkpointState.entries[checkpointKey] || null : null;
      if (resumeCheckpoint?.createdAt && new Date(resumeCheckpoint.createdAt) < cutoff) {
        delete checkpointState.entries[checkpointKey];
        resumeCheckpoint = null;
        saveCheckpointState();
      }
      let resumeCheckpointReached = !resumeCheckpoint;
      let oldBoundaryScreens = 0;
      let noNewScreens = 0;
      let totalNewForTimeline = 0;
      let inWindowSeen = 0;
      let outOfWindowSkipped = 0;
      let oldestInWindow = null;
      let oldestInWindowId = null;
      let completion = "safety_limit_reached";

      for (let scroll = 0; scroll <= maxScrolls; scroll += 1) {
        const articles = page.locator('article[data-testid="tweet"]');
        const count = await articles.count();
        let recognizedCards = 0;
        let inWindowCards = 0;
        let oldCards = 0;
        let addedThisScreen = 0;
        let knownThisScreen = 0;

        for (let index = 0; index < count; index += 1) {
          const post = await extractVisiblePost(articles.nth(index), handle, timeline);
          if (!post) continue;
          recognizedCards += 1;
          const postDate = new Date(post.createdAt);
          if (resumeCheckpoint && !resumeCheckpointReached && post.id === String(resumeCheckpoint.postId)) {
            resumeCheckpointReached = true;
            oldBoundaryScreens = 0;
            console.log("Resumed historical scan after checkpoint post " + post.id + ".");
          }
          if (postDate < cutoff) {
            oldCards += 1;
            outOfWindowSkipped += 1;
            summary.outOfWindowSkipped += 1;
            continue;
          }
          inWindowCards += 1;
          inWindowSeen += 1;
          if (!oldestInWindow || postDate < new Date(oldestInWindow)) {
            oldestInWindow = post.createdAt;
            oldestInWindowId = post.id;
          }

          const key = post.trackedCompetitor + ":" + post.id;
          if (!seenForSnapshotThisRun.has(key)) {
            seenForSnapshotThisRun.add(key);
            const snapshotAt = new Date().toISOString();
            const currentMetrics = post.metrics || {};
            const previousSnapshot = latestSnapshotByPost.get(key);
            const metricsChanged = !previousSnapshot ||
              JSON.stringify(previousSnapshot.metrics || {}) !== JSON.stringify(currentMetrics);
            const snapshotDue = !previousSnapshot ||
              (Date.now() - new Date(previousSnapshot.snapshotAt).getTime()) >= engagementSnapshotIntervalHours * 60 * 60 * 1000;

            if (metricsChanged || snapshotDue) {
              const snapshot = {
                trackedCompetitor: post.trackedCompetitor,
                postId: post.id,
                postUrl: post.url,
                publishedAt: post.createdAt,
                metrics: currentMetrics,
                previousMetrics: previousSnapshot?.metrics || null,
                snapshotAt,
                source: "x-visible-frontend",
                metricSemantics: "counts_visible_at_snapshot_time_not_lifetime_delta"
              };
              fs.appendFileSync(snapshotsPath, JSON.stringify(snapshot) + "\n", {
                encoding: "utf8",
                mode: 0o600
              });
              latestSnapshotByPost.set(key, snapshot);
              engagementSnapshotsAdded += 1;
            }
          }

          if (seen.has(key)) {
            knownThisScreen += 1;
            continue;
          }
          seen.add(key);
          const record = {
            ...post,
            windowDays,
            windowCutoff: cutoff.toISOString(),
            ingestedAt: new Date().toISOString()
          };
          fs.appendFileSync(outputPath, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
          addedThisScreen += 1;
          totalNewForTimeline += 1;
          acceptedTotal += 1;
        }

        competitorSummary.accepted += addedThisScreen;
        console.log(
          "Screen " + scroll +
          ": " + count + " cards, " + addedThisScreen + " new, " +
          knownThisScreen + " known, " + inWindowCards + " in-window, " +
          oldCards + " older than cutoff."
        );

        if (backfillWindow) {
          if (resumeCheckpointReached) {
            if (recognizedCards > 0 && inWindowCards === 0 && oldCards > 0) oldBoundaryScreens += 1;
            else if (inWindowCards > 0) oldBoundaryScreens = 0;

            if (oldBoundaryScreens >= boundaryScreensRequired) {
              completion = "window_boundary_reached";
              console.log("Reached the rolling-window boundary across " + oldBoundaryScreens + " successive screens.");
              break;
            }
          } else if (scroll === maxScrolls) {
            completion = "checkpoint_not_reached";
            console.warn("Could not locate the previous backfill checkpoint; leaving the saved checkpoint unchanged.");
            break;
          }
        } else {
          if (addedThisScreen === 0 && knownThisScreen > 0) noNewScreens += 1;
          else if (addedThisScreen > 0) noNewScreens = 0;

          if (noNewScreens >= noNewScreensRequired) {
            completion = "existing_data_boundary_reached";
            console.log("Reached previously collected recent posts across " + noNewScreens + " successive screens.");
            break;
          }
        }

        if (backfillWindow && resumeCheckpointReached && oldestInWindowId && scroll > 0 && scroll % 25 === 0) {
          checkpointState.entries[checkpointKey] = {
            competitor: handle,
            timeline,
            postId: String(oldestInWindowId),
            createdAt: oldestInWindow,
            updatedAt: new Date().toISOString(),
            reason: "periodic_backfill_checkpoint"
          };
          saveCheckpointState();
        }

        if (scroll === maxScrolls) {
          completion = resumeCheckpoint && !resumeCheckpointReached ? "checkpoint_not_reached" : "safety_limit_reached";
          console.log("Reached configured safety bound of " + maxScrolls + " scrolls.");
          break;
        }

        await page.mouse.wheel(0, 1250);
        await delay(scrollDelayMs);
        const stop = detectStopCondition(await visibleAlerts(page), page.url());
        if (stop) throw new Error("Stopped by platform state: " + stop + ". No automated retries will be attempted.");
      }

      if (backfillWindow) {
        if (completion === "window_boundary_reached") {
          delete checkpointState.entries[checkpointKey];
          saveCheckpointState();
        } else if (completion === "safety_limit_reached" && resumeCheckpointReached && oldestInWindowId) {
          checkpointState.entries[checkpointKey] = {
            competitor: handle,
            timeline,
            postId: String(oldestInWindowId),
            createdAt: oldestInWindow,
            updatedAt: new Date().toISOString(),
            reason: "safety_limit_resume"
          };
          saveCheckpointState();
        }
      }

      const timelineComplete = backfillWindow
        ? completion === "window_boundary_reached"
        : completion === "existing_data_boundary_reached";
      competitorSummary.timelines.push({
        timeline,
        status: timelineComplete ? "completed" : "partial",
        completion,
        resumeCheckpointReached,
        newPosts: totalNewForTimeline,
        inWindowCardsSeen: inWindowSeen,
        outOfWindowCardsSkipped: outOfWindowSkipped,
        oldestInWindowSeen: oldestInWindow,
        oldestInWindowPostId: oldestInWindowId
      });
    }
    summary.competitors.push(competitorSummary);
  }

  summary.accepted = acceptedTotal;
  summary.engagementSnapshotsAdded = engagementSnapshotsAdded;
  if (backfillWindow) {
    const timelineResults = summary.competitors.flatMap((item) => item.timelines);
    summary.backfillCoverageStatus = timelineResults.length > 0 &&
      timelineResults.every((item) => item.completion === "window_boundary_reached")
      ? "complete_to_window_boundary"
      : "partial";
  }
  summary.completedAt = new Date().toISOString();
  fs.appendFileSync(runLogPath, JSON.stringify(summary) + "\n", "utf8");
  console.log("\nCollection summary:");
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  summary.accepted = acceptedTotal;
  summary.engagementSnapshotsAdded = engagementSnapshotsAdded;
  summary.completedAt = new Date().toISOString();
  summary.error = error.message;
  fs.appendFileSync(runLogPath, JSON.stringify(summary) + "\n", "utf8");
  console.error("\nCollection stopped: " + error.message);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
}
