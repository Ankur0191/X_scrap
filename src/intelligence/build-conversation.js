import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const daysIndex = args.indexOf("--days");
const daysArg = daysIndex >= 0 ? Number(args[daysIndex + 1]) : null;
const config = JSON.parse(fs.readFileSync(path.join(root, "config/competitors.json"), "utf8"));
const windowDays = Number.isFinite(daysArg) && daysArg > 0 ? Math.min(daysArg, 3650) : Number(config.collection?.windowDays || 365);
const generatedAt = new Date();
const cutoff = new Date(generatedAt.getTime() - windowDays * 86400000);
const postsPath = path.join(root, "data/output", "posts-" + windowDays + "d.jsonl");
const repliesPath = path.join(root, "data/output/thread-replies.jsonl");
const outputPath = path.join(root, "data/output", "conversation-" + windowDays + "d.jsonl");
const manifestPath = path.join(root, "data/output/conversation-manifest.json");

if (!fs.existsSync(postsPath)) {
  console.error("Active post file not found. Run npm run build:window first.");
  process.exit(2);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const rows = [];
  for (const [index, line] of fs.readFileSync(filePath, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch (error) { console.warn("Skipping malformed line " + (index + 1) + " in " + filePath + ": " + error.message); }
  }
  return rows;
}

const records = new Map();
for (const post of readJsonl(postsPath)) {
  const date = new Date(post.createdAt);
  if (Number.isNaN(date.getTime()) || date < cutoff || date > generatedAt) continue;
  const key = String(post.trackedCompetitor).toLowerCase() + ":" + String(post.id);
  records.set(key, {
    ...post,
    isThreadReply: false,
    conversationRootIds: post.conversationRootId ? [String(post.conversationRootId)] : []
  });
}

let acceptedThreadRows = 0;
let duplicateThreadRows = 0;
for (const reply of readJsonl(repliesPath)) {
  const date = new Date(reply.createdAt);
  if (Number.isNaN(date.getTime()) || date < cutoff || date > generatedAt) continue;
  const tracked = String(reply.trackedCompetitor || "").toLowerCase();
  const key = tracked + ":" + String(reply.id);
  const rootId = reply.conversationRootId ? String(reply.conversationRootId) : null;
  const existing = records.get(key);

  if (existing) {
    duplicateThreadRows += 1;
    existing.isThreadReply = true;
    if (rootId && !existing.conversationRootIds.includes(rootId)) existing.conversationRootIds.push(rootId);
    if (reply.parentPostId) existing.parentPostId = String(reply.parentPostId);
    existing.relationships = [
      ...(existing.relationships || []),
      ...(reply.relationships || [])
    ];
    continue;
  }

  records.set(key, {
    ...reply,
    isThreadReply: true,
    conversationRootIds: rootId ? [rootId] : []
  });
  acceptedThreadRows += 1;
}

const merged = [...records.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
fs.writeFileSync(outputPath, merged.map((record) => JSON.stringify(record)).join("\n") + (merged.length ? "\n" : ""), {
  encoding: "utf8",
  mode: 0o600
});

const byCompetitor = {};
const byPostType = {};
const publicThreadRepliesByCompetitor = {};
for (const item of merged) {
  const competitor = String(item.trackedCompetitor).toLowerCase();
  byCompetitor[competitor] = (byCompetitor[competitor] || 0) + 1;
  byPostType[item.postType || "unknown"] = (byPostType[item.postType || "unknown"] || 0) + 1;
  if (item.isThreadReply) publicThreadRepliesByCompetitor[competitor] = (publicThreadRepliesByCompetitor[competitor] || 0) + 1;
}

const progressPath = path.join(root, "data/output/thread-progress.jsonl");
const progressRows = readJsonl(progressPath);
const latestProgressByRoot = new Map();
for (const item of progressRows) {
  const rootId = String(item.rootPostId || "");
  if (!rootId) continue;
  const previous = latestProgressByRoot.get(rootId);
  if (!previous || new Date(item.checkedAt || 0) >= new Date(previous.checkedAt || 0)) {
    latestProgressByRoot.set(rootId, item);
  }
}
const latestProgress = [...latestProgressByRoot.values()];
const progressSummary = latestProgress.reduce((acc, item) => {
  acc[item.status || "unknown"] = (acc[item.status || "unknown"] || 0) + 1;
  return acc;
}, {});
const progressByCompetitor = {};
for (const item of latestProgress) {
  const handle = String(item.trackedCompetitor || "unknown").toLowerCase();
  if (!progressByCompetitor[handle]) progressByCompetitor[handle] = {};
  const status = item.status || "unknown";
  progressByCompetitor[handle][status] = (progressByCompetitor[handle][status] || 0) + 1;
}

const manifest = {
  schemaVersion: "1.0.0",
  generatedAt: generatedAt.toISOString(),
  window: {
    days: windowDays,
    startInclusive: cutoff.toISOString(),
    endInclusive: generatedAt.toISOString(),
    timezone: "UTC"
  },
  output: "data/output/conversation-" + windowDays + "d.jsonl",
  counts: {
    totalUniqueCompetitorRecords: merged.length,
    byCompetitor,
    byPostType,
    publicThreadRepliesAdded: acceptedThreadRows,
    threadRowsMergedIntoExistingProfileReplies: duplicateThreadRows,
    publicThreadRepliesByCompetitor
  },
  threadCoverage: {
    totalRootPostsInProgressLog: progressRows.length,
    uniqueRootPosts: latestProgress.length,
    statusCounts: progressSummary,
    byCompetitor: progressByCompetitor,
    warning: "visible_end_reached indicates the visible UI stopped yielding identified replies; it is not proof that X exposed every reply."
  }
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
console.log(JSON.stringify(manifest, null, 2));
