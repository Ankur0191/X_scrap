import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator


SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schemas" / "intelligence-brief.schema.json"


class IntelligenceBriefSchemaTests(unittest.TestCase):
    def test_accepts_declared_184_day_tic_window(self):
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        brief = {
            "schemaVersion": "1.0.0",
            "domainId": "tic",
            "window": {
                "days": 184,
                "startInclusive": "2026-05-23T10:56:54.981Z",
                "endInclusive": "2026-11-23T10:56:54.981Z"
            },
            "coverage": {
                "posts": 250,
                "competitorReplies": 0,
                "publicThreadReplies": 11,
                "coverageStatus": "partial",
                "limitations": ["Visible end does not prove platform-wide reply completeness."]
            },
            "executiveSummary": "Test brief",
            "signals": [],
            "gaps": [],
            "opportunities": [],
            "actionables": [],
            "evidence": []
        }
        errors = list(Draft202012Validator(schema).iter_errors(brief))
        self.assertEqual(errors, [])

    def test_rejects_invalid_zero_day_window(self):
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        brief = {
            "schemaVersion": "1.0.0",
            "domainId": "tic",
            "window": {
                "days": 0,
                "startInclusive": "2026-05-23T10:56:54.981Z",
                "endInclusive": "2026-11-23T10:56:54.981Z"
            },
            "coverage": {
                "posts": 0,
                "competitorReplies": 0,
                "publicThreadReplies": 0,
                "coverageStatus": "not_started"
            },
            "executiveSummary": "",
            "signals": [],
            "gaps": [],
            "opportunities": [],
            "actionables": [],
            "evidence": []
        }
        errors = list(Draft202012Validator(schema).iter_errors(brief))
        self.assertTrue(errors)


if __name__ == "__main__":
    unittest.main()
