import test from "node:test";
import assert from "node:assert/strict";
import { parseCount, metricFromLabel, extractHashtagsAndMentions, classifyVisibleThreadReply } from "../src/collector/visible-post.js";

test("parses compact engagement counts", () => {
  assert.equal(parseCount("1.2K"), 1200);
  assert.equal(parseCount("2M"), 2000000);
  assert.equal(parseCount("1,234"), 1234);
  assert.equal(parseCount("not available"), null);
});

test("maps visible X action labels to metric fields", () => {
  assert.deepEqual(metricFromLabel("1.2K Likes. Like"), ["likes", 1200]);
  assert.deepEqual(metricFromLabel("43 Replies. Reply"), ["replies", 43]);
  assert.deepEqual(metricFromLabel("8 reposts. Repost"), ["reposts", 8]);
  assert.equal(metricFromLabel("Reply"), null);
});

test("extracts unicode hashtags and explicit account mentions", () => {
  const result = extractHashtagsAndMentions("We launched #AI #TIC and partnered with @ExampleOrg.");
  assert.deepEqual(result.hashtags.map((item) => item.normalized), ["ai", "tic"]);
  assert.deepEqual(result.mentions.map((item) => item.normalized), ["exampleorg"]);
  assert.equal(result.hashtags[0].start >= 0, true);
});

test("deduplicates repeated tags while preserving original label", () => {
  const result = extractHashtagsAndMentions("#SGS and #sgs are part of this update.");
  assert.equal(result.hashtags.length, 1);
  assert.equal(result.hashtags[0].normalized, "sgs");
  assert.equal(result.hashtags[0].label, "SGS");
});

test("classifies an inline reply when X omits the replying-to label but root count and order support it", () => {
  assert.deepEqual(classifyVisibleThreadReply({
    explicitReply: false,
    candidateIndex: 1,
    rootIndex: 0,
    rootReplyCount: 1,
    rootCreatedAt: "2026-10-09T18:30:00.000Z",
    candidateCreatedAt: "2026-10-10T01:23:35.000Z",
    alreadyClassifiedCount: 0
  }), { isReply: true, method: "root_reply_count_order" });
});

test("does not classify inline cards beyond the root's visible reply count", () => {
  assert.deepEqual(classifyVisibleThreadReply({
    explicitReply: false,
    candidateIndex: 2,
    rootIndex: 0,
    rootReplyCount: 1,
    rootCreatedAt: "2026-10-09T18:30:00.000Z",
    candidateCreatedAt: "2026-10-10T01:23:35.000Z",
    alreadyClassifiedCount: 1
  }), { isReply: false, method: null });
});

test("does not classify cards that precede the root or predate it", () => {
  const base = {
    explicitReply: false,
    rootIndex: 1,
    rootReplyCount: 1,
    rootCreatedAt: "2026-10-09T18:30:00.000Z",
    candidateCreatedAt: "2026-10-10T01:23:35.000Z",
    alreadyClassifiedCount: 0
  };
  assert.equal(classifyVisibleThreadReply({ ...base, candidateIndex: 0 }).isReply, false);
  assert.equal(classifyVisibleThreadReply({
    ...base,
    candidateIndex: 2,
    candidateCreatedAt: "2026-10-08T01:23:35.000Z"
  }).isReply, false);
});
