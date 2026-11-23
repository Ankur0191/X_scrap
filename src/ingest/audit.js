import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const inputPath = path.resolve(args[0] || path.join(root, "data/output/posts.jsonl"));
const configPath = path.join(root, "config/competitors.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const windowDays = Number(config.collection?.windowDays || 365);
const auditedAt = new Date();
const cutoff = new Date(auditedAt.getTime() - windowDays * 24 * 60 * 60 * 1000);

if (!fs.existsSync(inputPath)) {
  console.error("Dataset not found: " + inputPath);
  console.error("Usage: npm run audit:data -- [path-to-posts.jsonl]");
  process.exit(2);
}

const lines = fs.readFileSync(inputPath, "utf8").split(/\r?\n/);
const rows = [];
const malformed = [];
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  if (!line.trim()) continue;
  try { rows.push({ line: index + 1, value: JSON.parse(line) }); }
  catch (error) { malformed.push({ line: index + 1, error: error.message }); }
}

const countBy = (items, selector) => {
  const counts = {};
  for (const item of items) {
    const key = selector(item) ?? "missing";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
};

const duplicateKeys = new Map();
const duplicateRows = [];
const invalidDates = [];
const futureDates = [];
const olderThanWindow = [];
const insideWindowByCompetitor = {};
const outsideWindowByCompetitor = {};
const mojibakeRows = [];
const missingCore = [];
const authorMismatch = [];
const emptyText = [];
const emptyTextWithoutMedia = [];
const genericAlt = [];
const imageWithoutUrl = [];
const zeroMetrics = [];
const metricCoverage = { replies: 0, reposts: 0, likes: 0, views: 0 };
const tagCoverage = { postsWithHashtags: 0, postsWithMentions: 0, hashtagInstances: 0, mentionInstances: 0 };
const relationshipCoverage = {};
const dates = [];
const allowedHosts = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);

for (const row of rows) {
  const post = row.value;
  const competitor = String(post.trackedCompetitor || "").toLowerCase();
  const key = competitor + ":" + String(post.id || "");
  if (duplicateKeys.has(key)) duplicateRows.push({ line: row.line, firstLine: duplicateKeys.get(key), key });
  else duplicateKeys.set(key, row.line);

  const absent = ["id", "trackedCompetitor", "authorUsername", "createdAt", "url"]
    .filter((field) => post[field] === undefined || post[field] === null || String(post[field]).trim() === "");
  if (absent.length) missingCore.push({ line: row.line, fields: absent });

  const parsedDate = new Date(post.createdAt);
  if (!post.createdAt || Number.isNaN(parsedDate.getTime())) {
    invalidDates.push({ line: row.line, value: post.createdAt ?? null });
  } else {
    dates.push(parsedDate);
    if (parsedDate.getTime() > auditedAt.getTime() + 24 * 60 * 60 * 1000) futureDates.push({ line: row.line, value: post.createdAt });
    if (parsedDate < cutoff) {
      olderThanWindow.push(row.line);
      outsideWindowByCompetitor[competitor] = (outsideWindowByCompetitor[competitor] || 0) + 1;
    } else if (parsedDate <= auditedAt) {
      insideWindowByCompetitor[competitor] = (insideWindowByCompetitor[competitor] || 0) + 1;
    }
  }

  const text = String(post.text || "");
  if (!text.trim()) {
    emptyText.push(row.line);
    if (!(Array.isArray(post.media) && post.media.length)) emptyTextWithoutMedia.push(row.line);
  }
  if (/(?:Ã.|Â.|â€|ï¿½|\uFFFD|ðŸ)/u.test(text)) mojibakeRows.push({ line: row.line, sample: text.slice(0, 100) });

  const isConversationReply = Boolean(post.conversationRootId || post.parentPostId);
  if (!post.isRepost && !isConversationReply && String(post.authorUsername || "").toLowerCase() !== competitor) {
    authorMismatch.push({ line: row.line, trackedCompetitor: competitor, authorUsername: post.authorUsername, postType: post.postType });
  }

  if (post.url) {
    try {
      const host = new URL(post.url).hostname.toLowerCase();
      if (!allowedHosts.has(host)) missingCore.push({ line: row.line, fields: ["url_host_not_x"], value: host });
    } catch { missingCore.push({ line: row.line, fields: ["invalid_url"] }); }
  }

  const hashtags = Array.isArray(post.hashtags) ? post.hashtags : [];
  const mentions = Array.isArray(post.mentions) ? post.mentions : [];
  if (hashtags.length) tagCoverage.postsWithHashtags += 1;
  if (mentions.length) tagCoverage.postsWithMentions += 1;
  tagCoverage.hashtagInstances += hashtags.length;
  tagCoverage.mentionInstances += mentions.length;

  for (const relationship of Array.isArray(post.relationships) ? post.relationships : []) {
    const type = relationship.type || "unknown";
    relationshipCoverage[type] = (relationshipCoverage[type] || 0) + 1;
  }

  if (post.metrics && typeof post.metrics === "object") {
    let allPresentZero = true;
    for (const metric of Object.keys(metricCoverage)) {
      const value = post.metrics[metric];
      if (value !== null && value !== undefined && Number.isFinite(Number(value))) {
        metricCoverage[metric] += 1;
        if (Number(value) !== 0) allPresentZero = false;
      } else allPresentZero = false;
    }
    if (allPresentZero) zeroMetrics.push(row.line);
  }

  for (const item of Array.isArray(post.media) ? post.media : []) {
    if (item.kind !== "image") continue;
    const alt = String(item.alt || "").trim();
    if (!alt || /^(image|photo|picture)$/i.test(alt)) genericAlt.push({ line: row.line, alt: alt || null });
    if (!item.displayedUrl) imageWithoutUrl.push(row.line);
  }
}

dates.sort((a, b) => a - b);
const parsedCount = rows.length;
const uniqueCount = duplicateKeys.size;
const report = {
  file: inputPath,
  auditedAt: auditedAt.toISOString(),
  rollingWindow: {
    days: windowDays,
    startInclusive: cutoff.toISOString(),
    endInclusive: auditedAt.toISOString(),
    semantics: "rolling_elapsed_days",
    recordsInsideWindow: Object.values(insideWindowByCompetitor).reduce((a, b) => a + b, 0),
    recordsOlderThanWindow: olderThanWindow.length,
    byCompetitorInsideWindow: insideWindowByCompetitor,
    byCompetitorOlderThanWindow: outsideWindowByCompetitor
  },
  totals: {
    records: parsedCount,
    malformedLines: malformed.length,
    uniqueByCompetitorAndPostId: uniqueCount,
    duplicateRows: duplicateRows.length
  },
  distribution: {
    competitor: countBy(rows.map((x) => x.value), (p) => p.trackedCompetitor),
    postType: countBy(rows.map((x) => x.value), (p) => p.postType),
    timelineView: countBy(rows.map((x) => x.value), (p) => p.timelineView),
    source: countBy(rows.map((x) => x.value), (p) => p.source),
    repliesTabNotNecessarilyReply: rows.filter((x) => x.value.timelineView === "with_replies" && !x.value.isReply).length
  },
  dateCoverage: {
    earliest: dates[0]?.toISOString() ?? null,
    latest: dates.at(-1)?.toISOString() ?? null,
    invalid: invalidDates.length,
    future: futureDates.length
  },
  dataQuality: {
    missingCoreFieldsOrInvalidUrl: missingCore.length,
    emptyTextRecords: emptyText.length,
    emptyTextWithoutMedia: emptyTextWithoutMedia.length,
    possibleMojibakeRecords: mojibakeRows.length,
    authorDoesNotMatchTrackedCompetitorWithoutRepostOrThreadContext: authorMismatch.length,
    imageAltGenericOrMissing: genericAlt.length,
    imagesWithoutDisplayedUrl: imageWithoutUrl.length,
    recordsWhereEveryParsedMetricIsZero: zeroMetrics.length,
    metricCoverage,
    tagCoverage,
    relationshipCoverage
  },
  examples: {
    malformed: malformed.slice(0, 10),
    duplicates: duplicateRows.slice(0, 10),
    mojibake: mojibakeRows.slice(0, 10),
    authorMismatch: authorMismatch.slice(0, 10),
    genericAlt: genericAlt.slice(0, 10)
  }
};

console.log(JSON.stringify(report, null, 2));
