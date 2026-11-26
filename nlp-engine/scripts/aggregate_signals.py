import argparse
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def as_labels(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        output = []
        for item in value:
            if isinstance(item, str):
                output.append(item)
            elif isinstance(item, dict):
                label = item.get("label") or item.get("value") or item.get("text")
                if label:
                    output.append(str(label))
        return output
    if isinstance(value, dict):
        label = value.get("label") or value.get("value")
        return [str(label)] if label else []
    return []


def entity_mentions(entity_result: Any, allowed_types: set[str]) -> list[dict[str, Any]]:
    if not isinstance(entity_result, dict):
        return []
    result = []
    for entity_type, mentions in entity_result.items():
        if entity_type not in allowed_types or not isinstance(mentions, list):
            continue
        for mention in mentions:
            if isinstance(mention, str):
                result.append({"type": entity_type, "text": mention, "start": None, "end": None})
            elif isinstance(mention, dict) and mention.get("text"):
                result.append({
                    "type": entity_type,
                    "text": str(mention["text"]),
                    "start": mention.get("start"),
                    "end": mention.get("end"),
                    "confidence": mention.get("confidence")
                })
    return result


def normalised_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.casefold()).strip("_")


def is_external_author(author: str, competitor: str) -> bool:
    author_key = str(author or "").replace("@", "").strip().casefold()
    competitor_key = str(competitor or "").replace("@", "").strip().casefold()
    return bool(author_key and author_key not in {"unknown", "none"} and author_key != competitor_key)


def has_thread_context(source: dict[str, Any], source_meta: dict[str, Any]) -> bool:
    fields = ("isThreadReply", "conversationRootId", "conversationRootIds", "parentPostId")
    return any(bool(source.get(field)) or bool(source_meta.get(field)) for field in fields)


def is_external_customer_voice_signal(signal_type: str, source_role: str) -> bool:
    customer_voice_signals = {
        "customer_praise",
        "customer_request",
        "customer_question",
        "customer_complaint"
    }
    return signal_type not in customer_voice_signals or source_role == "external_public_account"


def is_candidate_complaint(
    author: str,
    competitor: str,
    thread_context: bool,
    sentiment: str,
    complaint_types: list[str]
) -> bool:
    usable_complaints = [
        value for value in complaint_types
        if normalised_key(value) not in {"", "other", "other_or_unclassified", "unknown", "unclassified"}
    ]
    return (
        is_external_author(author, competitor)
        and thread_context
        and str(sentiment or "").casefold() in {"negative", "mixed"}
        and bool(usable_complaints)
    )


def main() -> int:
    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(
        description="Aggregate GLiNER-enriched source records into evidence-linked signals and candidate opportunities."
    )
    parser.add_argument("--input", default="data/output/enriched-posts.jsonl")
    parser.add_argument("--output", default="data/output/signal-clusters.json")
    parser.add_argument("--brief", default="data/output/preliminary-competitor-brief.json")
    parser.add_argument("--min-posts", type=int, default=3)
    parser.add_argument("--min-authors", type=int, default=2)
    parser.add_argument("--evidence-limit", type=int, default=20)
    parser.add_argument(
        "--include-organization-complaints",
        action="store_true",
        help="Diagnostic override: allow competitor-authored posts into complaint clusters (not recommended for gap analysis)."
    )
    args = parser.parse_args()

    def resolve(value: str) -> Path:
        path = Path(value)
        return path if path.is_absolute() else (repo_root / path).resolve()

    input_path = resolve(args.input)
    output_path = resolve(args.output)
    brief_path = resolve(args.brief)
    if not input_path.exists():
        print(json.dumps({"error": "input_not_found", "path": str(input_path)}, indent=2))
        return 2

    records = []
    malformed = []
    with input_path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as exc:
                malformed.append({"line": line_number, "error": exc.msg})

    clusters: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    event_signals: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    competitor_totals: Counter[str] = Counter()
    sentiment_totals: dict[str, Counter[str]] = defaultdict(Counter)
    geography_mentions: dict[str, Counter[str]] = defaultdict(Counter)
    tag_totals: dict[str, Counter[str]] = defaultdict(Counter)
    classified_records = 0
    complaint_records = 0
    external_feedback_by_id: dict[tuple[str, str], dict[str, Any]] = {}
    source_role_totals: dict[str, Counter[str]] = defaultdict(Counter)
    complaint_rows_excluded_official = 0
    complaint_rows_excluded_non_thread = 0
    complaint_rows_excluded_nonnegative = 0
    complaint_rows_excluded_unclassified = 0
    official_customer_voice_signals_excluded = 0

    for enriched in records:
        source = enriched.get("sourceRecord") or {}
        source_meta = enriched.get("sourcePost") or {}
        extraction = enriched.get("extraction") or {}
        classifications = extraction.get("classifications") or {}
        entities = extraction.get("entities") or {}

        competitor = str(
            source.get("trackedCompetitor")
            or source_meta.get("trackedCompetitor")
            or "unknown"
        ).lower()
        post_id = str(source.get("id") or source_meta.get("postId") or "")
        author = str(source.get("authorUsername") or source_meta.get("authorUsername") or "unknown").lower()
        text = str(source.get("text") or "")
        created_at = source.get("createdAt") or source_meta.get("createdAt")
        url = source.get("url") or source_meta.get("sourceUrl")
        post_type = str(source.get("postType") or ("reply" if source.get("isThreadReply") else "post"))
        engagement_history = source.get("engagementHistory") or {}
        visible_metrics = engagement_history.get("latestMetrics") or source.get("metrics") or {}

        try:
            created_dt = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
            if created_dt.tzinfo is None:
                created_dt = created_dt.replace(tzinfo=timezone.utc)
            month = created_dt.astimezone(timezone.utc).strftime("%Y-%m")
        except (TypeError, ValueError):
            month = "unknown"

        if not post_id:
            continue

        competitor_totals[competitor] += 1
        sentiment = as_labels(classifications.get("sentiment"))
        sentiment_label = sentiment[0] if sentiment else "unclear"
        sentiment_totals[competitor][sentiment_label] += 1

        signal_types = as_labels(classifications.get("signal_type"))
        complaint_types = as_labels(classifications.get("complaint_type"))
        service_categories = as_labels(classifications.get("service_category"))
        impact_types = as_labels(classifications.get("impact_type"))
        source_voice_candidates = as_labels(classifications.get("source_voice"))
        journey_stage_candidates = as_labels(classifications.get("journey_stage"))
        source_role = "external_public_account" if is_external_author(author, competitor) else "competitor_published_content"
        thread_context = has_thread_context(source, source_meta)
        source_role_totals[competitor][source_role] += 1
        customer_segment_candidates = as_labels(classifications.get("customer_segment"))
        industry_vertical_candidates = as_labels(classifications.get("industry_vertical"))

        if signal_types or complaint_types or service_categories or impact_types:
            classified_records += 1

        hashtags = source.get("hashtags") or []
        for tag in hashtags:
            value = tag.get("normalized") or tag.get("label") if isinstance(tag, dict) else str(tag)
            if value:
                tag_totals[competitor][str(value).lstrip("#").lower()] += 1

        geographic = entity_mentions(entities, {"region", "location"})
        for place in geographic:
            geography_mentions[competitor][place["text"]] += 1

        evidence = {
            "sourcePostId": post_id,
            "sourceUrl": url,
            "authorUsername": author,
            "createdAt": created_at,
            "month": month,
            "postType": post_type,
            "sentiment": sentiment_label,
            "text": text,
            "geographicMentions": geographic,
            "sourceRole": source_role,
            "isThreadContext": thread_context,
            "visibleMetrics": visible_metrics,
            "engagementHistory": engagement_history,
            "sourceVoiceCandidates": source_voice_candidates,
            "journeyStageCandidates": journey_stage_candidates,
            "customerSegmentCandidates": customer_segment_candidates,
            "industryVerticalCandidates": industry_vertical_candidates
        }

        if source_role == "external_public_account":
            feedback_key = (competitor, post_id)
            external_feedback_by_id[feedback_key] = {
                "competitor": competitor,
                "sourcePostId": post_id,
                "sourceUrl": url,
                "authorUsername": author,
                "createdAt": created_at,
                "month": month,
                "quote": text[:1200],
                "sentiment": sentiment_label,
                "sourceVoiceCandidates": source_voice_candidates,
                "signalTypeCandidates": signal_types,
                "complaintTypeCandidates": complaint_types,
                "serviceCategories": service_categories,
                "impactTypeCandidates": impact_types,
                "isThreadContext": thread_context,
                "isThreadReply": bool(source.get("isThreadReply") or source_meta.get("isThreadReply")),
                "conversationRootId": source.get("conversationRootId") or source_meta.get("conversationRootId"),
                "parentPostId": source.get("parentPostId") or source_meta.get("parentPostId"),
                "visibleMetrics": visible_metrics,
                "assessment": "external public account; not automatically a customer or complainant"
            }

        if complaint_types:
            is_complaint_source = (
                args.include_organization_complaints
                or is_candidate_complaint(author, competitor, thread_context, sentiment_label, complaint_types)
            )
            if not is_external_author(author, competitor) and not args.include_organization_complaints:
                complaint_rows_excluded_official += 1
            elif not thread_context and not args.include_organization_complaints:
                complaint_rows_excluded_non_thread += 1
            elif sentiment_label not in {"negative", "mixed"} and not args.include_organization_complaints:
                complaint_rows_excluded_nonnegative += 1
            elif not any(
                normalised_key(value) not in {"", "other", "other_or_unclassified", "unknown", "unclassified"}
                for value in complaint_types
            ) and not args.include_organization_complaints:
                complaint_rows_excluded_unclassified += 1

            if is_complaint_source:
                valid_complaint_types = complaint_types if args.include_organization_complaints else [
                    value for value in complaint_types
                    if normalised_key(value) not in {"", "other", "other_or_unclassified", "unknown", "unclassified"}
                ]
                for complaint_type in valid_complaint_types:
                    for service in service_categories or ["unclassified_service"]:
                        clusters[(competitor, normalised_key(complaint_type), normalised_key(service))].append({
                            **evidence,
                            "complaintType": complaint_type,
                            "serviceCategory": service,
                            "impactTypes": impact_types
                        })
                        complaint_records += 1

        for signal_type in signal_types:
            if signal_type in {"customer_complaint", "other"}:
                continue
            if not is_external_customer_voice_signal(signal_type, source_role):
                official_customer_voice_signals_excluded += 1
                continue
            event_signals[(competitor, normalised_key(signal_type))].append({
                **evidence,
                "signalType": signal_type,
                "serviceCategories": service_categories,
                "impactTypes": impact_types
            })

    cluster_output = []
    candidate_gaps = []
    for (competitor, complaint_key, service_key), items in sorted(clusters.items()):
        authors = {
            item["authorUsername"]
            for item in items
            if item["authorUsername"] not in {"", "unknown", competitor}
        }
        months = Counter(item["month"] for item in items)
        sentiment = Counter(item["sentiment"] for item in items)
        location_counts = Counter(
            mention["text"]
            for item in items
            for mention in item["geographicMentions"]
        )
        evidence_ids = [item["sourcePostId"] for item in items]
        cluster_id = f"{competitor}:complaint:{complaint_key}:{service_key}"
        cluster = {
            "clusterId": cluster_id,
            "competitor": competitor,
            "signalType": "complaint_pattern_candidate",
            "complaintType": items[0]["complaintType"],
            "serviceCategory": items[0]["serviceCategory"],
            "impactCategoriesMentioned": sorted({v for item in items for v in item.get("impactTypes", [])}),
            "sourceVoiceCandidates": sorted({v for item in items for v in item.get("sourceVoiceCandidates", [])}),
            "journeyStagesMentioned": sorted({v for item in items for v in item.get("journeyStageCandidates", [])}),
            "customerSegmentCandidates": sorted({v for item in items for v in item.get("customerSegmentCandidates", [])}),
            "industryVerticalCandidates": sorted({v for item in items for v in item.get("industryVerticalCandidates", [])}),
            "volume": len(items),
            "uniquePublicAuthors": len(authors),
            "sentimentDistribution": dict(sentiment),
            "monthlyVolume": [{"month": month, "count": count} for month, count in sorted(months.items())],
            "geographicMentions": [{"name": name, "mentionCount": count, "evidenceBasis": "text_mention_only"} for name, count in location_counts.most_common(20)],
            "evidenceIds": evidence_ids,
            "sourceRoleCounts": dict(Counter(item["sourceRole"] for item in items)),
            "evidence": [
                {
                    "sourcePostId": item["sourcePostId"],
                    "sourceUrl": item["sourceUrl"],
                    "createdAt": item["createdAt"],
                    "authorUsername": item["authorUsername"],
                    "sentiment": item["sentiment"],
                    "sourceVoiceCandidates": item.get("sourceVoiceCandidates", []),
                    "quote": item["text"][:1200],
                    "visibleMetrics": item.get("visibleMetrics", {}),
                    "engagementHistory": item.get("engagementHistory", {}),
                    "evidenceRole": "public_account_claim" if item["sourceRole"] == "external_public_account" else "organization_claim"
                }
                for item in items[:args.evidence_limit]
            ],
            "assessment": {
                "status": "candidate_requires_review",
                "isProvenCompetitorGap": False,
                "rootCause": None,
                "complainantRegion": None,
                "note": "A geographic entity mention is not evidence of the complainant's location. Counts are signals for analyst review, not verified incident counts."
            }
        }
        cluster_output.append(cluster)

        if len(items) >= args.min_posts and len(authors) >= args.min_authors:
            candidate_gaps.append({
                "candidateId": cluster_id,
                "competitor": competitor,
                "hypothesis": f"Recurring public discussion may indicate a service opportunity around {items[0]['complaintType']} in {items[0]['serviceCategory']}.",
                "basis": {
                    "postCount": len(items),
                    "uniquePublicAuthors": len(authors),
                    "evidenceIds": evidence_ids[:args.evidence_limit]
                },
                "status": "needs_human_validation",
                "provenGap": False,
                "recommendedInvestigation": "Review the linked source conversations, identify the actual service journey and check whether the organisation responded or resolved the issue."
            })

    event_output = []
    for (competitor, event_key), items in sorted(event_signals.items()):
        authors = {item["authorUsername"] for item in items if item["authorUsername"] not in {"", "unknown"}}
        external_authors = {
            item["authorUsername"] for item in items
            if item["sourceRole"] == "external_public_account" and item["authorUsername"] not in {"", "unknown"}
        }
        role_counts = Counter(item["sourceRole"] for item in items)
        months = Counter(item["month"] for item in items)
        event_output.append({
            "eventClusterId": f"{competitor}:event:{event_key}",
            "competitor": competitor,
            "signalType": items[0]["signalType"],
            "volume": len(items),
            "uniqueAuthors": len(authors),
            "uniqueExternalAuthors": len(external_authors),
            "organizationPublishedRecords": role_counts.get("competitor_published_content", 0),
            "externalPublicRecords": role_counts.get("external_public_account", 0),
            "sourceRoleCounts": dict(role_counts),
            "monthlyVolume": [{"month": month, "count": count} for month, count in sorted(months.items())],
            "serviceCategories": sorted({label for item in items for label in item.get("serviceCategories", [])}),
            "impactCategoriesMentioned": sorted({label for item in items for label in item.get("impactTypes", [])}),
            "sourceVoiceCandidates": sorted({label for item in items for label in item.get("sourceVoiceCandidates", [])}),
            "journeyStagesMentioned": sorted({label for item in items for label in item.get("journeyStageCandidates", [])}),
            "customerSegmentCandidates": sorted({label for item in items for label in item.get("customerSegmentCandidates", [])}),
            "industryVerticalCandidates": sorted({label for item in items for label in item.get("industryVerticalCandidates", [])}),
            "evidenceIds": [item["sourcePostId"] for item in items],
            "evidence": [
                {
                    "sourcePostId": item["sourcePostId"],
                    "sourceUrl": item["sourceUrl"],
                    "createdAt": item["createdAt"],
                    "quote": item["text"][:1200],
                    "visibleMetrics": item.get("visibleMetrics", {}),
                    "engagementHistory": item.get("engagementHistory", {}),
                    "evidenceRole": "organization_claim" if item["sourceRole"] == "competitor_published_content" else "public_account_claim"
                }
                for item in items[:args.evidence_limit]
            ]
        })

    external_feedback = sorted(
        external_feedback_by_id.values(),
        key=lambda item: (str(item.get("createdAt") or ""), item["competitor"], item["sourcePostId"])
    )
    external_thread_feedback = [item for item in external_feedback if item["isThreadContext"]]
    cluster_document = {
        "schemaVersion": "1.0.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": str(input_path),
        "counts": {
            "inputRecords": len(records),
            "malformedLines": len(malformed),
            "classifiedRecords": classified_records,
            "externalPublicRecords": len(external_feedback),
            "externalPublicThreadRecords": len(external_thread_feedback),
            "organizationPublishedRecords": sum(
                values.get("competitor_published_content", 0) for values in source_role_totals.values()
            ),
            "complaintClassificationRows": complaint_records,
            "complaintRowsExcludedOfficial": complaint_rows_excluded_official,
            "complaintRowsExcludedNonThread": complaint_rows_excluded_non_thread,
            "complaintRowsExcludedNonnegative": complaint_rows_excluded_nonnegative,
            "complaintRowsExcludedUnclassified": complaint_rows_excluded_unclassified,
            "officialCustomerVoiceSignalsExcluded": official_customer_voice_signals_excluded,
            "complaintClusters": len(cluster_output),
            "eventClusters": len(event_output),
            "candidateOpportunityHypotheses": len(candidate_gaps)
        },
        "complaintPolicy": {
            "default": "external_public_thread_records_only",
            "requirements": [
                "author differs from the tracked competitor account",
                "record has explicit thread context",
                "sentiment classification is negative or mixed",
                "complaint type is not other/unclassified"
            ],
            "overrideEnabled": bool(args.include_organization_complaints),
            "warning": "External public accounts are not automatically customers. Every candidate requires manual source-thread review."
        },
        "competitorTotals": dict(competitor_totals),
        "clusters": cluster_output,
        "externalPublicFeedback": external_feedback,
        "events": event_output,
        "candidateOpportunityHypotheses": candidate_gaps,
        "globalDiagnostics": {
            "sourceRolesByCompetitor": {key: dict(value) for key, value in source_role_totals.items()},
            "externalFeedbackByCompetitor": dict(Counter(item["competitor"] for item in external_feedback)),
            "sentimentByCompetitor": {key: dict(value) for key, value in sentiment_totals.items()},
            "topHashtagsByCompetitor": {
                key: [{"tag": tag, "count": count} for tag, count in counter.most_common(50)]
                for key, counter in tag_totals.items()
            },
            "geographicTextMentionsByCompetitor": {
                key: [{"name": name, "count": count} for name, count in counter.most_common(30)]
                for key, counter in geography_mentions.items()
            }
        },
        "limitations": [
            "GLiNER labels are candidate classifications and require evaluation against human-reviewed records.",
            "Complaint clusters are restricted by default to negative or mixed external public thread records; external authors are not automatically customers.",
            "Competitor-authored promotional, educational and announcement posts are excluded from complaint clusters by default but remain eligible for strategic event clusters.",
            "One external post can contribute to more than one complaint/service cluster.",
            "Geographic text mentions are not complainant regions.",
            "Recurring complaint clusters are opportunity hypotheses, not proof of competitor failure.",
            "Root causes, verified impact and final actionables require a separate evidence-grounded reasoning and review stage."
        ],
        "malformedExamples": malformed[:10]
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    brief_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(cluster_document, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    brief_document = {
        "schemaVersion": "1.0.0",
        "generatedAt": cluster_document["generatedAt"],
        "status": "preliminary_signal_analysis",
        "coverage": {
            "sourceRecordsProcessed": len(records),
            "classifiedRecords": classified_records,
            "conversationCoverage": "use conversation-manifest.json; never infer complete thread coverage from this file"
        },
        "competitorTotals": dict(competitor_totals),
        "externalPublicFeedback": external_feedback,
        "complaintPatternCandidates": [
            {
                "candidateId": item["clusterId"],
                "competitor": item["competitor"],
                "complaintType": item["complaintType"],
                "serviceCategory": item["serviceCategory"],
                "volume": item["volume"],
                "uniquePublicAuthors": item["uniquePublicAuthors"],
                "evidenceIds": item["evidenceIds"]
            }
            for item in cluster_output
        ],
        "strategicEventClusters": [
            {
                "eventClusterId": item["eventClusterId"],
                "competitor": item["competitor"],
                "signalType": item["signalType"],
                "volume": item["volume"],
                "evidenceIds": item["evidenceIds"][:args.evidence_limit]
            }
            for item in event_output
        ],
        "candidateOpportunities": candidate_gaps,
        "recommendedAnalystChecks": [
            "Review each external public reply in context; an external account is not automatically a customer or complainant.",
            "Validate the highest-volume negative or mixed complaint candidates against their original conversation threads.",
            "Check official responses and whether reported complaints were resolved.",
            "Confirm geographic context from explicit source statements, not author/profile assumptions.",
            "Compare recurring issues with competitor service pages, official launches and independent sources.",
            "Promote a competitor gap only after independent corroboration or repeated evidence across distinct authors."
        ],
        "evidenceSource": "signal-clusters.json"
    }
    with brief_path.open("w", encoding="utf-8") as handle:
        json.dump(brief_document, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    print(json.dumps({
        "inputRecords": len(records),
        "externalPublicRecords": len(external_feedback),
        "complaintClassificationRows": complaint_records,
        "complaintRowsExcludedOfficial": complaint_rows_excluded_official,
        "complaintRowsExcludedNonThread": complaint_rows_excluded_non_thread,
        "complaintRowsExcludedNonnegative": complaint_rows_excluded_nonnegative,
        "officialCustomerVoiceSignalsExcluded": official_customer_voice_signals_excluded,
        "complaintClusters": len(cluster_output),
        "eventClusters": len(event_output),
        "candidateOpportunityHypotheses": len(candidate_gaps),
        "output": str(output_path),
        "brief": str(brief_path)
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
