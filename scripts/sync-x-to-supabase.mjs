import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INPUT = "data/output/conversations-tic-184d.jsonl";
const DEFAULT_SNAPSHOTS = "data/output/engagement-snapshots.jsonl";
const EXPECTED_PROJECT_REF = "aryztdrywvkbqyjvjqqz";
const BATCH_SIZE = 100;

function normalizeHandle(value) {
  return String(value || "").replace(/^@/, "").trim().toLowerCase();
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function readJsonl(filePath, required = true) {
  if (!fs.existsSync(filePath)) {
    if (!required) return [];
    throw new Error("Input file not found: " + filePath);
  }
  const rows = [];
  const errors = [];
  for (const [index, line] of fs.readFileSync(filePath, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      errors.push("Line " + (index + 1) + ": " + error.message);
    }
  }
  if (errors.length) {
    throw new Error("Malformed JSONL in " + filePath + ":\n" + errors.slice(0, 10).join("\n"));
  }
  return rows;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isoOrThrow(value, fieldName) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new Error("Invalid or missing " + fieldName + ": " + String(value));
  }
  return date.toISOString();
}

function normalizePostType(record) {
  const raw = String(record.postType || "").toLowerCase();
  if (record.isRepost || raw === "repost" || raw === "reposts") return "repost";
  if (record.isQuote || raw === "quote" || raw === "quotes") return "quote";
  if (record.isReply || record.isThreadReply || raw === "reply" || raw === "replies") return "reply";
  if (raw === "post" || raw === "posts" || raw === "") return raw === "" ? "unknown" : "post";
  return "unknown";
}

function mergeArray(...values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    }
  }
  return result;
}

function unwrapSource(record) {
  if (record && record.sourceRecord && typeof record.sourceRecord === "object") {
    return record.sourceRecord;
  }
  return record;
}

export function buildSocialPostRows(records, options) {
  const {
    organizationId,
    profilesByHandle,
    enabledTicHandles,
    collectionRunId,
    sourceFile,
    collectedAt = new Date().toISOString()
  } = options;

  const byKey = new Map();
  const unmatchedProfiles = new Set();
  let filteredOut = 0;
  let unmatchedProfileRows = 0;

  for (const input of records) {
    const record = unwrapSource(input);
    const trackedHandle = normalizeHandle(record.trackedCompetitor);
    if (!trackedHandle || !enabledTicHandles.has(trackedHandle)) {
      filteredOut += 1;
      continue;
    }

    const profile = profilesByHandle.get(trackedHandle);
    if (!profile?.competitor_id) {
      unmatchedProfiles.add(trackedHandle);
      unmatchedProfileRows += 1;
      continue;
    }

    const externalId = String(record.id || record.postId || "").trim();
    if (!externalId) throw new Error("A source record is missing its X post ID.");
    const authorUsername = String(record.authorUsername || "").replace(/^@/, "").trim();
    const publishedAt = isoOrThrow(record.createdAt || record.publishedAt, "createdAt for post " + externalId);
    const postUrl = String(record.url || record.sourceUrl || "").trim() ||
      (authorUsername ? "https://x.com/" + encodeURIComponent(authorUsername) + "/status/" + externalId : "https://x.com/i/status/" + externalId);
    const metrics = objectOrEmpty(record.engagementHistory?.latestMetrics || record.metrics);
    const isThreadReply = Boolean(record.isThreadReply);
    const isThreadAncestor = Boolean(record.isThreadAncestor);
    const postType = normalizePostType(record);
    const roots = mergeArray(
      Array.isArray(record.conversationRootIds) ? record.conversationRootIds.map(String) : [],
      record.conversationRootId ? [String(record.conversationRootId)] : []
    );
    const rootId = record.conversationRootId ? String(record.conversationRootId) : (roots[0] || null);

    const xScrapMetadata = {
      dataset: sourceFile,
      domainId: "tic",
      trackedHandle,
      postType,
      isReply: Boolean(record.isReply),
      isRepost: Boolean(record.isRepost),
      isQuote: Boolean(record.isQuote),
      isPinned: Boolean(record.isPinned),
      isThreadReply,
      isThreadAncestor,
      timelineView: record.timelineView || null,
      socialContext: record.socialContext || null,
      replyingToUsername: record.replyingToUsername || null,
      replyDetectionMethod: record.replyDetectionMethod || null,
      conversationRootIds: roots,
      ancestorForPostIds: record.ancestorForPostIds || (record.ancestorForPostId ? [String(record.ancestorForPostId)] : []),
      candidateParentPostIds: record.candidateParentPostIds || [],
      candidateReplyIds: record.candidateReplyIds || [],
      ancestorRelationshipStatus: record.ancestorRelationshipStatus || null,
      ancestorDiscoveryMethod: record.ancestorDiscoveryMethod || null,
      quotedPostId: record.quotedPostId || null,
      quotedText: record.quotedText || [],
      relatedPosts: record.relatedPosts || [],
      hashtags: record.hashtags || [],
      mentions: record.mentions || [],
      quotedHashtags: record.quotedHashtags || [],
      quotedMentions: record.quotedMentions || [],
      relationships: record.relationships || [],
      media: record.media || [],
      source: record.source || "x-visible-frontend",
      engagementHistory: record.engagementHistory || null,
      windowDays: record.windowDays || null,
      windowCutoff: record.windowCutoff || null
    };

    const row = {
      organization_id: organizationId,
      competitor_id: profile.competitor_id,
      platform: "x",
      external_id: externalId,
      author_id: record.authorId || record.authorUserId || record.userId || null,
      author_username: authorUsername || null,
      post_url: postUrl,
      post_text: String(record.text ?? ""),
      published_at: publishedAt,
      collected_at: record.ingestedAt ? isoOrThrow(record.ingestedAt, "ingestedAt") : collectedAt,
      language: record.language || record.lang || null,
      public_metrics: metrics,
      source_kind: isThreadReply ? "thread_reply" : (isThreadAncestor ? "thread_ancestor" : "profile_timeline"),
      metadata: { x_scrap: xScrapMetadata },
      post_type: postType,
      is_thread_reply: isThreadReply,
      is_thread_ancestor: isThreadAncestor,
      conversation_root_external_id: rootId,
      conversation_root_external_ids: roots,
      parent_external_id: record.parentPostId ? String(record.parentPostId) : null,
      tracked_handle: trackedHandle,
      source_payload: record,
      collection_run_id: collectionRunId || null
    };

    const key = trackedHandle + ":" + externalId;
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, row);
    } else {
      const previousRaw = previous.source_payload;
      const mergedRoots = mergeArray(previous.conversation_root_external_ids, row.conversation_root_external_ids);
      byKey.set(key, {
        ...previous,
        ...row,
        conversation_root_external_id: previous.conversation_root_external_id || row.conversation_root_external_id,
        conversation_root_external_ids: mergedRoots,
        is_thread_reply: previous.is_thread_reply || row.is_thread_reply,
        is_thread_ancestor: previous.is_thread_ancestor || row.is_thread_ancestor,
        parent_external_id: previous.parent_external_id || row.parent_external_id,
        source_payload: { ...previousRaw, ...row.source_payload }
      });
    }
  }

  return {
    rows: [...byKey.values()],
    unmatchedProfiles: [...unmatchedProfiles].sort(),
    filteredOut,
    duplicateRowsMerged: records.length - filteredOut - unmatchedProfileRows - byKey.size
  };
}

export function buildEngagementSnapshotRows(snapshots, options) {
  const {
    organizationId,
    profilesByHandle,
    enabledTicHandles,
    postKeys,
    collectionRunId
  } = options;

  const byKey = new Map();
  let filteredOut = 0;
  let unmatchedProfiles = 0;

  for (const snapshot of snapshots) {
    const trackedHandle = normalizeHandle(snapshot.trackedCompetitor);
    const externalId = String(snapshot.postId || "").trim();
    const postKey = trackedHandle + ":" + externalId;

    if (!trackedHandle || !enabledTicHandles.has(trackedHandle) || !postKeys.has(postKey)) {
      filteredOut += 1;
      continue;
    }
    const profile = profilesByHandle.get(trackedHandle);
    if (!profile?.competitor_id) {
      unmatchedProfiles += 1;
      continue;
    }
    const snapshotAt = isoOrThrow(snapshot.snapshotAt, "snapshotAt for post " + externalId);
    const key = postKey + ":" + snapshotAt;
    byKey.set(key, {
      organization_id: organizationId,
      competitor_id: profile.competitor_id,
      platform: "x",
      external_id: externalId,
      tracked_handle: trackedHandle,
      snapshot_at: snapshotAt,
      metrics: objectOrEmpty(snapshot.metrics),
      previous_metrics: snapshot.previousMetrics === undefined ? null : snapshot.previousMetrics,
      source_payload: snapshot,
      collection_run_id: collectionRunId || null
    });
  }

  return { rows: [...byKey.values()], filteredOut, unmatchedProfiles };
}

function loadEnv(rootDir) {
  parseEnvFile(path.join(rootDir, ".env.local"));
  parseEnvFile(path.join(rootDir, ".env.development.local"));
  parseEnvFile(path.join(rootDir, ".env"));
}

function parseArgs(argv) {
  const result = { input: DEFAULT_INPUT, snapshots: DEFAULT_SNAPSHOTS, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") result.dryRun = true;
    else if (token === "--input") result.input = argv[++index];
    else if (token === "--snapshots") result.snapshots = argv[++index];
    else if (token === "--no-snapshots") result.snapshots = null;
    else if (token === "--help" || token === "-h") result.help = true;
    else throw new Error("Unknown argument: " + token);
  }
  return result;
}

async function apiRequest(baseUrl, apiKey, resource, options = {}) {
  const url = new URL("/rest/v1/" + resource, baseUrl);
  for (const [key, value] of Object.entries(options.params || {})) {
    url.searchParams.set(key, String(value));
  }
  const headers = {
    apikey: apiKey,
    Authorization: "Bearer " + apiKey,
    Accept: "application/json"
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.prefer) headers.Prefer = options.prefer;

  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(120000)
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error("Supabase " + response.status + " for " + resource + ": " + text.slice(0, 1200));
        error.status = response.status;
        if (![429, 500, 502, 503, 504].includes(response.status)) throw error;
        lastError = error;
      } else {
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
      }
    } catch (error) {
      if (error.status && ![429, 500, 502, 503, 504].includes(error.status)) throw error;
      lastError = error;
    }
    const delay = Math.min(15000, 1000 * (2 ** attempt));
    console.warn("Retry " + (attempt + 1) + "/5 for " + resource + " after " + lastError.message);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw lastError || new Error("Supabase request failed: " + resource);
}

async function upsertBatches(baseUrl, apiKey, table, rows, conflict, onProgress) {
  let written = 0;
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    await apiRequest(baseUrl, apiKey, table, {
      method: "POST",
      params: { on_conflict: conflict },
      body: batch,
      prefer: "resolution=merge-duplicates,return=minimal"
    });
    written += batch.length;
    if (onProgress) onProgress(written, rows.length);
  }
  return written;
}

async function main() {
  loadEnv(root);
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/sync-x-to-supabase.mjs [--input <jsonl>] [--snapshots <jsonl>] [--no-snapshots] [--dry-run]");
    return;
  }

  const baseUrl = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const organizationId = process.env.SUPABASE_ORGANIZATION_ID || "";
  const expectedRef = process.env.SUPABASE_EXPECTED_PROJECT_REF || EXPECTED_PROJECT_REF;

  if (!baseUrl || !apiKey || !organizationId) {
    throw new Error("Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_ORGANIZATION_ID in .env.local.");
  }
  const host = new URL(baseUrl).hostname;
  if (!host.startsWith(expectedRef + ".")) {
    throw new Error("Refusing to sync to " + host + ". Expected Supabase project ref " + expectedRef + ".");
  }

  const inputPath = path.resolve(root, args.input);
  const snapshotPath = args.snapshots ? path.resolve(root, args.snapshots) : null;
  const config = JSON.parse(fs.readFileSync(path.join(root, "config/competitors.json"), "utf8"));
  const enabledTicHandles = new Set(
    config.competitors
      .filter((item) => item.enabled && String(item.domainId || "").toLowerCase() === "tic")
      .map((item) => normalizeHandle(item.username))
  );
  const sourceRecords = readJsonl(inputPath);
  const snapshotRecords = snapshotPath ? readJsonl(snapshotPath, false) : [];
  const profiles = await apiRequest(baseUrl, apiKey, "social_profiles", {
    params: {
      select: "handle,competitor_id,organization_id,verification_status,is_enabled",
      organization_id: "eq." + organizationId,
      platform: "eq.x"
    }
  });
  const profilesByHandle = new Map(
    (profiles || []).map((profile) => [normalizeHandle(profile.handle), profile])
  );

  const prepared = buildSocialPostRows(sourceRecords, {
    organizationId,
    profilesByHandle,
    enabledTicHandles,
    collectionRunId: null,
    sourceFile: path.relative(root, inputPath).split(path.sep).join("/")
  });
  if (prepared.unmatchedProfiles.length) {
    throw new Error("No X social_profiles registry match for tracked handles: " + prepared.unmatchedProfiles.join(", ") + ". No posts were written.");
  }
  if (!prepared.rows.length) throw new Error("No TIC posts found in the input file. No database writes performed.");

  const postKeys = new Set(prepared.rows.map((row) => normalizeHandle(row.tracked_handle) + ":" + row.external_id));
  const snapshots = buildEngagementSnapshotRows(snapshotRecords, {
    organizationId,
    profilesByHandle,
    enabledTicHandles,
    postKeys,
    collectionRunId: null
  });

  const handles = [...new Set(prepared.rows.map((row) => row.tracked_handle))].sort();
  console.log("Target project: " + expectedRef);
  console.log("TIC posts/replies to upsert: " + prepared.rows.length);
  console.log("Tracked handles: " + handles.join(", "));
  console.log("Engagement snapshots to upsert: " + snapshots.rows.length);
  console.log("Non-TIC/out-of-window snapshot rows skipped: " + snapshots.filteredOut);
  console.log("Deduplicated source rows: " + prepared.duplicateRowsMerged);

  if (args.dryRun) {
    console.log("Dry run: no Supabase rows were written.");
    return;
  }

  const manifestPath = path.join(root, "data/output/window-manifest-tic-184d.json");
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : null;

  const runConfig = {
    sourceSystem: "X_scrap",
    domainId: "tic",
    inputFile: path.relative(root, inputPath).split(path.sep).join("/"),
    snapshotsFile: snapshotPath ? path.relative(root, snapshotPath).split(path.sep).join("/") : null,
    sourceWindow: manifest?.window || null,
    sourceCounts: manifest?.activeDataset || manifest?.counts || null,
    notes: [
      "Raw source records are stored without AI rewriting.",
      "External authors are preserved as authors, not automatically labelled customers.",
      "Visible engagement counts are observations, not verified lifetime totals."
    ]
  };

  const runRows = await apiRequest(baseUrl, apiKey, "social_collection_runs", {
    method: "POST",
    body: [{
      organization_id: organizationId,
      platform: "x",
      mode: "mixed",
      status: "running",
      requested_limit: prepared.rows.length,
      posts_fetched: prepared.rows.length,
      posts_upserted: 0,
      profiles_checked: handles.length,
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
      query_text: "X_scrap TIC raw conversation archive import",
      config: runConfig
    }],
    prefer: "return=representation"
  });
  const runId = runRows?.[0]?.id;
  if (!runId) throw new Error("Supabase did not return the collection run ID.");

  try {
    const postRows = prepared.rows.map((row) => ({ ...row, collection_run_id: runId }));
    const postCount = await upsertBatches(
      baseUrl, apiKey, "social_posts", postRows,
      "organization_id,competitor_id,platform,external_id",
      (done, total) => console.log("Posts upserted: " + done + "/" + total)
    );

    const snapshotRows = snapshots.rows.map((row) => ({ ...row, collection_run_id: runId }));
    const snapshotCount = await upsertBatches(
      baseUrl, apiKey, "social_post_engagement_snapshots", snapshotRows,
      "organization_id,competitor_id,platform,external_id,snapshot_at",
      (done, total) => console.log("Engagement snapshots upserted: " + done + "/" + total)
    );

    const finalConfig = {
      ...runConfig,
      syncResult: {
        sourceRows: sourceRecords.length,
        postsPrepared: prepared.rows.length,
        postsUpserted: postCount,
        engagementSnapshotsPrepared: snapshots.rows.length,
        engagementSnapshotsUpserted: snapshotCount,
        unmatchedSnapshotProfiles: snapshots.unmatchedProfiles,
        filteredSnapshotRows: snapshots.filteredOut,
        duplicateRowsMerged: prepared.duplicateRowsMerged
      }
    };
    await apiRequest(baseUrl, apiKey, "social_collection_runs", {
      method: "PATCH",
      params: { id: "eq." + runId },
      body: {
        status: "succeeded",
        posts_upserted: postCount,
        completed_at: new Date().toISOString(),
        config: finalConfig
      },
      prefer: "return=minimal"
    });

    console.log(JSON.stringify({
      status: "succeeded",
      collectionRunId: runId,
      postsUpserted: postCount,
      engagementSnapshotsUpserted: snapshotCount,
      unmatchedSnapshotProfiles: snapshots.unmatchedProfiles,
      outputTarget: "TICRivalmap / public.social_posts",
      rawContentPreserved: true
    }, null, 2));
  } catch (error) {
    await apiRequest(baseUrl, apiKey, "social_collection_runs", {
      method: "PATCH",
      params: { id: "eq." + runId },
      body: {
        status: "failed",
        error_message: String(error.message || error).slice(0, 2000),
        completed_at: new Date().toISOString()
      },
      prefer: "return=minimal"
    }).catch((updateError) => console.error("Could not mark failed run: " + updateError.message));
    throw error;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("X to Supabase sync failed: " + error.message);
    process.exitCode = 1;
  });
}
