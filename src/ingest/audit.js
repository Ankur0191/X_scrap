import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const inputPath = path.resolve(process.argv[2] || path.join(root, "data/output/posts.jsonl"));

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
  try {
    rows.push({ line: index + 1, value: JSON.parse(line) });
  } catch (error) {
    malformed.push({ line: index + 1, error: error.message });
  }
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
const mojibakeRows = [];
const missingCore = [];
const authorMismatch = [];
const emptyText = [];
const genericAlt = [];
const imageWithoutUrl = [];
const zeroMetrics = [];
const metricCoverage = { replies: 0, reposts: 0, likes: 0, views: 0 };
const dates = [];
const allowedHosts = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);

for (const row of rows) {
  const post = row.value;
  const key = String(post.trackedCompetitor || "").toLowerCase() + ":" + String(post.id || "");
  if (duplicateKeys.has(key)) {
    duplicateRows.push({ line: row.line, firstLine: duplicateKeys.get(key), key });
  } else {
    duplicateKeys.set(key, row.line);
  }

  const absent = ["id", "trackedCompetitor", "authorUsername", "createdAt", "url"]
    .filter((field) => post[field] === undefined || post[field] === null || String(post[field]).trim() === "");
  if (absent.length) missingCore.push({ line: row.line, fields: absent });

  const parsedDate = new Date(post.createdAt);
  if (!post.createdAt || Number.isNaN(parsedDate.getTime())) {
    invalidDates.push({ line: row.line, value: post.createdAt ?? null });
  } else {
    dates.push(parsedDate);
    if (parsedDate.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
      futureDates.push({ line: row.line, value: post.createdAt });
    }
  }

  const text = String(post.text || "");
  if (!text.trim()) emptyText.push(row.line);
  if (/(?:Ã.|Â.|â€|ï¿½|\uFFFD|ðŸ)/u.test(text)) {
    mojibakeRows.push({ line: row.line, sample: text.slice(0, 100) });
  }

  if (!post.isRepost && String(post.authorUsername || "").toLowerCase() !== String(post.trackedCompetitor || "").toLowerCase()) {
    authorMismatch.push({
      line: row.line,
      trackedCompetitor: post.trackedCompetitor,
      authorUsername: post.authorUsername,
      postType: post.postType
    });
  }

  if (post.url) {
    try {
      const host = new URL(post.url).hostname.toLowerCase();
      if (!allowedHosts.has(host)) {
        missingCore.push({ line: row.line, fields: ["url_host_not_x"], value: host });
      }
    } catch {
      missingCore.push({ line: row.line, fields: ["invalid_url"] });
    }
  }

  if (post.metrics && typeof post.metrics === "object") {
    let allPresentZero = true;
    for (const metric of Object.keys(metricCoverage)) {
      const value = post.metrics[metric];
      if (value !== null && value !== undefined && Number.isFinite(Number(value))) {
        metricCoverage[metric] += 1;
        if (Number(value) !== 0) allPresentZero = false;
      } else {
        allPresentZero = false;
      }
    }
    if (allPresentZero) zeroMetrics.push(row.line);
  }

  for (const item of Array.isArray(post.media) ? post.media : []) {
    if (item.kind === "image") {
      const alt = String(item.alt || "").trim();
      if (!alt || /^(image|photo|picture)$/i.test(alt)) genericAlt.push({ line: row.line, alt: alt || null });
      if (!item.displayedUrl) imageWithoutUrl.push(row.line);
    }
  }
}

dates.sort((a, b) => a - b);
const report = {
  file: inputPath,
  auditedAt: new Date().toISOString(),
  totals: {
    records: rows.length,
    malformedLines: malformed.length,
    uniqueByCompetitorAndPostId: duplicateKeys.size,
    duplicateRows: duplicateRows.length
  },
  distribution: {
    competitor: countBy(rows.map((x) => x.value), (p) => p.trackedCompetitor),
    postType: countBy(rows.map((x) => x.value), (p) => p.postType),
    timelineView: countBy(rows.map((x) => x.value), (p) => p.timelineView),
    source: countBy(rows.map((x) => x.value), (p) => p.source)
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
    possibleMojibakeRecords: mojibakeRows.length,
    authorDoesNotMatchTrackedCompetitorAndNotMarkedRepost: authorMismatch.length,
    imageAltGenericOrMissing: genericAlt.length,
    imagesWithoutDisplayedUrl: imageWithoutUrl.length,
    recordsWhereEveryParsedMetricIsZero: zeroMetrics.length,
    metricCoverage
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
