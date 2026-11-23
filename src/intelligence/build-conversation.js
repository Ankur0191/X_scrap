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
const ancestorsPath = path.join(root, "data/output/thread-ancestors.jsonl");
const engagementPath = path.join(root, "data/output/engagement-snapshots.jsonl");
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

let acceptedAncestorRows = 0;
let mergedAncestorRows = 0;
const candidateAncestorsByCompetitor = {};
for (const ancestor of readJsonl(ancestorsPath)) {
  const date = new Date(ancestor.createdAt);
  if (Number.isNaN(date.getTime()) || date < cutoff || date > generatedAt) continue;

  const tracked = String(ancestor.trackedCompetitor || "").toLowerCase();
  const ancestorId = String(ancestor.id || "");
  const childRootId = String(ancestor.ancestorForPostId || "");
  if (!tracked || !ancestorId || !childRootId || ancestorId === childRootId) continue;

  const ancestorKey = tracked + ":" + ancestorId;
  const rootKey = tracked + ":" + childRootId;
  const relationship = {
    type: "candidate_parent_of",
    targetType: "social_post",
    targetId: childRootId,
    relationshipStatus: ancestor.ancestorRelationshipStatus || "candidate_unverified",
    discoveryMethod: ancestor.ancestorDiscoveryMethod || "unknown"
  };

  let ancestorRecord = records.get(ancestorKey);
  if (!ancestorRecord) {
    ancestorRecord = {
      ...ancestor,
      isThreadReply: false,
      isThreadAncestor: true,
      conversationRootId: childRootId,
      conversationRootIds: [childRootId],
      ancestorForPostId: childRootId,
      ancestorForPostIds: [childRootId],
      candidateReplyIds: Array.isArray(ancestor.candidateReplyIds) ? ancestor.candidateReplyIds.map(String) : [],
      ancestorRelationshipStatus: ancestor.ancestorRelationshipStatus || "candidate_unverified",
      ancestorDiscoveryMethod: ancestor.ancestorDiscoveryMethod || "unknown"
    };
    records.set(ancestorKey, ancestorRecord);
    acceptedAncestorRows += 1;
  } else {
    mergedAncestorRows += 1;
    ancestorRecord.isThreadAncestor = true;
    ancestorRecord.ancestorForPostIds = [...new Set([
      ...(ancestorRecord.ancestorForPostIds || (ancestorRecord.ancestorForPostId ? [ancestorRecord.ancestorForPostId] : [])),
      childRootId
    ])];
    ancestorRecord.candidateReplyIds = [...new Set([
      ...(ancestorRecord.candidateReplyIds || []),
      ...(Array.isArray(ancestor.candidateReplyIds) ? ancestor.candidateReplyIds.map(String) : [])
    ])];
  }

  ancestorRecord.relationships = [
    ...(ancestorRecord.relationships || []),
    relationship
  ];

  const rootRecord = records.get(rootKey);
  if (rootRecord) {
    rootRecord.candidateParentPostIds = [...new Set([
      ...(rootRecord.candidateParentPostIds || []),
      ancestorId
    ])];
    rootRecord.ancestorRelationshipStatus = "candidate_unverified";
    rootRecord.relationships = [
      ...(rootRecord.relationships || []),
      {
        type: "has_candidate_parent",
        targetType: "social_post",
        targetId: ancestorId,
        relationshipStatus: ancestor.ancestorRelationshipStatus || "candidate_unverified",
        discoveryMethod: ancestor.ancestorDiscoveryMethod || "unknown"
      }
    ];
  }

  candidateAncestorsByCompetitor[tracked] = (candidateAncestorsByCompetitor[tracked] || 0) + 1;
}

let acceptedThreadRows = 0;
let acceptedExternalPublicReplies = 0;
let acceptedCompetitorAuthoredReplies = 0;
let mergedExternalPublicReplies = 0;
let mergedCompetitorAuthoredReplies = 0;
for (const reply of readJsonl(repliesPath)) {
  const date = new Date(reply.createdAt);
  if (Number.isNaN(date.getTime()) || date < cutoff || date > generatedAt) continue;
  const tracked = String(reply.trackedCompetitor || "").toLowerCase();
  const key = tracked + ":" + String(reply.id);
  const rootId = reply.conversationRootId ? String(reply.conversationRootId) : null;
  const existing = records.get(key);

  const replyAuthor = String(reply.authorUsername || "").toLowerCase();
  const isExternalPublicReply = replyAuthor !== tracked;

  if (existing) {
    if (isExternalPublicReply) mergedExternalPublicReplies += 1;
    else mergedCompetitorAuthoredReplies += 1;
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
  if (isExternalPublicReply) acceptedExternalPublicReplies += 1;
  else acceptedCompetitorAuthoredReplies += 1;
}

const engagementByPost = new Map();
const engagementSnapshotRows = readJsonl(engagementPath);
for (const snapshot of engagementSnapshotRows) {
  const key = String(snapshot.trackedCompetitor || "").toLowerCase() + ":" + String(snapshot.postId || "");
  if (!key.endsWith(":")) {
    if (!engagementByPost.has(key)) engagementByPost.set(key, []);
    engagementByPost.get(key).push(snapshot);
  }
}

for (const [key, record] of records) {
  const history = (engagementByPost.get(key) || [])
    .sort((a, b) => new Date(a.snapshotAt) - new Date(b.snapshotAt));
  if (!history.length) continue;
  const latest = history[history.length - 1];
  const previous = history.length > 1 ? history[history.length - 2] : null;
  const observedChange = {};
  if (previous) {
    for (const metric of ["replies", "reposts", "likes", "views"]) {
      const before = previous.metrics?.[metric];
      const after = latest.metrics?.[metric];
      observedChange[metric] =
        Number.isFinite(Number(before)) && Number.isFinite(Number(after))
          ? Number(after) - Number(before)
          : null;
    }
  }
  record.engagementHistory = {
    snapshotCount: history.length,
    firstSnapshotAt: history[0].snapshotAt,
    latestSnapshotAt: latest.snapshotAt,
    latestMetrics: latest.metrics || {},
    previousMetrics: previous?.metrics || null,
    observedChangeSincePreviousSnapshot: previous ? observedChange : null,
    recentSnapshots: history.slice(-10).map((item) => ({
      snapshotAt: item.snapshotAt,
      metrics: item.metrics || {}
    })),
    semantics: "observed visible count change between snapshots; not an authoritative lifetime metric delta"
  };
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
  if (item.isThreadReply) {
    const author = String(item.authorUsername || "").toLowerCase();
    if (author !== competitor) {
      publicThreadRepliesByCompetitor[competitor] = (publicThreadRepliesByCompetitor[competitor] || 0) + 1;
    }
  }
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
    recordsWithEngagementHistory: merged.filter((item) => item.engagementHistory).length,
    engagementSnapshotsAvailable: engagementSnapshotRows.length,
    byCompetitor,
    byPostType,
    threadRepliesAdded: acceptedThreadRows,
    externalPublicThreadRepliesAdded: acceptedExternalPublicReplies,
    competitorAuthoredThreadRepliesAdded: acceptedCompetitorAuthoredReplies,
    externalPublicThreadRepliesMergedWithProfileRecords: mergedExternalPublicReplies,
    competitorAuthoredThreadRepliesMergedWithProfileRecords: mergedCompetitorAuthoredReplies,
    threadAncestorsAdded: acceptedAncestorRows,
    threadAncestorRowsMerged: mergedAncestorRows,
    candidateAncestorsByCompetitor,
    recordsWithCandidateParents: merged.filter((item) => Array.isArray(item.candidateParentPostIds) && item.candidateParentPostIds.length > 0).length,
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
