function parseCount(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/,/g, "").trim().toUpperCase();
  const match = cleaned.match(/^(\d+(?:\.\d+)?)([KMB])?$/);
  if (!match) return null;
  const multiplier = match[2] === "K" ? 1000 : match[2] === "M" ? 1000000 : match[2] === "B" ? 1000000000 : 1;
  return Math.round(Number(match[1]) * multiplier);
}

function metricFromLabel(label) {
  const match = String(label).match(/(\d[\d,.]*(?:\.\d+)?\s*[KMB]?)\s+(repl(?:y|ies)|reposts?|likes?|views?)/i);
  if (!match) return null;
  const term = match[2].toLowerCase();
  const key = term.startsWith("repl") ? "replies" : term.startsWith("repost") ? "reposts" : term.startsWith("like") ? "likes" : "views";
  return [key, parseCount(match[1].replace(/\s/g, ""))];
}

export async function extractVisiblePost(card, trackedCompetitor, timelineView) {
  const time = card.locator("time").first();
  if (!(await time.count())) return null;
  const createdAt = await time.getAttribute("datetime");
  if (!createdAt || Number.isNaN(new Date(createdAt).getTime())) return null;

  const permalinkLinks = card.locator('a[href*="/status/"]');
  let permalink = null;
  let postId = null;
  let authorUsername = null;
  for (let index = 0; index < await permalinkLinks.count(); index += 1) {
    const href = await permalinkLinks.nth(index).getAttribute("href");
    if (!href) continue;
    const match = href.match(/^\/?([^/?#]+)\/status\/(\d+)/i);
    if (match) {
      permalink = new URL(href, "https://x.com").toString();
      authorUsername = decodeURIComponent(match[1]).replace(/^@/, "").toLowerCase();
      postId = match[2];
      break;
    }
  }
  if (!permalink || !postId || !authorUsername) return null;

  const social = card.locator('[data-testid="socialContext"]').first();
  const socialContext = await social.count() && await social.isVisible()
    ? (await social.innerText()).trim()
    : "";
  const isRepost = /reposted/i.test(socialContext) &&
    socialContext.toLowerCase().includes(trackedCompetitor.toLowerCase());

  if (authorUsername !== trackedCompetitor.toLowerCase() && !isRepost) return null;

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
  const metrics = { replies: null, reposts: null, likes: null, views: null };
  const buttons = card.locator("button");
  for (let index = 0; index < await buttons.count(); index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isVisible())) continue;
    const label = (await button.getAttribute("aria-label")) || (await button.getAttribute("title")) || "";
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
  const isReply = /replying to/i.test(fullCardText);
  return {
    id: postId,
    trackedCompetitor: trackedCompetitor.toLowerCase(),
    authorUsername,
    text: tweetTexts[0] || "",
    quotedText: isQuote ? tweetTexts.slice(1) : [],
    createdAt,
    url: permalink,
    metrics,
    media,
    isReply,
    isRepost,
    isQuote,
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
