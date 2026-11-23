import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_entity_graph.py"
SPEC = importlib.util.spec_from_file_location("build_entity_graph", SCRIPT)
GRAPH = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(GRAPH)


class EntityGraphHelperTests(unittest.TestCase):
    def test_stable_id_is_type_aware_and_case_insensitive(self):
        first = GRAPH.stable_id("organization", "SGS Group")
        second = GRAPH.stable_id("organization", "  sgs   group ")
        other_type = GRAPH.stable_id("product_service", "SGS Group")
        self.assertEqual(first, second)
        self.assertNotEqual(first, other_type)

    def test_span_text_supports_strings_and_span_objects(self):
        text, metadata = GRAPH.span_text("SGS")
        self.assertEqual(text, "SGS")
        self.assertEqual(metadata, {})

        text, metadata = GRAPH.span_text({
            "text": "Bureau Veritas",
            "start": 10,
            "end": 24,
            "confidence": 0.94
        })
        self.assertEqual(text, "Bureau Veritas")
        self.assertEqual(metadata["start"], 10)
        self.assertEqual(metadata["end"], 24)
        self.assertAlmostEqual(metadata["confidence"], 0.94)

    def test_add_node_merges_evidence_for_same_canonical_surface(self):
        nodes = {}
        first = GRAPH.add_node(
            nodes, "organization", "SGS", "post-1",
            "https://x.com/a/status/1", "2026-01-01T00:00:00Z"
        )
        second = GRAPH.add_node(
            nodes, "organization", "sgs", "post-2",
            "https://x.com/a/status/2", "2026-02-01T00:00:00Z"
        )
        self.assertEqual(first, second)
        self.assertEqual(len(nodes), 1)
        self.assertEqual(nodes[first]["observations"], 2)
        self.assertEqual(nodes[first]["evidenceIds"], {"post-1", "post-2"})

    def test_add_edge_deduplicates_and_accumulates_evidence(self):
        edges = {}
        GRAPH.add_edge(edges, "partners_with", "org-a", "org-b", "post-1", None, 0.8)
        GRAPH.add_edge(edges, "partners_with", "org-a", "org-b", "post-2", None, 0.9)
        self.assertEqual(len(edges), 1)
        edge = next(iter(edges.values()))
        self.assertEqual(edge["evidenceIds"], {"post-1", "post-2"})
        self.assertEqual(edge["confidenceScores"], [0.8, 0.9])


if __name__ == "__main__":
    unittest.main()
