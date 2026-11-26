import json
import unittest
from pathlib import Path


SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schemas" / "intelligence-brief.schema.json"


class IntelligenceBriefSchemaTests(unittest.TestCase):
    def load_day_constraints(self):
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        return schema["properties"]["window"]["properties"]["days"]

    def test_accepts_declared_184_day_tic_window(self):
        constraints = self.load_day_constraints()
        self.assertEqual(constraints.get("type"), "integer")
        self.assertEqual(constraints.get("minimum"), 1)
        self.assertEqual(constraints.get("maximum"), 3650)
        self.assertNotIn("const", constraints)
        self.assertGreaterEqual(184, constraints["minimum"])
        self.assertLessEqual(184, constraints["maximum"])

    def test_rejects_invalid_zero_day_window(self):
        constraints = self.load_day_constraints()
        self.assertLess(0, constraints["minimum"])


if __name__ == "__main__":
    unittest.main()
