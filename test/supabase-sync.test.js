import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSocialPostRows,
  buildEngagementSnapshotRows
} from "../scripts/sync-x-to-supabase.mjs";

const organizationId = "00000000-0000-0000-0000-000000000001";
const profilesByHandle = new Map([
  ["sgs_sa", { competitor_id: "competitor-sgs", handle: "SGS_SA" }],
  ["cotecna", { competitor_id: "competitor-cotecna", handle: "cotecna" }]
]);
const enabledTicHandles = new Set(["sgs_sa", "cotecna"]);

test("maps a tracked external thread reply to the correct competitor without changing source text", () => {
  const source = {
    id: "12345",
    trackedCompetitor: "SGS_SA",
    authorUsername: "external_user",
    text: "Report delayed. No update.",
    createdAt: "2026-11-27T10:00:00Z",
    url: "https://x.com/external_user/status/12345",
    isThreadReply: true,
    conversationRootId: "12300",
    parentPostId: "12300",
    postType: "reply",
    metrics: { replies: null, likes: 4 }
  };
  const result = buildSocialPostRows([source], {
    organizationId,
    profilesByHandle,
    enabledTicHandles,
    collectionRunId: "run-1",
    sourceFile: "conversations-tic-184d.jsonl",
    collectedAt: "2026-11-27T11:00:00Z"
  });

  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.competitor_id, "competitor-sgs");
  assert.equal(row.author_username, "external_user");
  assert.equal(row.post_text, source.text);
  assert.equal(row.source_kind, "thread_reply");
  assert.equal(row.post_type, "reply");
  assert.equal(row.is_thread_reply, true);
  assert.equal(row.conversation_root_external_id, "12300");
  assert.equal(row.parent_external_id, "12300");
  assert.equal(row.public_metrics.likes, 4);
  assert.equal(row.public_metrics.replies, null);
  assert.deepEqual(row.source_payload, source);
  assert.equal(row.collection_run_id, "run-1");
});

test("keeps quotes and reposts distinct from ordinary posts", () => {
  const records = [
    {
      id: "200",
      trackedCompetitor: "cotecna",
      authorUsername: "cotecna",
      text: "Quote post",
      createdAt: "2026-11-27T10:00:00Z",
      isQuote: true
    },
    {
      id: "201",
      trackedCompetitor: "cotecna",
      authorUsername: "cotecna",
      text: "Repost",
      createdAt: "2026-11-27T10:01:00Z",
      isRepost: true
    }
  ];
  const result = buildSocialPostRows(records, {
    organizationId,
    profilesByHandle,
    enabledTicHandles,
    collectionRunId: null,
    sourceFile: "conversations-tic-184d.jsonl"
  });
  assert.deepEqual(result.rows.map((row) => row.post_type), ["quote", "repost"]);
});

test("filters non-TIC records and reports an unmapped TIC profile instead of silently dropping it", () => {
  const result = buildSocialPostRows([
    { id: "1", trackedCompetitor: "tenlifestyle" },
    {
      id: "2",
      trackedCompetitor: "unknown_tic",
      authorUsername: "x",
      text: "text",
      createdAt: "2026-11-27T10:00:00Z"
    }
  ], {
    organizationId,
    profilesByHandle,
    enabledTicHandles: new Set(["unknown_tic"]),
    collectionRunId: null,
    sourceFile: "test.jsonl"
  });
  assert.equal(result.filteredOut, 1);
  assert.deepEqual(result.unmatchedProfiles, ["unknown_tic"]);
  assert.equal(result.rows.length, 0);
});

test("maps engagement snapshots only for posts present in the source batch", () => {
  const snapshots = [
    {
      trackedCompetitor: "sgs_sa",
      postId: "12345",
      snapshotAt: "2026-11-27T10:10:00Z",
      metrics: { likes: 9, replies: null },
      previousMetrics: { likes: 8, replies: null }
    },
    {
      trackedCompetitor: "cotecna",
      postId: "not-imported",
      snapshotAt: "2026-11-27T10:10:00Z",
      metrics: { likes: 1 }
    }
  ];
  const result = buildEngagementSnapshotRows(snapshots, {
    organizationId,
    profilesByHandle,
    enabledTicHandles,
    postKeys: new Set(["sgs_sa:12345"]),
    collectionRunId: "run-1"
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].competitor_id, "competitor-sgs");
  assert.equal(result.rows[0].external_id, "12345");
  assert.equal(result.rows[0].snapshot_at, "2026-11-27T10:10:00.000Z");
  assert.equal(result.rows[0].metrics.likes, 9);
  assert.equal(result.filteredOut, 1);
});
