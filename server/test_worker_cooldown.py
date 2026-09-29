"""WorkerPool 节点冷却：失败记冷却、candidates 下沉、成功清除。"""
from __future__ import annotations

import time
import unittest
from types import SimpleNamespace

from worker_pool import WorkerPool


def _fake_worker(wid: str, models: list[str], model_types: dict | None = None):
    return SimpleNamespace(
        worker_id=wid,
        name=wid,
        models=list(models),
        model_types=model_types or {m: "image" for m in models},
        active_requests=0,
        user_id=None,
        owner_user_id=None,
        circle_id=None,
        circle_ids=None,
        agents=[],
        caps={},
        pending={},
        reward_multiplier=lambda: 1.0,
    )


class TestWorkerCooldown(unittest.TestCase):
    def setUp(self):
        self.pool = WorkerPool()
        self.a = _fake_worker("vw-1", ["gemini-2.5-flash-image"])
        self.b = _fake_worker("vw-2", ["gemini-2.5-flash-image"])
        self.pool._virtual = [self.a, self.b]

    def test_note_and_is_cooling(self):
        now = time.time()
        until = self.pool.note_cooldown(
            "vw-1", "gemini-2.5-flash-image", "HTTP_429 rate limit", now=now,
        )
        self.assertIsNotNone(until)
        self.assertTrue(self.pool.is_cooling("vw-1", "gemini-2.5-flash-image", now=now + 1))
        self.assertFalse(self.pool.is_cooling("vw-1", "gemini-2.5-flash-image", now=until + 1))

    def test_candidates_sink_cooled(self):
        now = time.time()
        self.pool.note_cooldown("vw-1", "gemini-2.5-flash-image", "Gateway timeout", now=now)
        # owner=None 的全局虚拟源对登录用户与访客都进 shared 候选
        cands = self.pool.candidates(
            "gemini-2.5-flash-image", model_type="image", owner_user_id=1,
        )
        self.assertEqual(len(cands), 2)
        # 冷却的 vw-1 应下沉到末尾
        self.assertEqual(cands[0].worker_id, "vw-2")
        self.assertEqual(cands[1].worker_id, "vw-1")

    def test_clear_cooldown(self):
        now = time.time()
        self.pool.note_cooldown("vw-1", "m", "timeout", now=now)
        self.pool.clear_cooldown("vw-1", "m")
        self.assertFalse(self.pool.is_cooling("vw-1", "m", now=now + 1))

    def test_auth_longer_than_transient(self):
        now = time.time()
        u_rate = self.pool.note_cooldown("w", "m", "HTTP_429", now=now)
        self.pool.clear_cooldown("w", "m")
        u_auth = self.pool.note_cooldown("w", "m", "HTTP_401 unauthorized", now=now)
        self.assertGreater(u_auth - now, u_rate - now)


if __name__ == "__main__":
    unittest.main()


class TestGuestVisibility(unittest.TestCase):
    """访客可用全局公开虚拟源；圈子 / 他人私有源对访客不可见。"""

    def setUp(self):
        self.pool = WorkerPool()
        self.pub = _fake_worker("vw-pub", ["glm-4.7"], {"glm-4.7": "chat"})
        self.circ = _fake_worker("vw-circ", ["kimi-k2"], {"kimi-k2": "chat"})
        self.circ.circle_id = 7
        self.priv = _fake_worker("vw-priv", ["gpt-5"], {"gpt-5": "chat"})
        self.priv.owner_user_id = 42
        self.pool._virtual = [self.pub, self.circ, self.priv]

    def test_guest_gets_public_virtual_candidates(self):
        self.assertIn("glm-4.7", self.pool.models_for_user(None, set()))
        cands = self.pool.candidates("glm-4.7", model_type="chat", owner_user_id=None)
        self.assertEqual([c.worker_id for c in cands], ["vw-pub"])

    def test_guest_cannot_use_circle_or_private(self):
        self.assertEqual(self.pool.candidates("kimi-k2", model_type="chat"), [])
        self.assertEqual(self.pool.candidates("gpt-5", model_type="chat"), [])

    def test_owner_private_listed_once(self):
        cands = self.pool.candidates("gpt-5", model_type="chat", owner_user_id=42)
        self.assertEqual([c.worker_id for c in cands], ["vw-priv"])

    def test_model_access(self):
        self.assertEqual(self.pool.model_access("glm-4.7"), "ok")
        self.assertEqual(self.pool.model_access("kimi-k2"), "circle")
        self.assertEqual(self.pool.model_access("kimi-k2", 1, {7}), "ok")
        self.assertEqual(self.pool.model_access("gpt-5"), "circle")
        self.assertEqual(self.pool.model_access("gpt-5", 42), "ok")
        self.assertEqual(self.pool.model_access("nope"), "offline")
