import test from "node:test";
import assert from "node:assert/strict";
import { parseCount, metricFromLabel, extractHashtagsAndMentions } from "../src/collector/visible-post.js";

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
