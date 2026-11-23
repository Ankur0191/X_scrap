import argparse
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
from jsonschema import Draft202012Validator


def read_json(path: Path, fallback: Any = None) -> Any:
    if not path.exists():
        return fallback
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as exc:
                print(f"Skipping malformed JSONL line {line_number}: {exc.msg}", file=sys.stderr)
    return records


def completion_url(base_url: str) -> str:
    clean = base_url.rstrip("/")
    return clean if clean.endswith("/chat/completions") else clean + "/chat/completions"


def calculate_coverage(
    domain_id: str,
    domain_by_competitor: dict[str, str | None],
    conversation_rows: list[dict[str, Any]],
    progress_rows: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    posts = 0
    competitor_replies = 0
    public_thread_replies = 0
    by_competitor: dict[str, Counter[str]] = defaultdict(Counter)

    for row in conversation_rows:
        competitor = str(row.get("trackedCompetitor") or "").lower()
        if domain_by_competitor.get(competitor) != domain_id:
            continue
        author = str(row.get("authorUsername") or "").lower()
        is_reply = bool(row.get("isReply")) or row.get("postType") == "reply"
        is_thread_reply = bool(row.get("isThreadReply"))
        is_repost = bool(row.get("isRepost")) or row.get("postType") == "repost"

        if is_thread_reply and author != competitor:
            public_thread_replies += 1
            by_competitor[competitor]["publicThreadReplies"] += 1
        elif author == competitor and is_reply:
            competitor_replies += 1
            by_competitor[competitor]["competitorReplies"] += 1
        elif author == competitor and not is_repost:
            posts += 1
            by_competitor[competitor]["posts"] += 1

    latest_progress: dict[tuple[str, str], dict[str, Any]] = {}
    for row in progress_rows:
        competitor = str(row.get("trackedCompetitor") or "").lower()
        root_id = str(row.get("rootPostId") or "")
        if domain_by_competitor.get(competitor) != domain_id or not root_id:
            continue
        key = (competitor, root_id)
        previous = latest_progress.get(key)
        if not previous or str(row.get("checkedAt", "")) >= str(previous.get("checkedAt", "")):
            latest_progress[key] = row

    statuses = Counter(str(row.get("status") or "unknown") for row in latest_progress.values())
    if latest_progress:
        coverage_status = "partial"
        status_note = "Some conversation roots were inspected, but visible UI completion does not prove every reply was exposed."
    else:
        coverage_status = "not_started"
        status_note = "No public thread-reply progress records exist for this domain."

    limitations = [
        status_note,
        "Coverage counts represent records collected into the active conversation dataset, not guaranteed platform-wide totals.",
        "Collapsed, hidden, inaccessible, removed or filtered replies may not be represented."
    ]
    coverage = {
        "posts": posts,
        "competitorReplies": competitor_replies,
        "publicThreadReplies": public_thread_replies,
        "coverageStatus": coverage_status,
        "limitations": limitations
    }
    detail = {
        "threadProgressByStatus": dict(statuses),
        "uniqueRootsInspected": len(latest_progress),
        "byCompetitor": {key: dict(value) for key, value in by_competitor.items()}
    }
    return coverage, detail


def strip_json_fence(value: str) -> str:
    text = value.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    return text


def main() -> int:
    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(
        description="Generate a schema-validated evidence-backed competitor intelligence brief using an OpenAI-compatible LLM."
    )
    parser.add_argument("--domain", choices=["tic", "aspire_lifestyle"], default=None)
    parser.add_argument("--clusters", default="data/output/signal-clusters.json")
    parser.add_argument("--conversation", default="data/output/conversation-365d.jsonl")
    parser.add_argument("--window-manifest", default="data/output/window-manifest.json")
    parser.add_argument("--conversation-manifest", default="data/output/conversation-manifest.json")
    parser.add_argument("--system-prompt", default="nlp-engine/prompts/strategic-analyst-system.md")
    parser.add_argument("--max-clusters", type=int, default=15)
    parser.add_argument("--max-events", type=int, default=15)
    parser.add_argument("--evidence-per-cluster", type=int, default=2)
    parser.add_argument("--output-dir", default="data/output")
    args = parser.parse_args()

    def resolve(value: str) -> Path:
        item = Path(value)
        return item if item.is_absolute() else (repo_root / item).resolve()

    base_url = os.getenv("REASONING_BASE_URL", "").strip()
    model_name = os.getenv("REASONING_MODEL", "").strip()
    api_key = os.getenv("REASONING_API_KEY", "").strip()
    if not base_url or not model_name:
        print(
            "Configure REASONING_BASE_URL and REASONING_MODEL. "
            "REASONING_API_KEY is optional for local endpoints.",
            file=sys.stderr
        )
        return 2

    cluster_path = resolve(args.clusters)
    conversation_path = resolve(args.conversation)
    window_manifest_path = resolve(args.window_manifest)
    conversation_manifest_path = resolve(args.conversation_manifest)
    graph_path = resolve("data/output/entity-graph.json")
    prompt_path = resolve(args.system_prompt)
    schema_path = repo_root / "schemas" / "intelligence-brief.schema.json"
    config_path = repo_root / "config" / "competitors.json"

    required_paths = [cluster_path, prompt_path, schema_path, config_path]
    missing = [str(path) for path in required_paths if not path.exists()]
    if missing:
        print(json.dumps({"error": "missing_required_input", "paths": missing}, indent=2))
        return 2

    cluster_document = read_json(cluster_path, {})
    window_manifest = read_json(window_manifest_path, {})
    conversation_manifest = read_json(conversation_manifest_path, {})
    graph_document = read_json(graph_path, {})
    config = read_json(config_path, {})
    with prompt_path.open("r", encoding="utf-8") as handle:
        system_prompt = handle.read()
    schema = read_json(schema_path, {})

    domain_by_competitor = {
        str(item.get("username", "")).replace("@", "").lower(): item.get("domainId")
        for item in config.get("competitors", [])
    }
    selected_domains = [args.domain] if args.domain else sorted({
        value for value in domain_by_competitor.values() if value in {"tic", "aspire_lifestyle"}
    })
    if not selected_domains:
        print("No enabled competitors are mapped to TIC or Aspire Lifestyle.", file=sys.stderr)
        return 2

    clusters = cluster_document.get("clusters", [])
    events = cluster_document.get("events", [])
    candidate_hypotheses = cluster_document.get("candidateOpportunityHypotheses", [])
    conversation_rows = read_jsonl(conversation_path)
    progress_rows = read_jsonl(resolve("data/output/thread-progress.jsonl"))

    output_dir = resolve(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    json_mode = os.getenv("REASONING_JSON_MODE", "1").strip().lower() not in {"0", "false", "no"}
    endpoint = completion_url(base_url)
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    all_outputs = []
    with httpx.Client(timeout=httpx.Timeout(240.0, connect=30.0)) as client:
        for domain_id in selected_domains:
            domain_competitors = [
                item for item in config.get("competitors", [])
                if item.get("enabled") and item.get("domainId") == domain_id
            ]
            domain_handles = {
                str(item.get("username", "")).replace("@", "").lower()
                for item in domain_competitors
            }
            if not domain_handles:
                continue

            domain_clusters = [
                item for item in clusters
                if str(item.get("competitor", "")).lower() in domain_handles
            ]
            domain_clusters.sort(key=lambda item: (int(item.get("volume", 0)), int(item.get("uniquePublicAuthors", 0))), reverse=True)
            domain_clusters = domain_clusters[:max(1, args.max_clusters)]
            for item in domain_clusters:
                all_ids = list(item.get("evidenceIds") or [])
                selected_evidence = (item.get("evidence") or [])[:max(1, args.evidence_per_cluster)]
                selected_ids = [str(row.get("sourcePostId")) for row in selected_evidence if row.get("sourcePostId")]
                item["totalEvidenceCount"] = len(all_ids) or int(item.get("volume", 0))
                item["additionalEvidenceIdsNotQuoted"] = [value for value in all_ids if value not in selected_ids]
                item["evidenceIds"] = selected_ids
                item["evidence"] = [
                    {**row, "quote": str(row.get("quote") or "")[:600]}
                    for row in selected_evidence
                ]

            domain_events = [
                item for item in events
                if str(item.get("competitor", "")).lower() in domain_handles
            ]
            domain_events.sort(key=lambda item: int(item.get("volume", 0)), reverse=True)
            domain_events = domain_events[:max(1, args.max_events)]
            for item in domain_events:
                all_ids = list(item.get("evidenceIds") or [])
                selected_evidence = (item.get("evidence") or [])[:max(1, args.evidence_per_cluster)]
                selected_ids = [str(row.get("sourcePostId")) for row in selected_evidence if row.get("sourcePostId")]
                item["totalEvidenceCount"] = len(all_ids) or int(item.get("volume", 0))
                item["additionalEvidenceIdsNotQuoted"] = [value for value in all_ids if value not in selected_ids]
                item["evidenceIds"] = selected_ids
                item["evidence"] = [
                    {**row, "quote": str(row.get("quote") or "")[:800]}
                    for row in selected_evidence
                ]

            domain_candidates = [
                item for item in candidate_hypotheses
                if str(item.get("competitor", "")).lower() in domain_handles
            ]
            domain_candidates.sort(
                key=lambda item: (
                    int(item.get("basis", {}).get("postCount", 0)),
                    int(item.get("basis", {}).get("uniquePublicAuthors", 0))
                ),
                reverse=True
            )
            domain_candidates = domain_candidates[:25]

            coverage, thread_detail = calculate_coverage(
                domain_id, domain_by_competitor, conversation_rows, progress_rows
            )

            domain_evidence_ids = {
                str(evidence_id)
                for cluster in domain_clusters + domain_events
                for evidence_id in (cluster.get("evidenceIds") or [])
            }
            for candidate in domain_candidates:
                domain_evidence_ids.update(str(value) for value in (candidate.get("basis", {}).get("evidenceIds") or []))
            graph_nodes = [
                node for node in graph_document.get("nodes", [])
                if domain_evidence_ids.intersection(str(value) for value in (node.get("evidenceIds") or []))
            ]
            graph_node_names = {
                node.get("entityId"): {
                    "type": node.get("type"),
                    "name": node.get("name")
                }
                for node in graph_nodes
            }
            graph_edges = [
                edge for edge in graph_document.get("edges", [])
                if domain_evidence_ids.intersection(str(value) for value in (edge.get("evidenceIds") or []))
            ]
            graph_edges.sort(
                key=lambda edge: (
                    int(edge.get("evidenceCount", 0)),
                    len(edge.get("evidenceIds") or [])
                ),
                reverse=True
            )
            entity_graph_summary = {
                "status": "available" if graph_document else "not_built",
                "totalMatchingNodes": len(graph_nodes),
                "totalMatchingEdges": len(graph_edges),
                "nodes": [
                    {
                        "entityId": node.get("entityId"),
                        "type": node.get("type"),
                        "name": node.get("name"),
                        "evidenceCount": node.get("evidenceCount", 0),
                        "evidenceIds": (node.get("evidenceIds") or [])[:5]
                    }
                    for node in sorted(graph_nodes, key=lambda item: int(item.get("evidenceCount", 0)), reverse=True)[:60]
                ],
                "edges": [
                    {
                        "relationId": edge.get("relationId"),
                        "relationType": edge.get("relationType"),
                        "from": graph_node_names.get(edge.get("fromEntityId"), {"entityId": edge.get("fromEntityId")}),
                        "to": graph_node_names.get(edge.get("toEntityId"), {"entityId": edge.get("toEntityId")}),
                        "validationStatus": edge.get("validationStatus"),
                        "evidenceCount": edge.get("evidenceCount", 0),
                        "evidenceIds": (edge.get("evidenceIds") or [])[:5]
                    }
                    for edge in graph_edges[:80]
                ]
            }
            window_days = int(window_manifest.get("window", {}).get("days") or config.get("collection", {}).get("windowDays") or 365)
            start_date = window_manifest.get("window", {}).get("startInclusive")
            end_date = window_manifest.get("window", {}).get("endInclusive")
            if not start_date:
                end = datetime.now(timezone.utc)
                start_date = (end - timedelta(days=window_days)).isoformat()
            if not end_date:
                end_date = datetime.now(timezone.utc).isoformat()

            brief_input = {
                "domainId": domain_id,
                "domainCompetitors": [
                    {
                        "username": item.get("username"),
                        "displayName": item.get("displayName"),
                        "tags": item.get("tags", [])
                    }
                    for item in domain_competitors
                ],
                "window": {
                    "days": window_days,
                    "startInclusive": start_date,
                    "endInclusive": end_date
                },
                "coverage": coverage,
                "threadCoverageDetail": thread_detail,
                "windowDatasetSummary": {
                    "recordCount": window_manifest.get("activeDataset", {}).get("recordCount"),
                    "byCompetitor": window_manifest.get("activeDataset", {}).get("byCompetitor", {}),
                    "byPostType": window_manifest.get("activeDataset", {}).get("byPostType", {}),
                    "topHashtags": window_manifest.get("activeDataset", {}).get("topHashtags", [])
                },
                "complaintClusters": domain_clusters,
                "strategicEventClusters": domain_events,
                "candidateOpportunityHypotheses": domain_candidates,
                "entityGraphSummary": entity_graph_summary,
                "limitations": cluster_document.get("limitations", [])
            }

            messages = [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": (
                        "Create an evidence-backed strategic brief for the following domain. "
                        "Use only supplied evidence, preserve unknowns, and follow the required JSON schema.\n\n"
                        + json.dumps(brief_input, ensure_ascii=False)
                    )
                }
            ]
            request_body: dict[str, Any] = {
                "model": model_name,
                "messages": messages,
                "temperature": 0.1,
                "max_tokens": 8000
            }
            if json_mode:
                request_body["response_format"] = {"type": "json_object"}

            print(f"Generating {domain_id} brief with {model_name}...")
            try:
                response = client.post(endpoint, headers=headers, json=request_body)
                response.raise_for_status()
                response_json = response.json()
                content = response_json["choices"][0]["message"]["content"]
                brief = json.loads(strip_json_fence(content))
            except Exception as exc:
                print(f"Reasoning request failed for {domain_id}: {type(exc).__name__}: {exc}", file=sys.stderr)
                return 1

            # Coverage and date boundaries are computed from local manifests and
            # conversation data, never accepted from the LLM.
            brief["schemaVersion"] = "1.0.0"
            brief["domainId"] = domain_id
            brief["window"] = brief_input["window"]
            brief["coverage"] = coverage
            brief.setdefault("modelNotes", []).append(
                f"Reasoner model: {model_name}; base URL configured locally; generation time: {datetime.now(timezone.utc).isoformat()}."
            )
            brief.setdefault("modelNotes", []).append(
                "Coverage values were calculated from local collection manifests and conversation records, not generated by the model."
            )

            errors = sorted(Draft202012Validator(schema).iter_errors(brief), key=lambda error: list(error.absolute_path))
            if errors:
                invalid_path = output_dir / f"competitor-brief-{domain_id}.invalid.json"
                with invalid_path.open("w", encoding="utf-8") as handle:
                    json.dump({"brief": brief, "validationErrors": [
                        {
                            "path": "/".join(str(part) for part in error.absolute_path),
                            "message": error.message
                        }
                        for error in errors
                    ]}, handle, ensure_ascii=False, indent=2)
                    handle.write("\n")
                print(f"Brief failed schema validation for {domain_id}; details: {invalid_path}", file=sys.stderr)
                return 1

            output_path = output_dir / f"competitor-brief-{domain_id}.json"
            with output_path.open("w", encoding="utf-8") as handle:
                json.dump(brief, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            all_outputs.append({"domainId": domain_id, "output": str(output_path)})

    print(json.dumps({"generatedBriefs": all_outputs}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
