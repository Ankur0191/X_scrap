# Normalized visible-post schema

Each line in `data/output/posts.jsonl` is one collected source record.

| Field | Type | Meaning |
|---|---|---|
| id | string | X post ID |
| trackedCompetitor | string | Target account whose profile or thread led to the record |
| authorUsername | string | Account shown as the post author |
| text | string | Visible primary post text |
| quotedText | string[] | Visible quoted content, when detected |
| quotedPostId | string or null | Quoted post ID, when the visible card exposes it |
| relatedPosts | object[] | Other visible status links associated with the card |
| relatedPosts | object[] | Other visible status links associated with the card |
| createdAt | ISO-8601 string | Publication timestamp normalised to UTC |
| url | string | Visible post permalink |
| hashtags | object[] | Explicit hashtags from primary text, including normalised label and text offsets |
| mentions | object[] | Explicit @mentions from primary text |
| quotedHashtags | object[] | Explicit hashtags in visible quoted text |
| quotedMentions | object[] | Explicit @mentions in visible quoted text |
| quotedHashtags | object[] | Explicit hashtags in separately visible quoted text |
| quotedMentions | object[] | Explicit @mentions in separately visible quoted text |
| relationships | object[] | Candidate edges such as uses_hashtag, mentions_account, quotes and reposts |
| metrics | object | Visible replies, reposts, likes and views; unavailable values remain null |
| media | object[] | Visible image alt/display URL and video-presence metadata |
| isReply | boolean | Best-effort reply indicator from visible UI context |
| isRepost | boolean | Visible repost social context |
| isQuote | boolean | A quoted post was detected in the card |
| isPinned | boolean | Best-effort visible pinned indicator |
| conversationRootId | string or null | Root post ID for a public thread reply |
| conversationRootIds | string[] | Root post IDs when one reply record is associated with multiple root contexts |
| parentPostId | string or null | Direct parent when explicitly identified in the visible thread |
| replyingToUsername | string or null | Account handle shown in visible "Replying to" context |
| isThreadReply | boolean | Whether the record came from the public conversation reply collector |
| parentPostId | string or null | Direct parent when explicitly captured |
| postType | string | post, reply, repost or quote |
| timelineView | string | posts or with_replies; discovery location, not post type |
| socialContext | string | Visible context label |
| source | string | Acquisition provenance |
| ingestedAt | ISO-8601 string | Local collection time |

Deduplication key: `trackedCompetitor:id`.

The `posts-365d.jsonl` materialisation adds hashtags and @mentions derived from legacy source text without rewriting the raw `posts.jsonl`.

Do not treat missing engagement counts as zero. These values describe what was visible at collection time, not lifetime totals. Do not infer private or sensitive facts about people from post content. Thread replies from other public accounts require the separate conversation collector and should not be marked complete until thread coverage is validated.
