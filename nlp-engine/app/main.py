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
    text: str = Field(min_length=1, max_length=12000)
    source_url: str | None = Field(default=None, max_length=2048)
    created_at: str | None = Field(default=None, max_length=64)
    conversation_root_id: str | None = Field(default=None, max_length=128)


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
    return {
        "sentiment": ["positive", "negative", "neutral", "mixed"],
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
        }
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
            "conversationRootId": item.conversation_root_id
        },
        "domainId": item.domain_id,
        "extraction": {
            "entities": entities.get("entities", {}) if isinstance(entities, dict) else entities,
            "classifications": classifications,
            "candidateRelations": relations.get("relation_extraction", {}) if isinstance(relations, dict) else relations
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
