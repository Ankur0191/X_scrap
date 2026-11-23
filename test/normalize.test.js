import test from "node:test";
import assert from "node:assert/strict";
import { normalizePost } from "../src/ingest/normalize.js";

const valid = {
  id: "123",
  trackedCompetitor: "TenLifestyle",
  authorUsername: "@Example_Org",
  text: "A post",
  createdAt: "2026-11-23T00:00:00Z",
  url: "https://x.com/Example_Org/status/123"
};

test("normalizes tracked competitor, author and timestamp", () => {
  const post = normalizePost(valid);
  assert.equal(post.trackedCompetitor, "tenlifestyle");
  assert.equal(post.authorUsername, "example_org");
  assert.equal(post.createdAt, "2026-11-23T00:00:00.000Z");
  assert.equal(post.id, "123");
});

test("allows media-only posts with empty text", () => {
  const post = normalizePost({ ...valid, text: "", media: [{ kind: "image" }] });
  assert.equal(post.text, "");
  assert.equal(post.media.length, 1);
});

test("rejects missing required data", () => {
  assert.throws(() => normalizePost({ ...valid, id: "" }), /Missing required field: id/);
});

test("rejects invalid timestamps", () => {
  assert.throws(() => normalizePost({ ...valid, createdAt: "yesterday-ish" }), /valid date/);
});

test("rejects non-http URLs", () => {
  assert.throws(() => normalizePost({ ...valid, url: "javascript:alert(1)" }), /HTTP/);
});
