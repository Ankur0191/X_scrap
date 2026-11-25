import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildThreadQueue,
  parseThreadPipelineOptions,
  resolveThreadPipelineFiles
} from "../intelligence/thread-pipeline.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputDir = path.join(root, "data/output");
const config = JSON.parse(fs.readFileSync(path.join(root, "config/competitors.json"), "utf8"));
const { domainId, windowDays } = parseThreadPipelineOptions(
  process.argv.slice(2),
  Number(config.collection?.windowDays || 365)
);
const files = resolveThreadPipelineFiles({ domainId, windowDays });
const inputPath = path.join(outputDir, files.posts);
const queuePath = path.join(outputDir, files.queue);

if (!fs.existsSync(inputPath)) {
  console.error("Active post file not found: " + inputPath + ". Build the matching window first.");
  process.exit(2);
}

const domainByCompetitor = new Map(config.competitors.map((item) => [
  String(item.username).replace(/^@/, "").toLowerCase(),
  String(item.domainId || "").toLowerCase() || null
]));
const posts = [];
for (const [index, line] of fs.readFileSync(inputPath, "utf8").split(/\r?\n/).entries()) {
  if (!line.trim()) continue;
  try {
    posts.push(JSON.parse(line));
  } catch (error) {
    console.warn("Skipping malformed line " + (index + 1) + " in " + inputPath + ": " + error.message);
  }
}
const queue = buildThreadQueue(posts, {
  domainId,
  windowDays,
  domainByCompetitor,
  sourceFile: files.posts
});

fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(queuePath, queue.map((item) => JSON.stringify(item)).join("\n") + (queue.length ? "\n" : ""), {
  encoding: "utf8",
  mode: 0o600
});
console.log(JSON.stringify({
  domainId,
  windowDays,
  source: files.posts,
  rootPostsQueued: queue.length,
  byCompetitor: Object.fromEntries([...new Set(queue.map((item) => item.trackedCompetitor))]
    .map((handle) => [handle, queue.filter((item) => item.trackedCompetitor === handle).length])),
  output: queuePath
}, null, 2));
