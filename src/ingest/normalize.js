const required = ["id", "authorUsername", "createdAt", "url"];

export function normalizePost(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Post must be a JSON object");
  }
  for (const key of required) {
    if (input[key] === undefined || input[key] === null || String(input[key]).trim() === "") {
      throw new Error("Missing required field: " + key);
    }
  }
  const createdAt = new Date(input.createdAt);
  if (Number.isNaN(createdAt.getTime())) throw new Error("createdAt must be a valid date");
  let url;
  try { url = new URL(input.url); } catch { throw new Error("url must be an absolute URL"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("url must use HTTP(S)");

  const authorUsername = String(input.authorUsername).replace(/^@/, "").toLowerCase();
  const trackedCompetitor = String(input.trackedCompetitor || authorUsername).replace(/^@/, "").toLowerCase();
  return {
    id: String(input.id),
    trackedCompetitor,
    authorUsername,
    text: input.text === undefined || input.text === null ? "" : String(input.text),
    quotedText: Array.isArray(input.quotedText) ? input.quotedText.map(String) : [],
    createdAt: createdAt.toISOString(),
    url: url.toString(),
    language: input.language ? String(input.language) : null,
    metrics: input.metrics && typeof input.metrics === "object" ? input.metrics : {},
    media: Array.isArray(input.media) ? input.media : [],
    isReply: Boolean(input.isReply),
    isRepost: Boolean(input.isRepost),
    isQuote: Boolean(input.isQuote),
    isPinned: Boolean(input.isPinned),
    postType: input.postType ? String(input.postType) : "post",
    timelineView: input.timelineView ? String(input.timelineView) : null,
    socialContext: input.socialContext ? String(input.socialContext) : "",
    source: input.source ? String(input.source) : "authorized-import",
    ingestedAt: new Date().toISOString()
  };
}
