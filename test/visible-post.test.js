import test from "node:test";
import assert from "node:assert/strict";
import { parseCount, metricFromLabel } from "../src/collector/visible-post.js";

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
