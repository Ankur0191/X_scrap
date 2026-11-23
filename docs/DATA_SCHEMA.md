# Normalized visible-post schema

Each line in `data/output/posts.jsonl` is one JSON record.

| Field | Type | Meaning |
|---|---|---|
| id | string | X post ID |
| trackedCompetitor | string | Competitor profile from which the post was collected |
| authorUsername | string | Original author shown on the visible post |
| text | string | Visible primary post text; may be empty for media-only posts |
| quotedText | string[] | Separately visible quoted-post text, when detected |
| createdAt | ISO-8601 string | Visible post timestamp normalized to UTC |
| url | string | Canonical post URL |
| metrics | object | Visible replies, reposts, likes and views; unavailable values are null |
| media | object[] | Visible image alt/display URL and video presence metadata |
| isReply | boolean | Whether visible card text indicates a reply |
| isRepost | boolean | Whether visible social context indicates a repost in the tracked profile timeline |
| isQuote | boolean | Whether a quoted post was detected in the card |
| isPinned | boolean | Whether visible card text indicates a pinned post |
| postType | string | post, reply, repost or quote |
| timelineView | string | posts or with_replies |
| socialContext | string | Visible context label, if present |
| source | string | Acquisition provenance |
| ingestedAt | ISO-8601 string | Local collection time |

Deduplication key: `trackedCompetitor:id`.

Do not treat missing engagement counts as zero. The data represents what was displayed at collection time, not necessarily the current lifetime totals. Do not infer private or sensitive facts about people from post content.
