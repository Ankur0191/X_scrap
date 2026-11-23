import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const inputPath = path.join(root, "data/output/posts-365d.jsonl");
const queuePath = path.join(root, "data/output/thread-queue-365d.jsonl");

if (!fs.existsSync(inputPath)) {
  console.error("Rolling-window file not found. Run npm run build:window first.");
  process.exit(2);
}

const unique = new Map();
const lines = fs.readFileSync(inputPath, "utf8").split(/\r?\n/).filter(Boolean);
for (const line of lines) {
  let post;
  try { post = JSON.parse(line); } catch { continue; }
  const tracked = String(post.trackedCompetitor || "").toLowerCase();
  const author = String(post.authorUsername || "").toLowerCase();
  if (!tracked || author !== tracked || post.isReply || post.isRepost) continue;
  const key = tracked + ":" + String(post.id);
  if (!unique.has(key)) {
    unique.set(key, {
      rootPostId: String(post.id),
      trackedCompetitor: tracked,
      rootAuthorUsername: author,
      createdAt: post.createdAt,
      url: post.url,
      text: post.text || "",
      domainId: null,
      windowDays: 365,
      source: "posts-365d.jsonl"
    });
  }
}

const config = JSON.parse(fs.readFileSync(path.join(root, "config/competitors.json"), "utf8"));
const domainByCompetitor = new Map(config.competitors.map((item) => [
  String(item.username).replace(/^@/, "").toLowerCase(),
  item.domainId || null
]));
const queue = [...unique.values()]
  .map((item) => ({ ...item, domainId: domainByCompetitor.get(item.trackedCompetitor) || null }))
  .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

fs.writeFileSync(queuePath, queue.map((item) => JSON.stringify(item)).join("\n") + (queue.length ? "\n" : ""), {
  encoding: "utf8",
  mode: 0o600
});
console.log(JSON.stringify({
  rootPostsQueued: queue.length,
  byCompetitor: Object.fromEntries([...new Set(queue.map((item) => item.trackedCompetitor))]
    .map((handle) => [handle, queue.filter((item) => item.trackedCompetitor === handle).length])),
  output: queuePath
}, null, 2));
