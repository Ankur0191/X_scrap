import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from gliner2 import AutoExtractor

ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = ROOT / "config" / "intelligence"

MODEL_ID = os.getenv("GLINER_MODEL_ID", "fastino/gliner2.5-multi-v1")
DEVICE = os.getenv("GLINER_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
PIPELINE_VERSION = os.getenv("EXTRACTION_PIPELINE_VERSION", "0.1.0")
MODEL: Any | None = None
MODEL_LOCK = threading.Lock()

app = FastAPI(
    title="Rivalmap Intelligence Extraction Service",
    version=PIPELINE_VERSION,
    description="Local schema-driven multilingual entity, topic, complaint and relation extraction."
)


class AnalyzeRequest(BaseModel):
    post_id: str = Field(min_length=1, max_length=128)
    tracked_competitor: str = Field(min_length=1, max_length=128)
    author_username: str | None = Field(default=None, max_length=128)
    domain_id: Literal["tic", "aspire_lifestyle"]
    text: str = Field(min_length=1, max_length=30000)
    source_url: str | None = Field(default=None, max_length=2048)
    created_at: str | None = Field(default=None, max_length=64)
    conversation_root_id: str | None = Field(default=None, max_length=128)
    parent_post_id: str | None = Field(default=None, max_length=128)
    is_thread_reply: bool = False


class BatchAnalyzeRequest(BaseModel):
    items: list[AnalyzeRequest] = Field(min_length=1, max_length=25)


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


ONTOLOGY = read_json(CONFIG_DIR / "ontology.json")
DOMAIN_PROFILES = {
    "tic": read_json(CONFIG_DIR / "tic.json"),
    "aspire_lifestyle": read_json(CONFIG_DIR / "aspire.json")
}
RELATION_ENDPOINT_TYPES = ONTOLOGY.get("relationEndpointTypes", {})


def get_model():
    global MODEL
    if MODEL is None:
        with MODEL_LOCK:
            if MODEL is None:
                MODEL = AutoExtractor.from_pretrained(MODEL_ID, map_location=DEVICE)
    return MODEL


def build_entity_schema(domain_id: str) -> dict[str, str]:
    profile = DOMAIN_PROFILES[domain_id]
    schema = dict(ONTOLOGY["entityTypes"])
    schema.update(profile.get("entityExtensions", {}))
    return schema


def build_classification_schema(domain_id: str) -> dict[str, Any]:
    profile = DOMAIN_PROFILES[domain_id]
    event_labels = list(dict.fromkeys(
        profile.get("eventTypes", []) +
        ["customer_complaint", "customer_praise", "customer_question", "customer_request", "other"]
    ))
    source_voice_types = ONTOLOGY.get("sourceVoiceTypes", ["customer_or_member", "employee_or_former_employee", "partner_or_supplier", "competitor", "regulator_or_public_authority", "journalist_or_media", "industry_association", "investor_or_analyst", "general_public", "unknown"])
    journey_stages = profile.get("journeyStages", ["unknown"])
    customer_segments = profile.get("customerSegments", ["unknown"])
    industry_verticals = profile.get("industryVerticals", [])
    return {
        "sentiment": ["positive", "negative", "neutral", "mixed"],
        "source_voice": {
            "labels": source_voice_types,
            "multi_label": True,
            "cls_threshold": 0.35
        },
        "journey_stage": {
            "labels": journey_stages,
            "multi_label": True,
            "cls_threshold": 0.35
        },
        "customer_segment": {
            "labels": customer_segments,
            "multi_label": True,
            "cls_threshold": 0.35
        },
        "signal_type": {
            "labels": event_labels,
            "multi_label": True,
            "cls_threshold": 0.30
        },
        "complaint_type": {
            "labels": profile.get("complaintTypes", []),
            "multi_label": True,
            "cls_threshold": 0.35
        },
        "service_category": {
            "labels": profile.get("serviceCategories", []),
            "multi_label": True,
            "cls_threshold": 0.35
        },
        "impact_type": {
            "labels": profile.get("impactTypes", []),
            "multi_label": True,
            "cls_threshold": 0.35
        },
        **({
            "industry_vertical": {
                "labels": industry_verticals,
                "multi_label": True,
                "cls_threshold": 0.35
            }
        } if industry_verticals else {})
    }


def build_relation_labels() -> list[str]:
    return [
        "announced",
        "launched",
        "offers",
        "partners_with",
        "acquired",
        "operates_in",
        "located_in",
        "certified_by",
        "regulated_by",
        "affects",
        "experienced_by",
        "reported_from",
        "responded_to",
        "resolved_by",
        "caused_by",
        "competes_with"
    ]


def value_text(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("text", ""))
    return str(value)


def validate_relation_candidates(relation_result: Any, entity_result: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    entity_types_by_text: dict[str, set[str]] = {}
    entities = entity_result.get("entities", {}) if isinstance(entity_result, dict) else {}
    if isinstance(entities, dict):
        for entity_type, mentions in entities.items():
            if not isinstance(mentions, list):
                continue
            for mention in mentions:
                text = value_text(mention).strip().casefold()
                if text:
                    entity_types_by_text.setdefault(text, set()).add(entity_type)

    relation_groups = relation_result.get("relation_extraction", {}) if isinstance(relation_result, dict) else {}
    validated: list[dict[str, Any]] = []
    untyped: list[dict[str, Any]] = []
    if not isinstance(relation_groups, dict):
        return validated, untyped

    for relation_type, edges in relation_groups.items():
        if not isinstance(edges, list):
            continue
        endpoint_rule = RELATION_ENDPOINT_TYPES.get(relation_type)
        for edge in edges:
            if isinstance(edge, dict):
                head = edge.get("head")
                tail = edge.get("tail")
            elif isinstance(edge, (tuple, list)) and len(edge) >= 2:
                head, tail = edge[0], edge[1]
                edge = {}
            else:
                continue
            head_text = value_text(head).strip()
            tail_text = value_text(tail).strip()
            head_types = sorted(entity_types_by_text.get(head_text.casefold(), set()))
            tail_types = sorted(entity_types_by_text.get(tail_text.casefold(), set()))
            record = {
                "relationType": relation_type,
                "head": head,
                "tail": tail,
                "headEntityTypes": head_types,
                "tailEntityTypes": tail_types,
                "confidence": edge.get("confidence") if isinstance(edge, dict) else None
            }
            if (
                endpoint_rule
                and head_types
                and tail_types
                and any(kind in endpoint_rule["from"] for kind in head_types)
                and any(kind in endpoint_rule["to"] for kind in tail_types)
            ):
                validated.append(record)
            else:
                record["validationReason"] = "missing_or_incompatible_typed_endpoints"
                untyped.append(record)
    return validated, untyped


def analyze_one(item: AnalyzeRequest) -> dict[str, Any]:
    model = get_model()
    try:
        entities = model.extract_entities(
            item.text,
            build_entity_schema(item.domain_id),
            include_confidence=True,
            include_spans=True
        )
        classifications = model.classify_text(
            item.text,
            build_classification_schema(item.domain_id)
        )
        relations = model.extract_relations(
            item.text,
            build_relation_labels(),
            include_confidence=True,
            include_spans=True
        )
        validated_relations, untyped_relations = validate_relation_candidates(relations, entities)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Model extraction failed: {type(exc).__name__}: {exc}") from exc

    return {
        "schemaVersion": "1.0.0",
        "sourcePost": {
            "postId": item.post_id,
            "trackedCompetitor": item.tracked_competitor.lower().lstrip("@"),
            "authorUsername": item.author_username,
            "sourceUrl": item.source_url,
            "createdAt": item.created_at,
            "conversationRootId": item.conversation_root_id,
            "parentPostId": item.parent_post_id,
            "isThreadReply": item.is_thread_reply
        },
        "domainId": item.domain_id,
        "extraction": {
            "entities": entities.get("entities", {}) if isinstance(entities, dict) else entities,
            "classifications": classifications,
            "candidateRelations": relations.get("relation_extraction", {}) if isinstance(relations, dict) else relations,
            "validatedRelations": validated_relations,
            "untypedRelations": untyped_relations
        },
        "interpretationGuardrails": {
            "complainantRegion": "Entity extraction identifies geographic mentions only. It does not establish that a complainant is located there.",
            "rootCause": "Not inferred by this extraction stage.",
            "competitorGap": "Not established by this extraction stage; requires recurring evidence and reasoning.",
            "actionables": "Not generated by this extraction stage."
        },
        "provenance": {
            "extractor": "GLiNER2.5",
            "modelId": MODEL_ID,
            "device": DEVICE,
            "pipelineVersion": PIPELINE_VERSION,
            "processedAt": datetime.now(timezone.utc).isoformat()
        }
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "modelLoaded": MODEL is not None,
        "modelId": MODEL_ID,
        "device": DEVICE,
        "pipelineVersion": PIPELINE_VERSION
    }


@app.post("/v1/analyze")
def analyze(item: AnalyzeRequest):
    return analyze_one(item)


@app.post("/v1/analyze/batch")
def analyze_batch(request: BatchAnalyzeRequest):
    return {"results": [analyze_one(item) for item in request.items]}
