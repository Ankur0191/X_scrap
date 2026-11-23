import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractHashtagsAndMentions } from "../collector/visible-post.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const daysIndex = args.indexOf("--days");
const requestedDays = daysIndex >= 0 ? Number(args[daysIndex + 1]) : null;
const domainIndex = args.indexOf("--domain");
const domainFilter = domainIndex >= 0 ? String(args[domainIndex + 1] || "").trim().toLowerCase() : null;
const config = JSON.parse(fs.readFileSync(path.join(root, "config/competitors.json"), "utf8"));
const domainByCompetitor = new Map(config.competitors.map((item) => [
  String(item.username).replace(/^@/, "").toLowerCase(),
  String(item.domainId || "").toLowerCase()
]));
const windowDays = Number.isFinite(requestedDays) && requestedDays > 0
  ? Math.min(requestedDays, 3650)
  : Number(config.collection?.windowDays || 365);

const inputPath = path.join(root, "data/output/posts.jsonl");
const outputName = domainFilter
  ? `posts-${domainFilter}-${windowDays}d.jsonl`
  : `posts-${windowDays}d.jsonl`;
const outputPath = path.join(root, "data/output", outputName);
const manifestName = domainFilter
  ? `window-manifest-${domainFilter}-${windowDays}d.json`
  : "window-manifest.json";
const manifestPath = path.join(root, "data/output", manifestName);

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
const outsideDomain = [];
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
  const competitorKey = String(post.trackedCompetitor).replace(/^@/, "").toLowerCase();
  if (domainFilter && domainByCompetitor.get(competitorKey) !== domainFilter) {
    outsideDomain.push({ line: index + 1, id: post.id, trackedCompetitor: competitorKey });
    continue;
  }
  const key = competitorKey + ":" + String(post.id);
  if (seen.has(key)) {
    duplicateIds.add(key);
    continue;
  }
  seen.add(key);
  // Rebuild explicit hashtag and @mention metadata from preserved source text.
  // This also upgrades records collected before tag extraction was added.
  const derivedTags = extractHashtagsAndMentions(post.text || "");
  const derivedQuotedTags = extractHashtagsAndMentions((post.quotedText || []).join("\\n"));
  post.hashtags = Array.isArray(post.hashtags) && post.hashtags.length ? post.hashtags : derivedTags.hashtags;
  post.mentions = Array.isArray(post.mentions) && post.mentions.length ? post.mentions : derivedTags.mentions;
  post.quotedHashtags = Array.isArray(post.quotedHashtags) && post.quotedHashtags.length ? post.quotedHashtags : derivedQuotedTags.hashtags;
  post.quotedMentions = Array.isArray(post.quotedMentions) && post.quotedMentions.length ? post.quotedMentions : derivedQuotedTags.mentions;
  const existingRelationships = Array.isArray(post.relationships) ? post.relationships : [];
  const generatedRelationships = [
    ...post.hashtags.map((tag) => ({ type: "uses_hashtag", targetType: "hashtag", targetId: tag.normalized, surface: tag.label })),
    ...post.mentions.map((mention) => ({ type: "mentions_account", targetType: "x_account", targetId: mention.normalized, surface: mention.handle })),
    ...post.quotedHashtags.map((tag) => ({ type: "quoted_content_uses_hashtag", targetType: "hashtag", targetId: tag.normalized, surface: tag.label })),
    ...post.quotedMentions.map((mention) => ({ type: "quoted_content_mentions_account", targetType: "x_account", targetId: mention.normalized, surface: mention.handle })),
    ...(post.isQuote && post.quotedPostId ? [{ type: "quotes", targetType: "social_post", targetId: String(post.quotedPostId) }] : []),
    ...(post.isRepost ? [{
      type: "reposts",
      sourceType: "x_account",
      sourceId: String(post.trackedCompetitor).toLowerCase(),
      targetType: "social_post",
      targetId: String(post.id)
    }] : [])
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
    recordCount: lines.filter((line) => line.trim()).length,
    domainFilter
  },
  activeDataset: {
    path: "data/output/" + outputName,
    recordCount: active.length,
    byCompetitor,
    byPostType,
    uniqueHashtags: Object.keys(byHashtag).length,
    topHashtags: Object.entries(byHashtag).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([tag, count]) => ({ tag, count }))
  },
  excluded: {
    outsideWindow: outsideWindow.length,
    outsideDomain: outsideDomain.length,
    invalid: invalid.length,
    duplicates: duplicateIds.size
  }
};

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
console.log(JSON.stringify(manifest, null, 2));
