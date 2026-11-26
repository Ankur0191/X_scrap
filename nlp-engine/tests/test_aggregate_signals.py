import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "aggregate_signals.py"
SPEC = importlib.util.spec_from_file_location("aggregate_signals", SCRIPT)
AGGREGATE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(AGGREGATE)


class ComplaintEvidencePolicyTests(unittest.TestCase):
    def test_external_author_is_case_insensitive_and_excludes_unknown(self):
        self.assertTrue(AGGREGATE.is_external_author("customer_01", "SGS_SA"))
        self.assertFalse(AGGREGATE.is_external_author("sgs_sa", "SGS_SA"))
        self.assertFalse(AGGREGATE.is_external_author("unknown", "SGS_SA"))
        self.assertFalse(AGGREGATE.is_external_author("", "SGS_SA"))

    def test_thread_context_accepts_reply_and_parent_relationships(self):
        self.assertTrue(AGGREGATE.has_thread_context({"isThreadReply": True}, {}))
        self.assertTrue(AGGREGATE.has_thread_context({"conversationRootId": "123"}, {}))
        self.assertTrue(AGGREGATE.has_thread_context({}, {"parentPostId": "123"}))
        self.assertFalse(AGGREGATE.has_thread_context({"isThreadReply": False}, {}))

    def test_candidate_complaint_requires_external_thread_and_negative_or_mixed(self):
        self.assertTrue(AGGREGATE.is_candidate_complaint(
            "customer_01", "sgs_sa", True, "negative", ["delayed_test_or_inspection"]
        ))
        self.assertTrue(AGGREGATE.is_candidate_complaint(
            "customer_02", "sgs_sa", True, "mixed", ["poor_customer_support"]
        ))

    def test_candidate_complaint_rejects_official_positive_nonthread_and_unclassified(self):
        self.assertFalse(AGGREGATE.is_candidate_complaint(
            "sgs_sa", "sgs_sa", True, "negative", ["delayed_test_or_inspection"]
        ))
        self.assertFalse(AGGREGATE.is_candidate_complaint(
            "customer_01", "sgs_sa", True, "positive", ["delayed_test_or_inspection"]
        ))
        self.assertFalse(AGGREGATE.is_candidate_complaint(
            "customer_01", "sgs_sa", False, "negative", ["delayed_test_or_inspection"]
        ))
        self.assertFalse(AGGREGATE.is_candidate_complaint(
            "customer_01", "sgs_sa", True, "negative", ["other_or_unclassified"]
        ))


if __name__ == "__main__":
    unittest.main()
