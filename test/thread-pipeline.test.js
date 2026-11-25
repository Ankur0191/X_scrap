import test from "node:test";
import assert from "node:assert/strict";
import {
  buildThreadQueue,
  parseThreadPipelineOptions,
  resolveThreadPipelineFiles,
  resolveWindowBounds
} from "../src/intelligence/thread-pipeline.js";

test("parses TIC 184-day CLI options and retains the 365-day default", () => {
  assert.deepEqual(parseThreadPipelineOptions(["--domain", "TIC", "--window-days", "184"]), {
    domainId: "tic",
    windowDays: 184
  });
  assert.deepEqual(parseThreadPipelineOptions([]), { domainId: null, windowDays: 365 });
  assert.deepEqual(parseThreadPipelineOptions(["--days", "90"]), { domainId: null, windowDays: 90 });
});

test("rejects unsafe domains and invalid window lengths", () => {
  assert.throws(() => parseThreadPipelineOptions(["--domain", "../tic"]), /Invalid --domain/);
  assert.throws(() => parseThreadPipelineOptions(["--window-days", "0"]), /between 1 and 3650/);
  assert.throws(() => parseThreadPipelineOptions(["--window-days", "184.5"]), /between 1 and 3650/);
});

test("keeps existing 365-day paths backward compatible", () => {
  assert.deepEqual(resolveThreadPipelineFiles({}), {
    posts: "posts-365d.jsonl",
    queue: "thread-queue-365d.jsonl",
    replies: "thread-replies.jsonl",
    progress: "thread-progress.jsonl",
    ancestors: "thread-ancestors.jsonl",
    runs: "thread-runs.jsonl",
    snapshots: "engagement-snapshots.jsonl",
    conversation: "conversation-365d.jsonl",
    conversationManifest: "conversation-manifest.json",
    windowManifest: "window-manifest.json"
  });
});

test("uses dedicated TIC 184-day paths for every conversation artifact", () => {
  assert.deepEqual(resolveThreadPipelineFiles({ domainId: "tic", windowDays: 184 }), {
    posts: "posts-tic-184d.jsonl",
    queue: "thread-queue-tic-184d.jsonl",
    replies: "thread-replies-tic-184d.jsonl",
    progress: "thread-progress-tic-184d.jsonl",
    ancestors: "thread-ancestors-tic-184d.jsonl",
    runs: "thread-runs-tic-184d.jsonl",
    snapshots: "engagement-snapshots.jsonl",
    conversation: "conversations-tic-184d.jsonl",
    conversationManifest: "conversation-manifest-tic-184d.json",
    windowManifest: "window-manifest-tic-184d.json"
  });
});

test("filters queue roots to the requested domain and deduplicates account/post IDs", () => {
  const domainByCompetitor = new Map([
    ["sgs_sa", "tic"],
    ["cotecna", "tic"],
    ["tenlifestyle", "aspire_lifestyle"]
  ]);
  const root = (id, trackedCompetitor, authorUsername = trackedCompetitor) => ({
    id,
    trackedCompetitor,
    authorUsername,
    timelineView: "posts",
    isReply: false,
    isRepost: false,
    createdAt: "2026-11-20T10:00:00.000Z",
    url: "https://x.com/" + trackedCompetitor + "/status/" + id,
    text: "Post " + id
  });
  const queue = buildThreadQueue([
    root("101", "SGS_SA"),
    root("101", "sgs_sa"),
    root("202", "cotecna"),
    root("303", "tenlifestyle"),
    root("404", "sgs_sa", "customer"),
    { ...root("505", "sgs_sa"), isReply: true },
    { ...root("606", "sgs_sa"), isRepost: true }
  ], {
    domainId: "tic",
    windowDays: 184,
    domainByCompetitor,
    sourceFile: "posts-tic-184d.jsonl"
  });

  assert.deepEqual(queue.map((item) => item.rootPostId), ["101", "202"]);
  assert.deepEqual(queue.map((item) => item.domainId), ["tic", "tic"]);
  assert.deepEqual(queue.map((item) => item.windowDays), [184, 184]);
  assert.deepEqual(queue.map((item) => item.source), ["posts-tic-184d.jsonl", "posts-tic-184d.jsonl"]);
});

test("uses the recorded source window boundaries for matching domain and duration", () => {
  const now = new Date("2026-11-25T12:00:00.000Z");
  const sourceManifest = {
    window: {
      days: 184,
      startInclusive: "2026-05-23T10:00:00.000Z",
      endInclusive: "2026-11-23T10:00:00.000Z"
    },
    source: { domainFilter: "tic" }
  };
  const resolved = resolveWindowBounds(sourceManifest, { domainId: "tic", windowDays: 184, now });
  assert.equal(resolved.startInclusive.toISOString(), "2026-05-23T10:00:00.000Z");
  assert.equal(resolved.endInclusive.toISOString(), "2026-11-23T10:00:00.000Z");
  assert.equal(resolved.source, "window_manifest");
});

test("falls back to a rolling window when manifest scope does not match", () => {
  const now = new Date("2026-11-25T12:00:00.000Z");
  const sourceManifest = {
    window: { days: 184, startInclusive: "2026-05-23T10:00:00.000Z", endInclusive: "2026-11-23T10:00:00.000Z" },
    source: { domainFilter: "aspire_lifestyle" }
  };
  const resolved = resolveWindowBounds(sourceManifest, { domainId: "tic", windowDays: 184, now });
  assert.equal(resolved.startInclusive.toISOString(), new Date(now.getTime() - 184 * 86400000).toISOString());
  assert.equal(resolved.endInclusive.toISOString(), now.toISOString());
  assert.equal(resolved.source, "rolling_window_fallback");
});
