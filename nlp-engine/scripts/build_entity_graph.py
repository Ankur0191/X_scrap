import argparse
import hashlib
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def stable_id(node_type: str, name: str) -> str:
    normalized = re.sub(r"\s+", " ", str(name).strip()).casefold()
    digest = hashlib.sha256(f"{node_type}:{normalized}".encode("utf-8")).hexdigest()[:20]
    return f"{node_type}:{digest}"


def span_text(value: Any) -> tuple[str, dict[str, Any]]:
    if isinstance(value, str):
        return value.strip(), {}
    if isinstance(value, dict):
        text = str(value.get("text") or value.get("value") or "").strip()
        metadata = {
            key: value.get(key)
            for key in ("start", "end", "confidence")
            if value.get(key) is not None
        }
        return text, metadata
    return "", {}


def add_node(
    nodes: dict[str, dict[str, Any]],
    node_type: str,
    name: str,
    evidence_id: str | None = None,
    evidence_url: str | None = None,
    observed_at: str | None = None,
    confidence: float | None = None,
    metadata: dict[str, Any] | None = None,
) -> str:
    clean_name = str(name or "").strip()
    if not clean_name:
        return ""
    entity_id = stable_id(node_type, clean_name)
    node = nodes.setdefault(entity_id, {
        "entityId": entity_id,
        "type": node_type,
        "name": clean_name,
        "normalizedName": re.sub(r"\s+", " ", clean_name).casefold(),
        "canonicalId": None,
        "evidenceIds": set(),
        "evidenceUrls": set(),
        "observations": 0,
        "firstSeen": None,
        "lastSeen": None,
        "confidenceScores": [],
        "metadata": {}
    })
    node["observations"] += 1
    if evidence_id:
        node["evidenceIds"].add(str(evidence_id))
    if evidence_url:
        node["evidenceUrls"].add(str(evidence_url))
    if observed_at:
        if node["firstSeen"] is None or observed_at < node["firstSeen"]:
            node["firstSeen"] = observed_at
        if node["lastSeen"] is None or observed_at > node["lastSeen"]:
            node["lastSeen"] = observed_at
    if confidence is not None:
        try:
            node["confidenceScores"].append(float(confidence))
        except (TypeError, ValueError):
            pass
    if metadata:
        for key, value in metadata.items():
            if value is not None and key not in node["metadata"]:
                node["metadata"][key] = value
    return entity_id


def add_edge(
    edges: dict[str, dict[str, Any]],
    relation_type: str,
    from_id: str,
    to_id: str,
    evidence_id: str | None,
    evidence_url: str | None,
    confidence: float | None = None,
    validation_status: str = "explicit_source_relationship",
    metadata: dict[str, Any] | None = None,
) -> None:
    if not relation_type or not from_id or not to_id:
        return
    key_source = f"{relation_type}:{from_id}:{to_id}"
    edge_id = "rel:" + hashlib.sha256(key_source.encode("utf-8")).hexdigest()[:20]
    edge = edges.setdefault(edge_id, {
        "relationId": edge_id,
        "relationType": relation_type,
        "fromEntityId": from_id,
        "toEntityId": to_id,
        "validationStatus": validation_status,
        "evidenceIds": set(),
        "evidenceUrls": set(),
        "confidenceScores": [],
        "metadata": {}
    })
    if evidence_id:
        edge["evidenceIds"].add(str(evidence_id))
    if evidence_url:
        edge["evidenceUrls"].add(str(evidence_url))
    if confidence is not None:
        try:
            edge["confidenceScores"].append(float(confidence))
        except (TypeError, ValueError):
            pass
    if metadata:
        for key, value in metadata.items():
            if value is not None and key not in edge["metadata"]:
                edge["metadata"][key] = value


def relation_endpoint(value: Any) -> str:
    text, _ = span_text(value)
    return text


def main() -> int:
    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="Build a typed, evidence-linked entity and relationship graph.")
    parser.add_argument("--input", default="data/output/enriched-posts.jsonl")
    parser.add_argument("--output", default="data/output/entity-graph.json")
    parser.add_argument("--min-confidence", type=float, default=0.0)
    args = parser.parse_args()

    def resolve(value: str) -> Path:
        path = Path(value)
        return path if path.is_absolute() else (repo_root / path).resolve()

    input_path = resolve(args.input)
    output_path = resolve(args.output)
    if not input_path.exists():
        print(json.dumps({"error": "input_not_found", "path": str(input_path)}, indent=2))
        return 2

    nodes: dict[str, dict[str, Any]] = {}
    edges: dict[str, dict[str, Any]] = {}
    records_read = 0
    malformed = []
    with input_path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                enriched = json.loads(line)
            except json.JSONDecodeError as exc:
                malformed.append({"line": line_number, "error": exc.msg})
                continue

            source = enriched.get("sourceRecord") or {}
            source_meta = enriched.get("sourcePost") or {}
            extraction = enriched.get("extraction") or {}
            entities = extraction.get("entities") or {}
            evidence_id = str(source.get("id") or source_meta.get("postId") or "")
            evidence_url = source.get("url") or source_meta.get("sourceUrl")
            observed_at = source.get("createdAt") or source_meta.get("createdAt")
            tracked = str(source.get("trackedCompetitor") or source_meta.get("trackedCompetitor") or "").lower()
            author = str(source.get("authorUsername") or source_meta.get("authorUsername") or "").lower()
            if not evidence_id:
                continue
            records_read += 1

            post_id = add_node(
                nodes, "social_post", evidence_id, evidence_id, evidence_url, observed_at,
                metadata={
                    "trackedCompetitor": tracked,
                    "authorUsername": author,
                    "postType": source.get("postType"),
                    "publishedAt": observed_at
                }
            )

            # Explicit author and tracked-account relationships.
            if author:
                author_id = add_node(nodes, "x_account", author, evidence_id, evidence_url, observed_at)
                add_edge(edges, "authored_by", post_id, author_id, evidence_id, evidence_url)
            if tracked:
                add_node(nodes, "x_account", tracked, evidence_id, evidence_url, observed_at)

            # GLiNER named entities and spans.
            entity_surface_ids: dict[tuple[str, str], str] = {}
            if isinstance(entities, dict):
                for entity_type, mentions in entities.items():
                    if not isinstance(mentions, list):
                        continue
                    for mention in mentions:
                        name, mention_meta = span_text(mention)
                        if not name:
                            continue
                        confidence = mention_meta.get("confidence")
                        entity_id = add_node(
                            nodes,
                            str(entity_type),
                            name,
                            evidence_id,
                            evidence_url,
                            observed_at,
                            confidence,
                            metadata={
                                "exampleSpan": {
                                    "start": mention_meta.get("start"),
                                    "end": mention_meta.get("end")
                                }
                            }
                        )
                        entity_surface_ids[(str(entity_type), name.casefold())] = entity_id

            # Only ontology-validated relation candidates are promoted. Untyped
            # candidates are preserved with an explicit unvalidated state.
            for relation in extraction.get("validatedRelations") or []:
                if not isinstance(relation, dict):
                    continue
                head_text = relation_endpoint(relation.get("head"))
                tail_text = relation_endpoint(relation.get("tail"))
                head_types = relation.get("headEntityTypes") or []
                tail_types = relation.get("tailEntityTypes") or []
                if not head_text or not tail_text or not head_types or not tail_types:
                    continue
                head_type = str(head_types[0])
                tail_type = str(tail_types[0])
                head_id = entity_surface_ids.get((head_type, head_text.casefold())) or add_node(
                    nodes, head_type, head_text, evidence_id, evidence_url, observed_at
                )
                tail_id = entity_surface_ids.get((tail_type, tail_text.casefold())) or add_node(
                    nodes, tail_type, tail_text, evidence_id, evidence_url, observed_at
                )
                confidence = relation.get("confidence")
                if confidence is not None and float(confidence) < args.min_confidence:
                    continue
                add_edge(
                    edges,
                    str(relation.get("relationType") or "related_to"),
                    head_id,
                    tail_id,
                    evidence_id,
                    evidence_url,
                    confidence,
                    validation_status="ontology_endpoint_validated"
                )

            for relation in extraction.get("untypedRelations") or []:
                if not isinstance(relation, dict):
                    continue
                head_text = relation_endpoint(relation.get("head"))
                tail_text = relation_endpoint(relation.get("tail"))
                head_types = relation.get("headEntityTypes") or ["unknown_entity"]
                tail_types = relation.get("tailEntityTypes") or ["unknown_entity"]
                if not head_text or not tail_text:
                    continue
                head_id = entity_surface_ids.get((str(head_types[0]), head_text.casefold())) or add_node(
                    nodes, str(head_types[0]), head_text, evidence_id, evidence_url, observed_at
                )
                tail_id = entity_surface_ids.get((str(tail_types[0]), tail_text.casefold())) or add_node(
                    nodes, str(tail_types[0]), tail_text, evidence_id, evidence_url, observed_at
                )
                add_edge(
                    edges,
                    str(relation.get("relationType") or "related_to"),
                    head_id,
                    tail_id,
                    evidence_id,
                    evidence_url,
                    relation.get("confidence"),
                    validation_status="candidate_untyped_or_incompatible"
                )

            # Explicit social graph edges captured from the visible source.
            for relation in source.get("relationships") or []:
                if not isinstance(relation, dict):
                    continue
                relation_type = str(relation.get("type") or "")
                target_type = str(relation.get("targetType") or "")
                if target_type == "post":
                    target_type = "social_post"
                target_name = str(relation.get("targetId") or "").strip()
                source_type = str(relation.get("sourceType") or "social_post")
                if source_type == "post":
                    source_type = "social_post"
                source_name = str(relation.get("sourceId") or evidence_id).strip()
                if not target_type or not target_name:
                    continue
                from_id = add_node(nodes, source_type, source_name, evidence_id, evidence_url, observed_at)
                to_id = add_node(nodes, target_type, target_name, evidence_id, evidence_url, observed_at)
                add_edge(
                    edges,
                    relation_type,
                    from_id,
                    to_id,
                    evidence_id,
                    evidence_url,
                    validation_status="explicit_visible_frontend_relationship"
                )

            # Thread links are carried as typed fields in the normalized record.
            root_ids = source.get("conversationRootIds") or []
            if source.get("conversationRootId"):
                root_ids = list(root_ids) + [str(source["conversationRootId"])]
            unique_roots = sorted(set(str(value) for value in root_ids if value))
            for root_id in unique_roots:
                root_entity_id = add_node(nodes, "social_post", root_id, evidence_id, None, None)
                add_edge(
                    edges, "appears_in_conversation_under", post_id, root_entity_id,
                    evidence_id, evidence_url,
                    validation_status="explicit_thread_collection_context"
                )
            if source.get("parentPostId"):
                parent_id = add_node(nodes, "social_post", str(source["parentPostId"]), evidence_id, None, None)
                add_edge(
                    edges, "replies_to", post_id, parent_id,
                    evidence_id, evidence_url,
                    validation_status="visible_reply_context"
                )

    node_rows = []
    for node in nodes.values():
        confidences = node.pop("confidenceScores")
        node["evidenceIds"] = sorted(node["evidenceIds"])
        node["evidenceUrls"] = sorted(node["evidenceUrls"])
        node["evidenceCount"] = len(node["evidenceIds"])
        node["averageExtractorConfidence"] = (
            sum(confidences) / len(confidences) if confidences else None
        )
        node_rows.append(node)

    edge_rows = []
    for edge in edges.values():
        confidences = edge.pop("confidenceScores")
        edge["evidenceIds"] = sorted(edge["evidenceIds"])
        edge["evidenceUrls"] = sorted(edge["evidenceUrls"])
        edge["evidenceCount"] = len(edge["evidenceIds"])
        edge["averageExtractorConfidence"] = (
            sum(confidences) / len(confidences) if confidences else None
        )
        edge_rows.append(edge)

    node_rows.sort(key=lambda item: (item["type"], item["normalizedName"]))
    edge_rows.sort(key=lambda item: (item["relationType"], item["fromEntityId"], item["toEntityId"]))

    output = {
        "schemaVersion": "1.0.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": str(input_path),
        "counts": {
            "sourceRecords": records_read,
            "nodes": len(node_rows),
            "edges": len(edge_rows),
            "nodesByType": dict(Counter(node["type"] for node in node_rows)),
            "edgesByRelationType": dict(Counter(edge["relationType"] for edge in edge_rows)),
            "edgesByValidationStatus": dict(Counter(edge["validationStatus"] for edge in edge_rows))
        },
        "nodes": node_rows,
        "edges": edge_rows,
        "limitations": [
            "Entity IDs are deterministically normalised by type and surface form; aliases are not automatically merged.",
            "Validated GLiNER relation edges have compatible ontology endpoint types, but still require human review for factual correctness.",
            "Unvalidated relation candidates are retained separately and must not be treated as confirmed relationships.",
            "Public account handles are not automatically classified as customers or complainants.",
            "Thread edges reflect the visible conversation records collected so far, not guaranteed full platform coverage."
        ],
        "malformedLines": malformed
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(output, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    print(json.dumps({
        "sourceRecords": records_read,
        "nodes": len(node_rows),
        "edges": len(edge_rows),
        "nodesByType": output["counts"]["nodesByType"],
        "edgesByRelationType": output["counts"]["edgesByRelationType"],
        "output": str(output_path)
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
