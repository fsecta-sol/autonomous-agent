"""Tests for the Knowledge Manager's slug/filename safety.

Run:
    cd apps/agent && .venv/bin/python -m unittest tests.test_knowledge_slug -v

A note's filename is `<slug>.md`. A slug is built from a title OR a whole
research question, and a question can run to hundreds of characters — so an
uncapped slug produced filenames `open()` rejected with "[Errno 36] File name
too long", silently dropping the note (the `unknown create failed` errors a
long-horizon run emitted by the hundreds). These tests pin the cap and the
no-collision guarantee.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent.knowledge.model import MAX_SLUG_LEN, slugify


class TestSlugify(unittest.TestCase):
    def test_short_titles_unchanged(self):
        # existing ids must not change shape — no truncation, same kebab form
        self.assertEqual(slugify("mev"), "mev")
        self.assertEqual(slugify("MEV Preconditions"), "mev-preconditions")
        self.assertEqual(slugify("v21proof-cooldown-proof"), "v21proof-cooldown-proof")

    def test_overlong_is_capped_and_filesystem_safe(self):
        q = "a question " * 60  # ~660 chars naive
        s = slugify(q)
        self.assertLessEqual(len(s), MAX_SLUG_LEN)
        # the actual filename must leave room under the 255-byte limit
        self.assertLess(len((s + ".md").encode("utf-8")), 255)
        # and it must be writable (the real failure was open())
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / f"{s}.md"
            p.write_text("x")
            self.assertTrue(p.exists())

    def test_overlong_inputs_do_not_collide(self):
        shared = "the same long shared prefix " * 10
        self.assertNotEqual(slugify(shared + "alpha branch"), slugify(shared + "beta branch"))


class TestCreateUnknownOverlong(unittest.IsolatedAsyncioTestCase):
    """The end-to-end path that failed: a long question becomes one gap note."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="slug-unknown-"))
        os.environ["VAULT_ROOT"] = str(self.tmp)
        os.environ["AGENT_DATA_DIR"] = str(self.tmp / "data")
        from agent.knowledge import index as kix
        from agent.tools import vault_index

        kix.invalidate()
        vault_index.invalidate()

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_long_questions_create_distinct_notes(self):
        from agent.knowledge.manager import KnowledgeManager

        km = KnowledgeManager()
        q1 = "i did not find and do not claim any vendor published list changelog status page or support article describing a removal policy"
        q2 = "i could not determine whether the removal was an explicit delisting action or automatic pruning of a drained pool"
        r1 = km.create_unknown(question=q1, id="")
        r2 = km.create_unknown(question=q2, id="")
        self.assertTrue(r1["ok"] and r2["ok"])
        self.assertNotEqual(r1["id"], r2["id"], "two distinct questions must not collide onto one note")
        files = list((self.tmp / "03-Areas/concepts").glob("*.md"))
        self.assertEqual(len(files), 2, "both gap notes must be written")


if __name__ == "__main__":
    unittest.main(verbosity=2)
