"""Staging-workspace tests: a run's note writes must land in an isolated
workspace, reads must read through to the vault, and promotion must be additive.

Run:
    cd apps/agent && .venv/bin/python -m unittest tests.test_vault_staging -v

The regression this pins: a long research run wrote its notes straight into the
shared vault, so an off-topic run littered the real graph. Writes now stage.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent.knowledge import vault_store
from agent.knowledge.manager import KnowledgeManager


class TestVaultStaging(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="staging-test-"))
        self.vault = self.tmp / "vault"
        (self.vault / "03-Areas/concepts").mkdir(parents=True)
        (self.vault / "02-Projects").mkdir(parents=True)
        # a pre-existing note the run must still be able to read
        (self.vault / "03-Areas/concepts/robinhood-chain.md").write_text(
            "---\nconcept: robinhood-chain\ntype: chain\nlayer: base\ncreated: 2026-01-01\n"
            "updated: 2026-01-01\nstatus: active\n---\n\n## What\nRobinhood chain.\n",
            encoding="utf-8",
        )
        self.ws = self.tmp / "workspaces" / "run_test"
        self._env = {k: os.environ.get(k) for k in ("VAULT_ROOT", "AGENT_DATA_DIR")}
        os.environ["VAULT_ROOT"] = str(self.vault)
        from agent.knowledge import index as kix
        from agent.tools import vault_index

        kix.invalidate()
        vault_index.invalidate()

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        from agent.knowledge import index as kix
        from agent.tools import vault_index

        kix.invalidate()
        vault_index.invalidate()

    def test_write_is_staged_not_in_vault(self):
        with vault_store.staging(self.ws):
            vault_store.write("03-Areas/concepts/b20-x.md", "---\nconcept: b20-x\nstatus: active\n---\n\n## What\nX.\n")
            # visible while staged (read-through workspace)
            self.assertTrue((self.ws / "03-Areas/concepts/b20-x.md").exists())
        # the shared vault was never touched
        self.assertFalse((self.vault / "03-Areas/concepts/b20-x.md").exists())

    def test_read_falls_through_to_vault(self):
        with vault_store.staging(self.ws):
            # a note only in the vault is still readable from the workspace
            note, _h = vault_store.read("03-Areas/concepts/robinhood-chain.md")
            self.assertIn("Robinhood chain", note._raw)

    def test_staged_note_shadows_vault(self):
        with vault_store.staging(self.ws):
            vault_store.write("03-Areas/concepts/robinhood-chain.md",
                              "---\nconcept: robinhood-chain\nstatus: active\n---\n\n## What\nSTAGED EDIT\n")
            note, _h = vault_store.read("03-Areas/concepts/robinhood-chain.md")
            self.assertIn("STAGED EDIT", note._raw)
        # vault original is intact
        original = (self.vault / "03-Areas/concepts/robinhood-chain.md").read_text()
        self.assertNotIn("STAGED EDIT", original)

    def test_edit_of_existing_vault_note_does_not_conflict(self):
        """Copy-on-write: the first edit of a pre-existing vault note (with the
        hash read from the vault) must succeed, not raise ConcurrentModification."""
        _note, h = vault_store.read("03-Areas/concepts/robinhood-chain.md")
        with vault_store.staging(self.ws):
            vault_store.write("03-Areas/concepts/robinhood-chain.md",
                              "---\nconcept: robinhood-chain\nstatus: active\n---\n\n## What\nEDITED\n",
                              expect_hash=h)

    def test_index_sees_staged_node(self):
        from agent.knowledge import index as kix

        with vault_store.staging(self.ws):
            vault_store.write("03-Areas/concepts/b20-x.md",
                              "---\nconcept: b20-x\ntype: concept\nlayer: base\ncreated: 2026-01-01\n"
                              "updated: 2026-01-01\nstatus: active\n---\n\n## What\nX.\n")
            kix.invalidate()
            idx = kix.get()
            self.assertIn("b20-x", idx.nodes)
            self.assertIn("robinhood-chain", idx.nodes, "vault nodes remain visible")

    def test_manager_writes_stage_under_context(self):
        km = KnowledgeManager()
        with vault_store.staging(self.ws):
            km.create_unknown(question="What is the b20 precompile on robinhood chain?")
        # nothing landed in the vault
        staged = list((self.ws / "03-Areas/concepts").glob("*.md"))
        self.assertTrue(staged, "the unknown should be staged")
        vault_notes = [p.name for p in (self.vault / "03-Areas/concepts").glob("*.md")]
        self.assertEqual(vault_notes, ["robinhood-chain.md"], "vault must be untouched")


if __name__ == "__main__":
    unittest.main(verbosity=2)
