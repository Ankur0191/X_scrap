import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { launchPersistentSession, inspectSignedInState } from "../auth/session.js";
import { profileDir } from "../auth/profile.js";
import { extractVisiblePost, detectStopCondition, classifyVisibleThreadReply, selectConversationAncestor, isProbableSpamControlLabel } from "./visible-post.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(fs.readFileSync(path.join(root, "config/competitors.json"), "utf8"));
const args = process.argv.slice(2);
const limitIndex = args.indexOf("--limit");
const limit = limitIndex >= 0 ? Math.max(1, Number(args[limitIndex + 1]) || 1) : Infinity;
const accountIndex = args.indexOf("--account");
const accountFilter = accountIndex >= 0 ? String(args[accountIndex + 1] || "").replace(/^@/, "").toLowerCase() : null;
const postIdIndex = args.indexOf("--post-id");
const postIdFilter = postIdIndex >= 0 ? String(args[postIdIndex + 1] || "").trim() : null;
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
const activePostsPath = path.join(root, "data/output/posts-" + Number(settings.windowDays || 365) + "d.jsonl");
const ancestorsPath = path.join(root, "data/output/thread-ancestors.jsonl");
if (!fs.existsSync(queuePath)) {
  console.error("Thread queue missing. Run npm run threads:queue first.");
  process.exit(2);
}
if (headless && !settings.allowHeadless) {
  throw new Error("Headless mode remains disabled. Use headed Chromium for thread validation.");
}

let queue = fs.readFileSync(queuePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  .filter((item) => !accountFilter || item.trackedCompetitor === accountFilter)
  .filter((item) => !postIdFilter || String(item.rootPostId) === postIdFilter);

let diagnosticAnchorOutsideRootQueue = false;
if (postIdFilter && queue.length === 0 && fs.existsSync(activePostsPath)) {
  // Explicit --post-id may target a competitor response discovered on the
  // with_replies timeline. It is diagnostic-only and never enters the
  // scheduled independent-root queue.
  for (const line of fs.readFileSync(activePostsPath, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      const post = JSON.parse(line);
      const tracked = String(post.trackedCompetitor || "").replace(/^@/, "").toLowerCase();
      const author = String(post.authorUsername || "").replace(/^@/, "").toLowerCase();
      if (
        String(post.id) === postIdFilter &&
        tracked &&
        author === tracked &&
        post.timelineView === "with_replies" &&
        !post.isRepost
      ) {
        queue.push({
          rootPostId: String(post.id),
          trackedCompetitor: tracked,
          rootAuthorUsername: author,
          createdAt: post.createdAt,
          url: post.url,
          text: post.text || "",
          diagnosticOnly: true,
          source: "explicit_with_replies_diagnostic_anchor"
        });
        diagnosticAnchorOutsideRootQueue = true;
        break;
      }
    } catch { /* ignore malformed profile rows */ }
  }
}
if (postIdFilter && queue.length === 0) {
  console.error("No queued root or explicit with_replies diagnostic anchor matches --post-id " + postIdFilter + ".");
  process.exit(2);
}

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
const seenAncestors = new Set();
if (fs.existsSync(ancestorsPath)) {
  for (const line of fs.readFileSync(ancestorsPath, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      const item = JSON.parse(line);
      seenAncestors.add(String(item.trackedCompetitor || "").toLowerCase() + ":" +
        String(item.id || "") + ":" + String(item.ancestorForPostId || ""));
    } catch { /* ignore malformed historical ancestor rows */ }
  }
}
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
  // An explicit diagnostic target should be rechecked even if its previous UI scan reached the visible end.
  if (postIdFilter) return true;
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

async function expandVisibleProbableSpamSections(page, attemptedControlKeys) {
  const clickedLabels = [];
  const labelsSeen = new Set();
  let sectionsRevealed = 0;

  const inspectAndClick = async (candidate, source) => {
    if (!(await candidate.isVisible({ timeout: 150 }).catch(() => false))) return false;

    const details = await candidate.evaluate((element) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const target = source === "text"
        ? (element.closest('button, [role="button"]') || element)
        : element;
      return {
        tag: target.tagName || "",
        role: target.getAttribute("role") || "",
        ariaLabel: normalize(target.getAttribute("aria-label")),
        title: normalize(target.getAttribute("title")),
        text: normalize(target.innerText || target.textContent),
        testId: target.getAttribute("data-testid") || ""
      };
    }, { source }).catch(() => null);
    if (!details) return false;

    const label = [details.ariaLabel, details.title, details.text]
      .filter(Boolean).join(" | ").replace(/\s+/g, " ").trim();
    if (/spam/i.test(label)) labelsSeen.add(label.slice(0, 180));
    if (!isProbableSpamControlLabel(label)) return false;

    const key = [
      details.tag, details.role, details.testId,
      details.ariaLabel, details.title, details.text
    ].join("|").toLowerCase();
    if (attemptedControlKeys.has(key)) return false;
    attemptedControlKeys.add(key);

    const beforeCount = await page.locator('article[data-testid="tweet"]').count();
    await candidate.click({ timeout: 3000 });
    clickedLabels.push(label.slice(0, 180));
    await wait(1300);
    const afterCount = await page.locator('article[data-testid="tweet"]').count();

    // Count an expansion only when the rendered conversation gains cards.
    // A successful click without newly rendered cards remains a click attempt,
    // not proof that X revealed the hidden replies.
    if (afterCount > beforeCount) sectionsRevealed += 1;
    return true;
  };

  // Use semantic buttons first. This avoids clicking several nested descendants
  // of the same visible spam control.
  const buttons = page.locator('button, [role="button"]');
  const buttonCount = await buttons.count();
  for (let index = 0; index < buttonCount; index += 1) {
    const clicked = await inspectAndClick(buttons.nth(index), "button").catch(() => false);
    if (clicked) break; // one distinct control per screen pass
  }

  // X has used non-semantic clickable containers for this control. Fall back
  // to the smallest matching text node only when no semantic button was clicked.
  if (clickedLabels.length === 0) {
    const textCandidates = page.getByText(/probable\s+spam/i);
    const textCount = await textCandidates.count();
    for (let index = 0; index < textCount; index += 1) {
      const clicked = await inspectAndClick(textCandidates.nth(index), "text").catch(() => false);
      if (clicked) break;
    }
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const visibleSpamText = [...new Set(
    bodyText.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => /spam/i.test(line))
      .map((line) => line.slice(0, 180))
  )].slice(0, 10);

  return {
    clicked: clickedLabels.length,
    clickedLabels,
    revealed: sectionsRevealed,
    labelsSeen: [...labelsSeen].slice(0, 10),
    visibleSpamText
  };
}
const ask = async (question) => {
  const rl = readline.createInterface({ input, output });
  try { return (await rl.question(question)).trim(); }
  finally { rl.close(); }
};

let context;
let rootsChecked = 0;
let repliesAdded = 0;
let ancestorsAdded = 0;
const runSummary = {
  startedAt: now.toISOString(),
  mode: headless ? "headless" : "headed",
  rollingWindowDays: Number(settings.windowDays || 365),
  rootsQueued: queue.length,
  rootsSelected: eligible.length,
  diagnosticAnchorOutsideRootQueue,
  ancestorsAdded: 0,
  probableSpamSectionsClicked: 0,
  probableSpamSectionsExpanded: 0,
  roots: []
};

try {
  console.log("X visible conversation collector");
  console.log("Selected roots: " + eligible.length + " | Max scrolls/thread: " + maxScrolls);
  console.log("Profile: " + profileDir);
  console.log("Reply detection uses explicit UI context or bounded root-card order when X omits the reply label.");
  if (diagnosticAnchorOutsideRootQueue) console.log("Explicit diagnostic anchor loaded from with_replies; it remains excluded from the scheduled root queue.");

  context = await launchPersistentSession({ headless });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1500);
  const sessionState = await inspectSignedInState(page);
  if (sessionState === "signed_out") throw new Error("Session signed out. Run npm run auth:check.");
  if (sessionState === "unknown") {
    if (process.env.X_NONINTERACTIVE === "1") {
      throw new Error("Scheduled thread run stopped: the signed-in session could not be confirmed automatically.");
    }
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
      ancestorCandidatesFound: 0,
      newAncestorsCaptured: 0,
      probableSpamSectionsClicked: 0,
      probableSpamSectionsExpanded: 0,
      probableSpamControlLabelsSeen: [],
      probableSpamTextSeen: [],
      checkedAt: new Date().toISOString()
    };
    console.log("\nThread " + tracked + ":" + rootId);
    await page.goto(rootPost.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    try {
      await page.locator('article[data-testid="tweet"]').first().waitFor({
        state: "visible",
        timeout: 10000
      });
    } catch {
      // Continue to the normal stop/root visibility checks; do not infer success.
    }
    await page.waitForTimeout(500);

    const stopAtOpen = detectStopCondition(await page.locator("body").innerText().catch(() => ""), page.url());
    if (stopAtOpen) throw new Error("Stopped by platform state: " + stopAtOpen);

    let rootVisible = false;
    let rootReplyCount = null;
    let rootCreatedAt = null;
    let stableScreens = 0;
    let newRepliesForRoot = 0;
    let unclassifiedForRoot = 0;
    const visibleReplyIds = new Set();
    const visibleExternalReplyAuthors = new Set();
    const visibleExternalReplies = new Map();
    const unclassifiedCardIds = new Set();
    const unclassifiedCards = new Map();
    let lastRootArticleIndex = -1;
    let newAncestorsForRoot = 0;
    let ancestorCandidatesFoundForRoot = 0;
    const knownByAuthor = new Map([[String(rootPost.rootAuthorUsername).toLowerCase(), rootId]]);
    const attemptedProbableSpamControlKeys = new Set();
    let visibleMoreReplyControl = false;

    for (let scroll = 0; scroll <= maxScrolls; scroll += 1) {
      // X may hide replies behind its "Show probable spam" control. Expand
      // these sections before counting/extracting cards so reply detection
      // sees the newly revealed cards on this same screen.
      const probableSpamResult = await expandVisibleProbableSpamSections(
        page,
        attemptedProbableSpamControlKeys
      );
      const probableSpamExpandedThisScreen = probableSpamResult.revealed;
      status.probableSpamSectionsClicked += probableSpamResult.clicked;
      runSummary.probableSpamSectionsClicked += probableSpamResult.clicked;
      for (const label of probableSpamResult.labelsSeen) {
        if (!status.probableSpamControlLabelsSeen.includes(label)) {
          status.probableSpamControlLabelsSeen.push(label);
        }
      }
      for (const label of probableSpamResult.clickedLabels) {
        if (!status.probableSpamControlLabelsSeen.includes(label)) {
          status.probableSpamControlLabelsSeen.push(label);
        }
      }
      for (const line of probableSpamResult.visibleSpamText) {
        if (!status.probableSpamTextSeen.includes(line)) {
          status.probableSpamTextSeen.push(line);
        }
      }
      if (probableSpamResult.clicked > 0) {
        console.log("Clicked probable-spam control: " + JSON.stringify({
          labels: probableSpamResult.clickedLabels,
          newCardsRevealed: probableSpamExpandedThisScreen
        }));
      } else if (probableSpamResult.labelsSeen.length || probableSpamResult.visibleSpamText.length) {
        console.log("Probable-spam UI diagnostics: " + JSON.stringify({
          controlLabels: probableSpamResult.labelsSeen,
          visibleText: probableSpamResult.visibleSpamText
        }));
      }
      if (probableSpamExpandedThisScreen > 0) {
        status.probableSpamSectionsExpanded += probableSpamExpandedThisScreen;
        runSummary.probableSpamSectionsExpanded += probableSpamExpandedThisScreen;
      }

      const articles = page.locator('article[data-testid="tweet"]');
      const count = await articles.count();
      let newThisScreen = 0;
      let unclassifiedThisScreen = 0;
      let rootArticleIndex = -1;

      for (let index = 0; index < count; index += 1) {
        const card = articles.nth(index);
        const post = await extractVisiblePost(card, tracked, "conversation", { allowExternalAuthors: true });
        if (!post) continue;
        if (post.id === rootId) {
          rootVisible = true;
          rootArticleIndex = index;
          lastRootArticleIndex = index;
          rootReplyCount = post.metrics?.replies ?? rootReplyCount;
          rootCreatedAt = post.createdAt;
          continue;
        }
        if (new Date(post.createdAt) < cutoff) continue;

        // Cards remain mounted across scroll screens. Once a post has been
        // classified as a reply in this root, do not reclassify it as unrelated.
        if (visibleReplyIds.has(post.id)) continue;

        // Prefer explicit reply context. X sometimes omits "Replying to" on
        // inline replies, so allow a bounded positional fallback only when the
        // root is visible on this same screen and its own visible reply count
        // supports another reply card.
        const replyClassification = classifyVisibleThreadReply({
          explicitReply: post.isReply,
          candidateIndex: index,
          rootIndex: rootArticleIndex,
          rootReplyCount,
          candidateCreatedAt: post.createdAt,
          rootCreatedAt,
          alreadyClassifiedCount: visibleReplyIds.size
        });
        if (!replyClassification.isReply) {
          // Count unique visible cards, not the same persistent card once per scroll screen.
          unclassifiedCards.set(post.id, { post, index });
          if (!unclassifiedCardIds.has(post.id)) {
            unclassifiedCardIds.add(post.id);
            unclassifiedThisScreen += 1;
            console.log("Unclassified visible card: " + JSON.stringify({
              id: post.id,
              authorUsername: post.authorUsername,
              createdAt: post.createdAt,
              url: post.url,
              socialContext: post.socialContext,
              text: String(post.text || "").slice(0, 240),
              replyingToUsername: post.replyingToUsername,
              postType: post.postType
            }));
          }
          continue;
        }

        post.isReply = true;
        post.postType = "reply";
        post.replyDetectionMethod = replyClassification.method;
        const key = rootId + ":" + post.id;
        unclassifiedCardIds.delete(post.id);
        unclassifiedCards.delete(post.id);
        visibleReplyIds.add(post.id);
        if (post.authorUsername !== tracked) {
          visibleExternalReplyAuthors.add(post.authorUsername);
          visibleExternalReplies.set(post.id, post);
        }

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
          : replyClassification.method === "root_reply_count_order" ? rootId : null;
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
              targetType: "social_post",
              targetId: rootId
            },
            ...(parentPostId ? [{
              type: "replies_to",
              targetType: "social_post",
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

      unclassifiedForRoot = unclassifiedCardIds.size;
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

      if (newThisScreen === 0 && !visibleMoreReplyControl && probableSpamResult.clicked === 0) stableScreens += 1;
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

    // Discover a possible parent message above the selected competitor post.
    // We only retain an earlier external card when its author also appears in a
    // captured external reply under this root. This is a candidate relationship,
    // not a claim that the parent edge has been conclusively verified.
    if (rootVisible && lastRootArticleIndex >= 0) {
      // A tracked competitor post displayed above the selected anchor is not
      // an external parent candidate; exclude it from unclassified-card counts.
      for (const item of unclassifiedCards.values()) {
        if (item.index < lastRootArticleIndex && item.post.authorUsername === tracked) {
          unclassifiedCardIds.delete(item.post.id);
        }
      }
    }

    if (rootVisible && visibleExternalReplyAuthors.size && lastRootArticleIndex >= 0 && rootCreatedAt) {
      const ancestorResult = selectConversationAncestor({
        candidates: [...unclassifiedCards.values()]
          .filter((item) => item.index < lastRootArticleIndex)
          .map((item) => item.post),
        rootAuthorUsername: tracked,
        rootCreatedAt,
        externalReplyAuthors: [...visibleExternalReplyAuthors],
        maxAgeHours: Number(settings.maxAncestorAgeHours || 72)
      });
      if (ancestorResult) {
        ancestorCandidatesFoundForRoot = 1;
        const candidate = ancestorResult.candidate;
        const matchingReplyIds = [...visibleExternalReplies.values()]
          .filter((reply) => reply.authorUsername === ancestorResult.matchedReplyAuthor)
          .map((reply) => String(reply.id));
        const ancestorKey = tracked + ":" + candidate.id + ":" + rootId;
        unclassifiedCardIds.delete(candidate.id);
        if (!seenAncestors.has(ancestorKey)) {
          const ancestorRow = {
            ...candidate,
            trackedCompetitor: tracked,
            isThreadAncestor: true,
            isThreadReply: false,
            ancestorForPostId: rootId,
            candidateReplyIds: matchingReplyIds,
            matchedReplyAuthor: ancestorResult.matchedReplyAuthor,
            ancestorDiscoveryMethod: ancestorResult.discoveryMethod,
            ancestorRelationshipStatus: ancestorResult.relationshipStatus,
            source: "x-visible-frontend-thread-ancestor",
            ingestedAt: new Date().toISOString()
          };
          fs.appendFileSync(ancestorsPath, JSON.stringify(ancestorRow) + "\n", {
            encoding: "utf8",
            mode: 0o600
          });
          seenAncestors.add(ancestorKey);
          ancestorsAdded += 1;
          newAncestorsForRoot += 1;
          console.log("Ancestor candidate saved: " + JSON.stringify({
            id: candidate.id,
            authorUsername: candidate.authorUsername,
            ancestorForPostId: rootId,
            relationshipStatus: ancestorResult.relationshipStatus,
            discoveryMethod: ancestorResult.discoveryMethod,
            candidateReplyIds: matchingReplyIds
          }));
        } else {
          console.log("Ancestor candidate already saved: " + candidate.id);
        }
      }
    }

    unclassifiedForRoot = unclassifiedCardIds.size;
    status.ancestorCandidatesFound = ancestorCandidatesFoundForRoot;
    status.newAncestorsCaptured = newAncestorsForRoot;
    if (!rootVisible) {
      status.status = "root_post_not_visible";
      status.completeness = "partial";
    } else if (unclassifiedForRoot === 0 && status.status === "partial_unclassified_cards") {
      status.status = "visible_end_reached";
      status.completeness = "ui_visible_end_not_platform_completeness";
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
  runSummary.ancestorsAdded = ancestorsAdded;
  runSummary.engagementSnapshotsAdded = engagementSnapshotsAdded;
  fs.appendFileSync(path.join(root, "data/output", "thread-runs.jsonl"), JSON.stringify(runSummary) + "\n", "utf8");
  console.log("\nThread collection summary:");
  console.log(JSON.stringify(runSummary, null, 2));
} catch (error) {
  runSummary.completedAt = new Date().toISOString();
  runSummary.rootsChecked = rootsChecked;
  runSummary.newReplies = repliesAdded;
  runSummary.ancestorsAdded = ancestorsAdded;
  runSummary.engagementSnapshotsAdded = engagementSnapshotsAdded;
  runSummary.error = error.message;
  fs.appendFileSync(path.join(root, "data/output", "thread-runs.jsonl"), JSON.stringify(runSummary) + "\n", "utf8");
  console.error("Thread collection stopped: " + error.message);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
}
