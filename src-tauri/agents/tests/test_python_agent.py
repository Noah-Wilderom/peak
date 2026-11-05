"""Integration tests for the Python agent (sitecustomize.py)."""

import json
import os
import socket
import subprocess
import sys
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT_DIR = os.path.join(HERE, "..", "python")
sys.path.insert(0, AGENT_DIR)
import sitecustomize as agent  # noqa: E402

APP = """
import time
class LeakyThing:
    def __init__(self, i): self.i = i; self.data = [i] * 8
keep = []
end = time.time() + 60
while time.time() < end:
    keep.extend(LeakyThing(i) for i in range(500))
    time.sleep(0.02)
"""


class FakeHub:
    def __init__(self):
        self.server = socket.socket()
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(1)
        self.addr = "127.0.0.1:%d" % self.server.getsockname()[1]
        self.messages = []
        self.conn = None
        self.cv = threading.Condition()
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        conn, _ = self.server.accept()
        self.conn = conn
        buf = b""
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                with self.cv:
                    self.messages.append(json.loads(line))
                    self.cv.notify_all()

    def wait_for(self, pred, timeout=20):
        deadline = time.time() + timeout
        with self.cv:
            while True:
                for m in self.messages:
                    if pred(m):
                        return m
                left = deadline - time.time()
                if left <= 0:
                    raise AssertionError("timed out; got %r" % [m.get("type") for m in self.messages])
                self.cv.wait(left)

    def request(self, cmd, req_id):
        self.wait_for(lambda m: m["type"] == "hello")
        self.conn.sendall((json.dumps({"cmd": cmd, "reqId": req_id}) + "\n").encode())
        return self.wait_for(lambda m: m["type"] == "reply" and m["reqId"] == req_id, timeout=60)


def run(env, code=APP):
    full = dict(os.environ, PYTHONPATH=AGENT_DIR, **env)
    return subprocess.Popen([sys.executable, "-c", code], env=full, stdout=subprocess.PIPE)


class PythonAgentTest(unittest.TestCase):
    def test_streams_gc_and_answers_requests(self):
        hub = FakeHub()
        child = run({"PEAK_AGENT_ADDR": hub.addr, "PEAK_AGENT_TOKEN": "tok"})
        try:
            hello = hub.wait_for(lambda m: m["type"] == "hello")
            self.assertEqual(hello, {"type": "hello", "token": "tok", "pid": child.pid, "runtime": "python"})
            gc_ev = hub.wait_for(lambda m: m["type"] == "gc")
            self.assertIn(gc_ev["kind"], ("minor", "major"))
            self.assertGreaterEqual(gc_ev["pauseMs"], 0)

            first = hub.request("snapshot", 1)
            self.assertTrue(first["ok"], first.get("error"))
            names = [e["name"] for e in first["data"]["entries"]]
            self.assertIn("LeakyThing", names)
            self.assertIsNone(first["data"]["sites"], "tracemalloc starts with the first snapshot")

            time.sleep(0.3)
            second = hub.request("snapshot", 2)
            self.assertTrue(second["ok"])
            sites = second["data"]["sites"]
            self.assertEqual(sites["name"], "(root)")
            self.assertTrue(sites["children"])
            self.assertGreater(second["data"]["heapUsed"], 0)

            self.assertTrue(hub.request("gc", 3)["ok"])
            bad = hub.request("nope", 4)
            self.assertFalse(bad["ok"])
            self.assertIn("unknown command", bad["error"])
        finally:
            child.kill()
            child.wait()

    def test_inert_without_environment_and_survives_missing_hub(self):
        out = run({"PEAK_AGENT_ADDR": ""}, "print('ok')").communicate(timeout=20)[0]
        self.assertEqual(out.strip(), b"ok")
        child = run({"PEAK_AGENT_ADDR": "127.0.0.1:1", "PEAK_AGENT_TOKEN": "t"}, "print('ok')")
        self.assertEqual(child.communicate(timeout=20)[0].strip(), b"ok")
        self.assertEqual(child.returncode, 0)
        bad = run({"PEAK_AGENT_ADDR": "nonsense", "PEAK_AGENT_TOKEN": "t"}, "print('ok')")
        self.assertEqual(bad.communicate(timeout=20)[0].strip(), b"ok")

    def test_summaries(self):
        class Foo:
            pass

        rows = agent.summarize_objects([Foo(), Foo(), [1, 2], {"a": 1}])
        by = {r["name"]: r for r in rows}
        self.assertEqual(by["test_python_agent." + Foo.__qualname__]["count"], 2)
        self.assertEqual(by["list"]["count"], 1)
        self.assertEqual(by["dict"]["retained"], by["dict"]["shallow"])

        class Weird:
            def __sizeof__(self):
                raise RuntimeError("no")

        self.assertEqual(agent.summarize_objects([Weird()])[0]["shallow"], 0)

    def test_sites_tree(self):
        import tracemalloc

        tracemalloc.start(5)
        data = [bytearray(1000) for _ in range(50)]  # noqa: F841
        snap = tracemalloc.take_snapshot()
        tracemalloc.stop()
        root = agent.sites_from_tracemalloc(snap, limit=20)
        self.assertEqual(root["name"], "(root)")

        def total(n):
            return n["self"] + sum(total(c) for c in n["children"])

        self.assertGreater(total(root), 50_000)

    def test_chains_existing_sitecustomize(self):
        import tempfile

        with tempfile.TemporaryDirectory() as other:
            with open(os.path.join(other, "sitecustomize.py"), "w") as f:
                f.write("import builtins\nbuiltins.PEAK_CHAINED = True\n")
            env = dict(os.environ, PYTHONPATH=AGENT_DIR + os.pathsep + other, PEAK_AGENT_ADDR="")
            out = subprocess.run(
                [sys.executable, "-c", "import builtins; print(getattr(builtins, 'PEAK_CHAINED', False))"],
                env=env, capture_output=True, timeout=20,
            )
            self.assertEqual(out.stdout.strip(), b"True")


if __name__ == "__main__":
    unittest.main()
