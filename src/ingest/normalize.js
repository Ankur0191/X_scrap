const required = ["id", "authorUsername", "text", "createdAt", "url"];

export function normalizePost(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Post must be a JSON object");
  }
  for (const key of required) {
    if (input[key] === undefined || input[key] === null || String(input[key]).trim() === "") {
      throw new Error(`Missing required field: ${key}`);
    }
  }
  const createdAt = new Date(input.createdAt);
  if (Number.isNaN(createdAt.getTime())) throw new Error("createdAt must be a valid date");
  let url;
  try { url = new URL(input.url); } catch { throw new Error("url must be an absolute URL"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("url must use HTTP(S)");

  return {
    id: String(input.id),
    authorUsername: String(input.authorUsername).replace(/^@/, "").toLowerCase(),
    text: String(input.text),
    createdAt: createdAt.toISOString(),
    url: url.toString(),
    language: input.language ? String(input.language) : null,
    metrics: input.metrics && typeof input.metrics === "object" ? input.metrics : {},
    media: Array.isArray(input.media) ? input.media : [],
    source: input.source ? String(input.source) : "authorized-import",
    ingestedAt: new Date().toISOString()
  };
}
