export function parseCount(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/,/g, "").trim().toUpperCase();
  const match = cleaned.match(/^(\d+(?:\.\d+)?)([KMB])?$/);
  if (!match) return null;
  const multiplier = match[2] === "K" ? 1000 : match[2] === "M" ? 1000000 : match[2] === "B" ? 1000000000 : 1;
  return Math.round(Number(match[1]) * multiplier);
}

export function metricFromLabel(label) {
  const match = String(label).match(/(\d[\d,.]*(?:\.\d+)?\s*[KMB]?)\s+(repl(?:y|ies)|reposts?|likes?|views?)/i);
  if (!match) return null;
  const term = match[2].toLowerCase();
  const key = term.startsWith("repl") ? "replies" : term.startsWith("repost") ? "reposts" : term.startsWith("like") ? "likes" : "views";
  return [key, parseCount(match[1].replace(/\s/g, ""))];
}

export function extractHashtagsAndMentions(text) {
  const value = String(text || "");
  const hashtags = [];
  const mentions = [];
  const hashtagPattern = /(^|[\s([{])#([\p{L}\p{N}_]{1,100})/gu;
  const mentionPattern = /(^|[\s([{])@([A-Za-z0-9_]{1,15})\b/g;

  for (const match of value.matchAll(hashtagPattern)) {
    const label = match[2];
    const normalized = label.normalize("NFKC").toLocaleLowerCase("und");
    if (!hashtags.some((item) => item.normalized === normalized)) {
      hashtags.push({ label, normalized, start: match.index + match[1].length, end: match.index + match[1].length + match[0].length - match[1].length });
    }
  }
  for (const match of value.matchAll(mentionPattern)) {
    const handle = match[2];
    const normalized = handle.toLowerCase();
    if (!mentions.some((item) => item.normalized === normalized)) {
      mentions.push({ handle, normalized, start: match.index + match[1].length, end: match.index + match[0].length });
    }
  }
  return { hashtags, mentions };
}

export async function extractVisiblePost(card, trackedCompetitor, timelineView, options = {}) {
  const time = card.locator("time").first();
  if (!(await time.count())) return null;
  const createdAt = await time.getAttribute("datetime");
  if (!createdAt || Number.isNaN(new Date(createdAt).getTime())) return null;

  const permalinkLinks = card.locator('a[href*="/status/"]');
  let permalink = null;
  let postId = null;
  let authorUsername = null;
  const statusLinks = [];
  for (let index = 0; index < await permalinkLinks.count(); index += 1) {
    const href = await permalinkLinks.nth(index).getAttribute("href");
    if (!href) continue;
    try {
      const candidate = new URL(href, "https://x.com");
      const match = candidate.pathname.match(/^\/([^/]+)\/status\/(\d+)/i);
      if (match) {
        const item = {
          url: candidate.toString(),
          authorUsername: decodeURIComponent(match[1]).replace(/^@/, "").toLowerCase(),
          postId: match[2]
        };
        if (!statusLinks.some((existing) => existing.postId === item.postId)) statusLinks.push(item);
      }
    } catch { /* ignore malformed/non-post anchors */ }
  }
  if (statusLinks.length) {
    permalink = statusLinks[0].url;
    authorUsername = statusLinks[0].authorUsername;
    postId = statusLinks[0].postId;
  }
  if (!permalink || !postId || !authorUsername) return null;

  const social = card.locator('[data-testid="socialContext"]').first();
  const socialContext = await social.count() && await social.isVisible()
    ? (await social.innerText()).trim()
    : "";
  const isRepost = /reposted/i.test(socialContext);

  if (authorUsername !== trackedCompetitor.toLowerCase() && !isRepost && !options.allowExternalAuthors) return null;

  const textLocator = card.locator('[data-testid="tweetText"]');
  const tweetTexts = [];
  for (let index = 0; index < await textLocator.count(); index += 1) {
    const item = textLocator.nth(index);
    if (await item.isVisible()) {
      const value = (await item.innerText()).trim();
      if (value) tweetTexts.push(value);
    }
  }

  const fullCardText = await card.innerText();
  const primaryText = tweetTexts[0] || "";
  const tags = extractHashtagsAndMentions(primaryText);
  const quotedContent = tweetTexts.slice(1).join("\\n");
  const quotedTags = extractHashtagsAndMentions(quotedContent);

  const metrics = { replies: null, reposts: null, likes: null, views: null };
  const metricElements = card.locator('button[aria-label], a[aria-label], button[title], a[title]');
  for (let index = 0; index < await metricElements.count(); index += 1) {
    const element = metricElements.nth(index);
    if (!(await element.isVisible())) continue;
    const label = (await element.getAttribute("aria-label")) || (await element.getAttribute("title")) || "";
    const metric = metricFromLabel(label);
    if (metric) metrics[metric[0]] = metric[1];
  }

  const media = [];
  const photos = card.locator('[data-testid="tweetPhoto"] img');
  for (let index = 0; index < await photos.count(); index += 1) {
    const photo = photos.nth(index);
    if (!(await photo.isVisible())) continue;
    media.push({
      kind: "image",
      alt: await photo.getAttribute("alt") || "",
      displayedUrl: await photo.getAttribute("src") || null
    });
  }
  if (await card.locator('[data-testid="videoComponent"]').count()) {
    media.push({ kind: "video" });
  }

  const isQuote = tweetTexts.length > 1;
  const relatedPosts = statusLinks.filter((item) => item.postId !== postId);
  const quotedPost = isQuote ? relatedPosts[0] || null : null;
  const isReply = /replying to/i.test(fullCardText);
  const replyingToMatch = fullCardText.match(/replying to\\s+@([A-Za-z0-9_]{1,15})/i);
  const replyingToUsername = replyingToMatch ? replyingToMatch[1].toLowerCase() : null;
  const isPinned = /\bpinned\b/i.test(socialContext) || /\bpinned\b/i.test(fullCardText.slice(0, 120));
  const relationships = [
    ...tags.hashtags.map((tag) => ({
      type: "uses_hashtag",
      targetType: "hashtag",
      targetId: tag.normalized,
      surface: tag.label
    })),
    ...tags.mentions.map((mention) => ({
      type: "mentions_account",
      targetType: "x_account",
      targetId: mention.normalized,
      surface: mention.handle
    })),
    ...quotedTags.hashtags.map((tag) => ({
      type: "quoted_content_uses_hashtag",
      targetType: "hashtag",
      targetId: tag.normalized,
      surface: tag.label
    })),
    ...quotedTags.mentions.map((mention) => ({
      type: "quoted_content_mentions_account",
      targetType: "x_account",
      targetId: mention.normalized,
      surface: mention.handle
    })),
    ...(quotedPost ? [{
      type: "quotes",
      targetType: "post",
      targetId: quotedPost.postId,
      targetUrl: quotedPost.url
    }] : []),
    ...(isRepost ? [{
      type: "reposts",
      targetType: "post",
      targetId: postId,
      targetUrl: permalink
    }] : [])
  ];

  return {
    id: postId,
    trackedCompetitor: trackedCompetitor.toLowerCase(),
    authorUsername,
    text: primaryText,
    quotedText: isQuote ? tweetTexts.slice(1) : [],
    quotedPostId: quotedPost?.postId || null,
    relatedPosts,
    hashtags: tags.hashtags,
    mentions: tags.mentions,
    quotedHashtags: quotedTags.hashtags,
    quotedMentions: quotedTags.mentions,
    relationships,
    createdAt,
    url: permalink,
    metrics,
    media,
    isReply,
    replyingToUsername,
    isRepost,
    isQuote,
    isPinned,
    postType: isRepost ? "repost" : isQuote ? "quote" : isReply ? "reply" : "post",
    timelineView,
    socialContext,
    source: "x-visible-frontend"
  };
}

export function detectStopCondition(text, url) {
  const currentPath = (() => { try { return new URL(url).pathname; } catch { return ""; } })();
  if (/\/login|\/i\/flow\//i.test(currentPath)) return "login_required";
  if (/captcha|verify your identity|unusual activity|account access/i.test(text)) return "platform_challenge";
  if (/rate limit|try again later|too many requests/i.test(text)) return "platform_limit";
  return null;
}
