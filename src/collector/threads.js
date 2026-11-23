import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { launchPersistentSession, inspectSignedInState } from "../auth/session.js";
import { profileDir } from "../auth/profile.js";
import { extractVisiblePost, detectStopCondition } from "./visible-post.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(fs.readFileSync(path.join(root, "config/competitors.json"), "utf8"));
const args = process.argv.slice(2);
const limitIndex = args.indexOf("--limit");
const limit = limitIndex >= 0 ? Math.max(1, Number(args[limitIndex + 1]) || 1) : Infinity;
const accountIndex = args.indexOf("--account");
const accountFilter = accountIndex >= 0 ? String(args[accountIndex + 1] || "").replace(/^@/, "").toLowerCase() : null;
const headless = process.env.X_HEADLESS === "1";
const settings = config.collection || {};
const maxScrolls = Number(settings.maxThreadScrolls || 30);
const delayMs = Number(settings.threadScrollDelayMs || 2500);
const stableScreensRequired = Number(settings.threadStableScreens || 3);
const refreshDays = Number(settings.threadRefreshDays || 7);

const queuePath = path.join(root, "data/output/thread-queue-365d.jsonl");
const replyPath = path.join(root, "data/output/thread-replies.jsonl");
const snapshotsPath = path.join(root, "data/output/engagement-snapshots.jsonl");
const progressPath = path.join(root, "data/output/thread-progress.jsonl");
if (!fs.existsSync(queuePath)) {
  console.error("Thread queue missing. Run npm run threads:queue first.");
  process.exit(2);
}
if (headless && !settings.allowHeadless) {
  throw new Error("Headless mode remains disabled. Use headed Chromium for thread validation.");
}

const queue = fs.readFileSync(queuePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  .filter((item) => !accountFilter || item.trackedCompetitor === accountFilter);

const progressByRoot = new Map();
if (fs.existsSync(progressPath)) {
  for (const line of fs.readFileSync(progressPath, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      const item = JSON.parse(line);
      progressByRoot.set(String(item.rootPostId), item);
    } catch { /* ignore malformed progress lines */ }
  }
}
const seenReplies = new Set();
const latestSnapshotByPost = new Map();
const snapshotSeenThisRun = new Set();
let engagementSnapshotsAdded = 0;
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
if (fs.existsSync(replyPath)) {
  for (const line of fs.readFileSync(replyPath, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      const item = JSON.parse(line);
      seenReplies.add(String(item.conversationRootId) + ":" + String(item.id));
    } catch { /* ignore malformed historical lines */ }
  }
}

const now = new Date();
const cutoff = new Date(now.getTime() - Number(settings.windowDays || 365) * 86400000);
const eligibleCandidates = queue.filter((item) => {
  const published = new Date(item.createdAt);
  if (Number.isNaN(published.getTime()) || published < cutoff || published > now) return false;
  const previous = progressByRoot.get(item.rootPostId);
  if (!previous || previous.status !== "visible_end_reached") return true;
  const checkedAt = new Date(previous.checkedAt);
  return Number.isNaN(checkedAt.getTime()) || now - checkedAt >= refreshDays * 86400000;
});

// Fair scheduling: never-scanned roots first, then roots least recently checked.
// A limit on one monitoring cycle therefore cannot starve older conversations.
eligibleCandidates.sort((a, b) => {
  const previousA = progressByRoot.get(a.rootPostId);
  const previousB = progressByRoot.get(b.rootPostId);
  if (!previousA && previousB) return -1;
  if (previousA && !previousB) return 1;
  if (!previousA && !previousB) return new Date(b.createdAt) - new Date(a.createdAt);
  return new Date(previousA.checkedAt || 0) - new Date(previousB.checkedAt || 0);
});
const eligible = eligibleCandidates.slice(0, limit);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = async (question) => {
  const rl = readline.createInterface({ input, output });
  try { return (await rl.question(question)).trim(); }
  finally { rl.close(); }
};

let context;
let rootsChecked = 0;
let repliesAdded = 0;
const runSummary = {
  startedAt: now.toISOString(),
  mode: headless ? "headless" : "headed",
  rollingWindowDays: Number(settings.windowDays || 365),
  rootsQueued: queue.length,
  rootsSelected: eligible.length,
  roots: []
};

try {
  console.log("X visible conversation collector");
  console.log("Selected roots: " + eligible.length + " | Max scrolls/thread: " + maxScrolls);
  console.log("Profile: " + profileDir);
  console.log("Only reply cards explicitly identified by visible reply context are stored.");

  context = await launchPersistentSession({ headless });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1500);
  const sessionState = await inspectSignedInState(page);
  if (sessionState === "signed_out") throw new Error("Session signed out. Run npm run auth:check.");
  if (sessionState === "unknown") {
    if ((await ask("Confirm that the signed-in X Home timeline is visible. Type YES: ")).toUpperCase() !== "YES") {
      throw new Error("Session not confirmed.");
    }
  }

  for (const rootPost of eligible) {
    const rootId = String(rootPost.rootPostId);
    const tracked = String(rootPost.trackedCompetitor).toLowerCase();
    const status = {
      rootPostId: rootId,
      trackedCompetitor: tracked,
      status: "partial",
      completeness: "not_verified",
      newRepliesCaptured: 0,
      visibleReplyCount: 0,
      unclassifiedConversationCards: 0,
      checkedAt: new Date().toISOString()
    };
    console.log("\nThread " + tracked + ":" + rootId);
    await page.goto(rootPost.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);

    const stopAtOpen = detectStopCondition(await page.locator("body").innerText().catch(() => ""), page.url());
    if (stopAtOpen) throw new Error("Stopped by platform state: " + stopAtOpen);

    let rootVisible = false;
    let stableScreens = 0;
    let newRepliesForRoot = 0;
    let unclassifiedForRoot = 0;
    const visibleReplyIds = new Set();
    const knownByAuthor = new Map([[String(rootPost.rootAuthorUsername).toLowerCase(), rootId]]);
    let visibleMoreReplyControl = false;

    for (let scroll = 0; scroll <= maxScrolls; scroll += 1) {
      const articles = page.locator('article[data-testid="tweet"]');
      const count = await articles.count();
      let newThisScreen = 0;
      let unclassifiedThisScreen = 0;

      for (let index = 0; index < count; index += 1) {
        const card = articles.nth(index);
        const post = await extractVisiblePost(card, tracked, "conversation", { allowExternalAuthors: true });
        if (!post) continue;
        if (post.id === rootId) {
          rootVisible = true;
          continue;
        }
        if (new Date(post.createdAt) < cutoff) continue;

        // X's conversation UI can also show related or recommended cards.
        // Store a response only where the rendered card indicates reply context.
        if (!post.isReply) {
          unclassifiedThisScreen += 1;
          continue;
        }

        const key = rootId + ":" + post.id;
        visibleReplyIds.add(post.id);

        const snapshotKey = tracked + ":" + post.id;
        if (!snapshotSeenThisRun.has(snapshotKey)) {
          snapshotSeenThisRun.add(snapshotKey);
          const snapshotAt = new Date().toISOString();
          const currentMetrics = post.metrics || {};
          const previousSnapshot = latestSnapshotByPost.get(snapshotKey);
          const metricsChanged = !previousSnapshot ||
            JSON.stringify(previousSnapshot.metrics || {}) !== JSON.stringify(currentMetrics);
          const snapshotDue = !previousSnapshot ||
            (Date.now() - new Date(previousSnapshot.snapshotAt).getTime()) >= Number(settings.engagementSnapshotIntervalHours || 6) * 60 * 60 * 1000;
          if (metricsChanged || snapshotDue) {
            const snapshot = {
              trackedCompetitor: tracked,
              postId: post.id,
              postUrl: post.url,
              publishedAt: post.createdAt,
              conversationRootId: rootId,
              metrics: currentMetrics,
              previousMetrics: previousSnapshot?.metrics || null,
              snapshotAt,
              source: "x-visible-frontend-thread",
              metricSemantics: "counts_visible_at_snapshot_time_not_lifetime_delta"
            };
            fs.appendFileSync(snapshotsPath, JSON.stringify(snapshot) + "\n", { encoding: "utf8", mode: 0o600 });
            latestSnapshotByPost.set(snapshotKey, snapshot);
            engagementSnapshotsAdded += 1;
          }
        }

        if (seenReplies.has(key)) {
          knownByAuthor.set(post.authorUsername, post.id);
          continue;
        }

        const parentPostId = post.replyingToUsername
          ? (knownByAuthor.get(post.replyingToUsername) || null)
          : null;
        const reply = {
          ...post,
          trackedCompetitor: tracked,
          conversationRootId: rootId,
          parentPostId,
          postType: "reply",
          isReply: true,
          timelineView: "conversation",
          source: "x-visible-frontend-thread",
          relationships: [
            ...(post.relationships || []),
            {
              type: "appears_in_conversation_under",
              targetType: "post",
              targetId: rootId
            },
            ...(parentPostId ? [{
              type: "replies_to",
              targetType: "post",
              targetId: parentPostId
            }] : [])
          ],
          ingestedAt: new Date().toISOString()
        };
        fs.appendFileSync(replyPath, JSON.stringify(reply) + "\n", { encoding: "utf8", mode: 0o600 });
        seenReplies.add(key);
        knownByAuthor.set(post.authorUsername, post.id);
        newThisScreen += 1;
        newRepliesForRoot += 1;
        repliesAdded += 1;
      }

      unclassifiedForRoot += unclassifiedThisScreen;
      status.newRepliesCaptured = newRepliesForRoot;
      status.visibleReplyCount = visibleReplyIds.size;
      status.unclassifiedConversationCards = unclassifiedForRoot;

      // Expand only the explicit "Show more replies" control when it is visible.
      const moreReplies = page.getByText(/^show more replies$/i).first();
      visibleMoreReplyControl = false;
      try {
        if (await moreReplies.isVisible({ timeout: 250 })) {
          visibleMoreReplyControl = true;
          await moreReplies.click({ timeout: 3000 });
          await wait(1000);
        }
      } catch { /* control not present on this screen */ }

      console.log(
        "Screen " + scroll + ": " + count + " cards, " + newThisScreen +
        " new replies, " + unclassifiedThisScreen + " unclassified cards."
      );

      if (newThisScreen === 0 && !visibleMoreReplyControl) stableScreens += 1;
      else stableScreens = 0;

      if (stableScreens >= stableScreensRequired) {
        status.status = unclassifiedForRoot === 0 ? "visible_end_reached" : "partial_unclassified_cards";
        status.completeness = unclassifiedForRoot === 0 ? "ui_visible_end_not_platform_completeness" : "partial_unclassified_cards";
        break;
      }
      if (scroll === maxScrolls) {
        status.status = "safety_limit_reached";
        status.completeness = "partial";
        break;
      }

      await page.mouse.wheel(0, 1100);
      await wait(delayMs);
      const stop = detectStopCondition(await page.locator('[role="alert"], [data-testid="toast"]').allInnerTexts().then((items) => items.join("\n")).catch(() => ""), page.url());
      if (stop) throw new Error("Stopped by platform state: " + stop);
    }

    if (!rootVisible) {
      status.status = "root_post_not_visible";
      status.completeness = "partial";
    }
    status.newRepliesCaptured = newRepliesForRoot;
    status.visibleReplyCount = visibleReplyIds.size;
    status.unclassifiedConversationCards = unclassifiedForRoot;
    status.checkedAt = new Date().toISOString();
    status.windowStart = cutoff.toISOString();
    status.rootPostUrl = rootPost.url;
    fs.appendFileSync(progressPath, JSON.stringify(status) + "\n", "utf8");
    progressByRoot.set(rootId, status);
    runSummary.roots.push(status);
    rootsChecked += 1;
  }

  runSummary.completedAt = new Date().toISOString();
  runSummary.rootsChecked = rootsChecked;
  runSummary.newReplies = repliesAdded;
  runSummary.engagementSnapshotsAdded = engagementSnapshotsAdded;
  fs.appendFileSync(path.join(root, "data/output", "thread-runs.jsonl"), JSON.stringify(runSummary) + "\n", "utf8");
  console.log("\nThread collection summary:");
  console.log(JSON.stringify(runSummary, null, 2));
} catch (error) {
  runSummary.completedAt = new Date().toISOString();
  runSummary.rootsChecked = rootsChecked;
  runSummary.newReplies = repliesAdded;
  runSummary.engagementSnapshotsAdded = engagementSnapshotsAdded;
  runSummary.error = error.message;
  fs.appendFileSync(path.join(root, "data/output", "thread-runs.jsonl"), JSON.stringify(runSummary) + "\n", "utf8");
  console.error("Thread collection stopped: " + error.message);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
}
