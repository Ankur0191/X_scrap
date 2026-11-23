import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractHashtagsAndMentions } from "../collector/visible-post.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const daysIndex = args.indexOf("--days");
const requestedDays = daysIndex >= 0 ? Number(args[daysIndex + 1]) : null;
const config = JSON.parse(fs.readFileSync(path.join(root, "config/competitors.json"), "utf8"));
const windowDays = Number.isFinite(requestedDays) && requestedDays > 0
  ? Math.min(requestedDays, 3650)
  : Number(config.collection?.windowDays || 365);

const inputPath = path.join(root, "data/output/posts.jsonl");
const outputPath = path.join(root, "data/output", "posts-" + windowDays + "d.jsonl");
const manifestPath = path.join(root, "data/output/window-manifest.json");

if (!fs.existsSync(inputPath)) {
  console.error("No collected posts found at " + inputPath);
  process.exit(2);
}

const generatedAt = new Date();
const cutoff = new Date(generatedAt.getTime() - windowDays * 24 * 60 * 60 * 1000);
const lines = fs.readFileSync(inputPath, "utf8").split(/\r?\n/);
const active = [];
const invalid = [];
const outsideWindow = [];
const duplicateIds = new Set();
const seen = new Set();

for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  if (!line.trim()) continue;
  let post;
  try {
    post = JSON.parse(line);
  } catch (error) {
    invalid.push({ line: index + 1, reason: "invalid_json", detail: error.message });
    continue;
  }
  const createdAt = new Date(post.createdAt);
  if (!post.id || !post.trackedCompetitor || Number.isNaN(createdAt.getTime())) {
    invalid.push({ line: index + 1, reason: "missing_identity_or_invalid_date" });
    continue;
  }
  if (createdAt < cutoff || createdAt > generatedAt) {
    outsideWindow.push({ line: index + 1, id: post.id, createdAt: post.createdAt });
    continue;
  }
  const key = String(post.trackedCompetitor).toLowerCase() + ":" + String(post.id);
  if (seen.has(key)) {
    duplicateIds.add(key);
    continue;
  }
  seen.add(key);
  // Rebuild explicit hashtag and @mention metadata from preserved source text.
  // This also upgrades records collected before tag extraction was added.
  const derivedTags = extractHashtagsAndMentions(post.text || "");
  post.hashtags = Array.isArray(post.hashtags) && post.hashtags.length ? post.hashtags : derivedTags.hashtags;
  post.mentions = Array.isArray(post.mentions) && post.mentions.length ? post.mentions : derivedTags.mentions;
  const existingRelationships = Array.isArray(post.relationships) ? post.relationships : [];
  const generatedRelationships = [
    ...post.hashtags.map((tag) => ({ type: "uses_hashtag", targetType: "hashtag", targetId: tag.normalized, surface: tag.label })),
    ...post.mentions.map((mention) => ({ type: "mentions_account", targetType: "x_account", targetId: mention.normalized, surface: mention.handle }))
  ];
  const relationshipKeys = new Set(existingRelationships.map((item) => item.type + ":" + item.targetId));
  post.relationships = [...existingRelationships, ...generatedRelationships.filter((item) => !relationshipKeys.has(item.type + ":" + item.targetId))];
  active.push(post);
}

active.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, active.map((post) => JSON.stringify(post)).join("\n") + (active.length ? "\n" : ""), {
  encoding: "utf8",
  mode: 0o600
});

const byCompetitor = {};
const byPostType = {};
const byHashtag = {};
for (const post of active) {
  const competitor = String(post.trackedCompetitor).toLowerCase();
  byCompetitor[competitor] = (byCompetitor[competitor] || 0) + 1;
  byPostType[post.postType || "unknown"] = (byPostType[post.postType || "unknown"] || 0) + 1;
  for (const tag of post.hashtags || []) {
    const key = String(tag.normalized || tag.label || "").toLowerCase();
    if (key) byHashtag[key] = (byHashtag[key] || 0) + 1;
  }
}

const manifest = {
  schemaVersion: "1.0.0",
  generatedAt: generatedAt.toISOString(),
  window: {
    days: windowDays,
    startInclusive: cutoff.toISOString(),
    endInclusive: generatedAt.toISOString(),
    timezone: "UTC",
    semantics: "rolling_elapsed_days"
  },
  source: {
    path: "data/output/posts.jsonl",
    recordCount: lines.filter((line) => line.trim()).length
  },
  activeDataset: {
    path: "data/output/posts-" + windowDays + "d.jsonl",
    recordCount: active.length,
    byCompetitor,
    byPostType,
    uniqueHashtags: Object.keys(byHashtag).length,
    topHashtags: Object.entries(byHashtag).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([tag, count]) => ({ tag, count }))
  },
  excluded: {
    outsideWindow: outsideWindow.length,
    invalid: invalid.length,
    duplicates: duplicateIds.size
  }
};

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
console.log(JSON.stringify(manifest, null, 2));
