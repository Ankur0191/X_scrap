import test from "node:test";
import assert from "node:assert/strict";
import { parseCount, metricFromLabel, extractHashtagsAndMentions, classifyVisibleThreadReply, isThreadRootCandidate, isProbableSpamControlLabel, selectConversationAncestor, selectTrackedCompetitors } from "../src/collector/visible-post.js";

test("parses compact engagement counts", () => {
  assert.equal(parseCount("1.2K"), 1200);
  assert.equal(parseCount("2M"), 2000000);
  assert.equal(parseCount("1,234"), 1234);
  assert.equal(parseCount("not available"), null);
});

test("maps visible X action labels to metric fields", () => {
  assert.deepEqual(metricFromLabel("1.2K Likes. Like"), ["likes", 1200]);
  assert.deepEqual(metricFromLabel("43 Replies. Reply"), ["replies", 43]);
  assert.deepEqual(metricFromLabel("8 reposts. Repost"), ["reposts", 8]);
  assert.equal(metricFromLabel("Reply"), null);
});

test("extracts unicode hashtags and explicit account mentions", () => {
  const result = extractHashtagsAndMentions("We launched #AI #TIC and partnered with @ExampleOrg.");
  assert.deepEqual(result.hashtags.map((item) => item.normalized), ["ai", "tic"]);
  assert.deepEqual(result.mentions.map((item) => item.normalized), ["exampleorg"]);
  assert.equal(result.hashtags[0].start >= 0, true);
});

test("deduplicates repeated tags while preserving original label", () => {
  const result = extractHashtagsAndMentions("#SGS and #sgs are part of this update.");
  assert.equal(result.hashtags.length, 1);
  assert.equal(result.hashtags[0].normalized, "sgs");
  assert.equal(result.hashtags[0].label, "SGS");
});

test("classifies an inline reply when X omits the replying-to label but root count and order support it", () => {
  assert.deepEqual(classifyVisibleThreadReply({
    explicitReply: false,
    candidateIndex: 1,
    rootIndex: 0,
    rootReplyCount: 1,
    rootCreatedAt: "2026-10-09T18:30:00.000Z",
    candidateCreatedAt: "2026-10-10T01:23:35.000Z",
    alreadyClassifiedCount: 0
  }), { isReply: true, method: "root_reply_count_order" });
});

test("does not classify inline cards beyond the root's visible reply count", () => {
  assert.deepEqual(classifyVisibleThreadReply({
    explicitReply: false,
    candidateIndex: 2,
    rootIndex: 0,
    rootReplyCount: 1,
    rootCreatedAt: "2026-10-09T18:30:00.000Z",
    candidateCreatedAt: "2026-10-10T01:23:35.000Z",
    alreadyClassifiedCount: 1
  }), { isReply: false, method: null });
});

test("does not classify cards that precede the root or predate it", () => {
  const base = {
    explicitReply: false,
    rootIndex: 1,
    rootReplyCount: 1,
    rootCreatedAt: "2026-10-09T18:30:00.000Z",
    candidateCreatedAt: "2026-10-10T01:23:35.000Z",
    alreadyClassifiedCount: 0
  };
  assert.equal(classifyVisibleThreadReply({ ...base, candidateIndex: 0 }).isReply, false);
  assert.equal(classifyVisibleThreadReply({
    ...base,
    candidateIndex: 2,
    candidateCreatedAt: "2026-10-08T01:23:35.000Z"
  }).isReply, false);
});


test("only original competitor Posts timeline entries become conversation roots", () => {
  const base = {
    trackedCompetitor: "sgs_sa",
    authorUsername: "SGS_SA",
    timelineView: "posts",
    isReply: false,
    isRepost: false
  };
  assert.equal(isThreadRootCandidate(base), true);
  assert.equal(isThreadRootCandidate({ ...base, timelineView: "with_replies" }), false);
  assert.equal(isThreadRootCandidate({ ...base, authorUsername: "customer123" }), false);
  assert.equal(isThreadRootCandidate({ ...base, isReply: true }), false);
  assert.equal(isThreadRootCandidate({ ...base, isRepost: true }), false);
});


test("selects an earlier conversation ancestor only when its author also appears in a later captured reply", () => {
  const result = selectConversationAncestor({
    rootAuthorUsername: "sgs_sa",
    rootCreatedAt: "2026-04-17T05:18:33.000Z",
    externalReplyAuthors: ["harshentrepre"],
    maxAgeHours: 72,
    candidates: [
      {
        id: "marketing-post",
        authorUsername: "sgs_sa",
        createdAt: "2026-04-15T13:00:58.000Z",
        text: "Earlier SGS post"
      },
      {
        id: "customer-inquiry",
        authorUsername: "harshentrepre",
        createdAt: "2026-04-17T01:26:25.000Z",
        text: "Could you help me with startups?"
      }
    ]
  });
  assert.equal(result.candidate.id, "customer-inquiry");
  assert.equal(result.discoveryMethod, "same_author_as_later_visible_reply_before_anchor");
  assert.equal(result.relationshipStatus, "candidate_unverified");
});

test("does not select an earlier card without participant continuity or outside age window", () => {
  const base = {
    rootAuthorUsername: "sgs_sa",
    rootCreatedAt: "2026-04-17T05:18:33.000Z",
    externalReplyAuthors: ["harshentrepre"],
    maxAgeHours: 72
  };
  assert.equal(selectConversationAncestor({
    ...base,
    candidates: [{
      id: "unrelated",
      authorUsername: "someone_else",
      createdAt: "2026-04-17T01:26:25.000Z"
    }]
  }), null);
  assert.equal(selectConversationAncestor({
    ...base,
    candidates: [{
      id: "too-old",
      authorUsername: "harshentrepre",
      createdAt: "2026-04-10T01:26:25.000Z"
    }]
  }), null);
});


test("explicit reply context is accepted only after the selected root card", () => {
  const base = {
    explicitReply: true,
    rootReplyCount: 1,
    rootCreatedAt: "2026-04-17T05:18:33.000Z",
    candidateCreatedAt: "2026-04-17T14:08:08.000Z",
    alreadyClassifiedCount: 0
  };
  assert.deepEqual(classifyVisibleThreadReply({
    ...base,
    candidateIndex: 2,
    rootIndex: 1
  }), { isReply: true, method: "explicit_reply_context" });
  assert.deepEqual(classifyVisibleThreadReply({
    ...base,
    candidateIndex: 0,
    rootIndex: 1
  }), { isReply: false, method: null });
  assert.deepEqual(classifyVisibleThreadReply({
    ...base,
    candidateIndex: 0,
    rootIndex: -1
  }), { isReply: false, method: null });
});


test("recognizes X probable-spam expansion labels without matching unrelated controls", () => {
  assert.equal(isProbableSpamControlLabel("Show probable spam"), true);
  assert.equal(isProbableSpamControlLabel("Show 2 probable spam replies"), true);
  assert.equal(isProbableSpamControlLabel(" Show probable spams "), true);
  assert.equal(isProbableSpamControlLabel("Replies hidden by X · Show probable spam"), true);
  assert.equal(isProbableSpamControlLabel("Show probable spam replies (1)"), true);
  assert.equal(isProbableSpamControlLabel("Show more replies"), false);
  assert.equal(isProbableSpamControlLabel("Probable spam"), false);
  assert.equal(isProbableSpamControlLabel("Hide probable spam"), false);
  assert.equal(isProbableSpamControlLabel("Probable spam replies"), false);
});

test("selects only enabled competitors in the requested domain", () => {
  const accounts = [
    { username: "SGS_SA", domainId: "tic", enabled: true },
    { username: "applus", domainId: "tic", enabled: true },
    { username: "tenlifestyle", domainId: "aspire_lifestyle", enabled: true },
    { username: "kiwa_global", domainId: "tic", enabled: false }
  ];
  assert.deepEqual(
    selectTrackedCompetitors(accounts, { domainFilter: "TIC" }).map((item) => item.username),
    ["SGS_SA", "applus"]
  );
  assert.deepEqual(
    selectTrackedCompetitors(accounts, { domainFilter: "tic", accountFilter: "@APPLUS" }).map((item) => item.username),
    ["applus"]
  );
});
