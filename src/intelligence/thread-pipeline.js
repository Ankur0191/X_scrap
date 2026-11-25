import { isThreadRootCandidate } from "../collector/visible-post.js";

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (index + 1 >= args.length || String(args[index + 1]).startsWith("--")) {
    throw new Error("Missing value for " + name);
  }
  return args[index + 1];
}

export function parseThreadPipelineOptions(args = [], defaultDays = 365) {
  const rawDomain = optionValue(args, "--domain");
  const domainId = rawDomain === undefined ? null : String(rawDomain).trim().toLowerCase();
  if (domainId !== null && !/^[a-z0-9_-]+$/.test(domainId)) {
    throw new Error("Invalid --domain value: " + rawDomain);
  }
  const rawDays = optionValue(args, "--window-days") ?? optionValue(args, "--days");
  const windowDays = rawDays === undefined ? Number(defaultDays) : Number(rawDays);
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 3650) {
    throw new Error("--window-days must be an integer between 1 and 3650.");
  }
  return { domainId, windowDays };
}

export function resolveThreadPipelineFiles({ domainId = null, windowDays = 365 } = {}) {
  const normalizedDomain = domainId ? String(domainId).trim().toLowerCase() : null;
  if (normalizedDomain && !/^[a-z0-9_-]+$/.test(normalizedDomain)) {
    throw new Error("Invalid domainId: " + domainId);
  }
  const days = Number(windowDays);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error("windowDays must be an integer between 1 and 3650.");
  }
  const suffix = (normalizedDomain ? normalizedDomain + "-" : "") + days + "d";
  const legacyDefault = normalizedDomain === null && days === 365;
  return {
    posts: "posts-" + suffix + ".jsonl",
    queue: "thread-queue-" + suffix + ".jsonl",
    replies: legacyDefault ? "thread-replies.jsonl" : "thread-replies-" + suffix + ".jsonl",
    progress: legacyDefault ? "thread-progress.jsonl" : "thread-progress-" + suffix + ".jsonl",
    ancestors: legacyDefault ? "thread-ancestors.jsonl" : "thread-ancestors-" + suffix + ".jsonl",
    runs: legacyDefault ? "thread-runs.jsonl" : "thread-runs-" + suffix + ".jsonl",
    snapshots: "engagement-snapshots.jsonl",
    conversation: legacyDefault ? "conversation-" + days + "d.jsonl" : "conversations-" + suffix + ".jsonl",
    conversationManifest: legacyDefault ? "conversation-manifest.json" : "conversation-manifest-" + suffix + ".json",
    windowManifest: normalizedDomain ? "window-manifest-" + suffix + ".json" : "window-manifest.json"
  };
}

export function buildThreadQueue(posts, {
  domainId = null,
  windowDays = 365,
  domainByCompetitor = new Map(),
  sourceFile = null
} = {}) {
  const unique = new Map();
  for (const post of posts) {
    if (!isThreadRootCandidate(post)) continue;
    const tracked = String(post.trackedCompetitor || "").replace(/^@/, "").toLowerCase();
    const author = String(post.authorUsername || "").replace(/^@/, "").toLowerCase();
    const knownDomain = domainByCompetitor.get(tracked) || null;
    if (!tracked || !post.id || (domainId && knownDomain !== domainId)) continue;
    const key = tracked + ":" + String(post.id);
    if (unique.has(key)) continue;
    unique.set(key, {
      rootPostId: String(post.id),
      trackedCompetitor: tracked,
      rootAuthorUsername: author,
      createdAt: post.createdAt,
      url: post.url,
      text: post.text || "",
      domainId: knownDomain,
      windowDays: Number(windowDays),
      source: sourceFile || ("posts-" + (domainId ? domainId + "-" : "") + windowDays + "d.jsonl")
    });
  }
  return [...unique.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
