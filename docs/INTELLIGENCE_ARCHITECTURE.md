# Rivalmap Competitive Intelligence Engine

## Product goal

Build one reusable intelligence engine with sector-specific schemas for:
- TIC: testing, inspection and certification organisations such as SGS, Bureau Veritas, Intertek, TÜV, DEKRA and Cotecna.
- Aspire Lifestyle: payment networks, banks, card issuers, fintechs, loyalty programmes, airlines, hotels, concierge providers and premium lifestyle partners.

The engine must produce evidence-backed JSON, not merely summaries. Every important statement must point back to one or more source records.

## Rolling collection policy

The active analysis window is the latest 365 elapsed days, calculated in UTC at the beginning of each run. It is not a fixed calendar year.

For a run at time T:
- window_start = T - 365 days
- include records with published_at >= window_start and published_at <= T
- retain collected_at separately from published_at
- refresh engagement as dated snapshots rather than overwriting historical values

Older rows already present in the initial local dataset are not silently deleted. `npm run build:window` produces a clean active-window materialisation for analytics and AI. A separate retention policy can later delete expired raw data after confirmation.

## Collection completeness

Treat these as separate datasets and separate coverage counters:

1. Profile posts: original posts and reposts published by the tracked profile.
2. Competitor replies: replies authored by the tracked organisation, surfaced in its Replies timeline.
3. Public thread replies: replies written by other public accounts underneath each tracked organisation post.
4. Quote posts: third-party posts quoting a tracked post.
5. Reposts: third-party reposts of a tracked post, where available through the permitted interface.
6. Hashtags and mentions: explicit hashtags and account mentions contained in each post.
7. Thread relationships: reply-to, quote-of, repost-of and conversation-root edges.

The profile collector covers profile Posts and Replies timelines and extracts explicit hashtags and mentions. A separate conversation crawler now builds a queue of in-window original posts, opens each conversation and captures cards that the visible UI explicitly identifies as replies. It records the root ID, visible reply author, visible "replying to" account and parent ID when that parent is present earlier in the same visible thread.

The thread crawler records per-root progress and distinguishes:
- visible-end reached (the visible UI stopped yielding identified replies)
- partial/unclassified cards
- root unavailable
- safety limit reached

A visible-end state is not proof that X exposed every reply. Collapsed, unavailable, hidden, removed, probable-spam or otherwise inaccessible replies remain coverage gaps. Keep the conversation coverage status partial until a validation sample confirms that the interface presents all in-scope replies.

A profile scan is complete for the 365-day window only if it reaches the old-date boundary using multiple consecutive screens containing no in-window posts. Hitting a safety scroll limit is partial. A screen containing duplicates is not evidence that the end of the history has been reached.

## Canonical record layers

### A. Immutable source record

Store exactly what was visible or returned by an authorised source:
- source platform and account
- post ID, parent/root post ID, permalink
- original author and tracked competitor
- raw text, language, created_at
- visible media references and links
- explicit hashtags and mentions
- visible engagement counts
- collected_at and collection run ID
- source method and coverage notes

Do not replace source text with an AI summary. Preserve source URLs and exact text.

### B. Normalised conversation graph

Represent each source post as a node. Relations include:
- REPLIES_TO
- QUOTES
- REPOSTS
- CONTAINS_HASHTAG
- MENTIONS_ACCOUNT
- AUTHOR_OF
- PUBLISHED_BY
- APPEARS_IN_THREAD_ROOT

For third-party replies, retain both the reply author and the competitor/root post being discussed. Never confuse the timeline from which a post was found with the post's actual type.

### C. Extraction layer

Use GLiNER2.5 Multi as the initial local extractor:
- model: `fastino/gliner2.5-multi-v1`
- entity spans with character offsets and confidence
- multi-label signal and topic classification
- candidate relations between named entities
- domain-specific schema descriptions

GLiNER2.5 Multi is 287M parameters, multilingual, and supports entity extraction, classification, structured records and relation extraction locally. The checkpoint is Apache-2.0 licensed. Use `AutoExtractor`, not the legacy span-only loader. See:
- https://github.com/fastino-ai/GLiNER2
- https://huggingface.co/fastino/gliner2.5-multi-v1

### D. Reasoning layer

GLiNER is not the entire reasoning engine. A separate LLM step should:
- classify the nature and context of a complaint
- distinguish customer voice, organisation marketing, news and third-party commentary
- infer likely root cause only when evidence supports it
- identify unmet needs and candidate competitor gaps
- estimate potential business impact while explicitly labelling hypotheses
- recommend actions tied to evidence and success metrics

Keep this provider-swappable: a hosted reasoning model or a local Qwen-family model can be benchmarked against a labelled evaluation set. Do not bind the data schema to a single model vendor.

### E. Aggregation and signal intelligence

Do not create strategic recommendations from one post in isolation. Aggregate over time and across unique authors:
- issue/complaint clusters
- unique complainant counts
- recurrence and trend acceleration
- explicit regions and language
- customer journey stages
- product/service affected
- organisation responses and claimed resolutions
- competing announcements and launches
- shifts in partnership, technology and market presence

Use deduplication and author-level controls so one prolific account or repeated repost does not masquerade as broad customer sentiment.

## Common intelligence fields

Every enriched event should support:
- primary and secondary signal type
- sentiment, customer-voice status and source stance
- issue/complaint type and journey stage
- product/service and industry vertical
- entities and directed relations
- explicit location and evidence basis
- observed versus potential impact
- severity and time horizon
- competitor gap candidate and recurrence count
- recommended action, owner function and success metric
- source post/reply IDs, URLs and exact evidence quotes
- extractor/reasoner model names, versions, confidence and human-review status

## Complaint geography rules

A complainant's region is:
- explicit when written in the post or conversation
- corroborated when another source in the same thread explicitly confirms it
- unknown otherwise

Do not infer a complainant's location from their name, profile photo, language, nationality, inferred ethnicity or account handle. Keep organisation operating regions separate from complainant region. Store inferred geography separately with low confidence if a later, explicitly approved analytic use case requires it.

## TIC intelligence lenses

Track service quality, laboratory and inspection capacity, accreditation scopes, test-method coverage, certificate/report turnaround, procurement, standards/regulation changes, contract wins, facility openings, acquisitions, new markets, technology, sustainability, safety and customer trust.

Possible opportunity signals:
- repeat delays or report accuracy complaints
- underserved geography or industry vertical
- emerging regulations with insufficient certification capacity
- new test methods or accreditation scope
- customer need for better sample visibility, digital workflow or certificate traceability
- contract wins or capability expansions that alter competitive positioning

## Aspire Lifestyle intelligence lenses

Track cardholder benefits, issuer and network partnerships, premium banking, airport lounges, travel and hotel access, concierge resolution, dining and experiences, reward/loyalty changes, merchant offers, insurance, FX, cross-border payment acceptance, fraud/disputes, customer retention and service reliability.

Possible opportunity signals:
- benefits advertised but not honoured
- lounge/merchant coverage gaps by region
- slow concierge fulfilment or poor resolution
- reward restrictions, devaluation or redemption friction
- payment acceptance/authorisation problems
- new issuer/network partnerships or new premium propositions
- travel disruption and insurance/service gaps

## Evidence and confidence policy

- Every entity, relationship, complaint, event and recommended action must reference source record IDs.
- Exact quote and character offsets should be retained where possible.
- Model confidence is not truth probability; calibrate against human-labelled examples.
- Do not call a competitor gap proven based on one complaint. Label it a hypothesis until recurring independent evidence or an independent source supports it.
- Keep counter-evidence and official responses, not only negative commentary.
- Separate organisation claims from independently verified facts.
- Store unknown as null or unknown, not a plausible guess.

## Target JSON outputs

1. `posts-365d.jsonl`: in-window profile source records.
2. `thread-replies.jsonl`: visible public replies linked to conversation root IDs.
3. `conversation-365d.jsonl`: deduplicated profile records and thread replies, ready for NLP.
4. `enriched-posts.jsonl`: per-record entities, classifications, validated/candidate relations and extraction provenance.
3. `intelligence-events.jsonl`: complaint, launch, partnership, regulatory, product and incident events.
4. `entity-graph.jsonl`: canonical organisations, services, products, regions, issues and relation edges.
5. `competitor-brief.json`: 365-day executive intelligence brief with trends, gaps, opportunities and actionables.

See:
- `schemas/intelligence-event.schema.json`
- `schemas/intelligence-brief.schema.json`
- `config/intelligence/ontology.json`
- `config/intelligence/tic.json`
- `config/intelligence/aspire.json`

## Build sequence

1. Finish rolling-window profile collection and coverage status.
2. Add dedicated public conversation/thread collection.
3. Validate hashtag, mention, quote and repost links.
4. Run GLiNER2.5 Multi on a labelled sample from both sectors.
5. Add LLM reasoning only after extraction schema and evidence links are stable.
6. Cluster recurring issues and business events.
7. Build evidence-backed competitor gap and actionability reports.
8. Connect the outputs to the respective Rivalmap Supabase projects.

Do not start large historical backfills until the 365-day boundary and per-thread completeness states are validated on a small sample.
