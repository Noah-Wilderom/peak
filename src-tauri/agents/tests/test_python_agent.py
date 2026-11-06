"""Integration tests for the Python agent (sitecustomize.py)."""

import importlib.util
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


def load_agent():
    """Load the agent by path. `import sitecustomize` isn't reliable: Python imports that
    name at startup, so on Ubuntu's Python it returns the distribution's own hook."""
    spec = importlib.util.spec_from_file_location("peak_sitecustomize", os.path.join(AGENT_DIR, "sitecustomize.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


agent = load_agent()

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

    def request(self, cmd, req_id, **params):
        self.wait_for(lambda m: m["type"] == "hello")
        self.conn.sendall((json.dumps({"cmd": cmd, "reqId": req_id, **params}) + "\n").encode())
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

    def test_reports_lag_and_records_cpu_profiles_alongside_heap_data(self):
        # Holds the GIL through long pure-Python stretches, in a named function.
        app = """
import sys, time
sys.setswitchinterval(0.05)
def burn_cycles():
    end = time.perf_counter() + 0.2
    x = 0
    while time.perf_counter() < end:
        x += 1
    return x
end = time.time() + 60
while time.time() < end:
    burn_cycles()
    time.sleep(0.02)
"""
        hub = FakeHub()
        child = run({"PEAK_AGENT_ADDR": hub.addr, "PEAK_AGENT_TOKEN": "tok"}, app)
        try:
            lag = hub.wait_for(lambda m: m["type"] == "lag" and m["loopLag"] > 5)
            self.assertLess(lag["loopLag"], 5000)

            reply = hub.request("cpuprofile", 1, ms=1000)
            self.assertTrue(reply["ok"], reply.get("error"))
            data = reply["data"]
            self.assertEqual(data["sampling"], "stack")
            self.assertGreaterEqual(data["durationMs"], 950)
            self.assertLess(data["durationMs"], 5000)

            def find(node, name):
                if node["name"] == name:
                    return node
                for c in node["children"]:
                    hit = find(c, name)
                    if hit:
                        return hit
                return None

            def total(n):
                return n["self"] + sum(total(c) for c in n["children"])

            root = data["root"]
            self.assertEqual(root["name"], "(root)")
            burn = find(root, "burn_cycles")
            self.assertIsNotNone(burn, "the hot function appears in the call tree")
            self.assertGreater(total(burn), 300)
            self.assertRegex(burn["file"], r"<string>:\d+$")
            self.assertIsNone(find(root, "sample_cpu"), "the sampler does not profile itself")
            self.assertLess(abs(total(root) - data["durationMs"]), 0.2 * data["durationMs"])

            # A snapshot answers while a profile records, and overlaps are refused.
            hub.conn.sendall((json.dumps({"cmd": "cpuprofile", "reqId": 2, "ms": 1500}) + "\n").encode())
            time.sleep(0.2)
            snap = hub.request("snapshot", 3)
            self.assertTrue(snap["ok"], snap.get("error"))
            overlap = hub.request("cpuprofile", 4, ms=100)
            self.assertFalse(overlap["ok"])
            self.assertIn("already being recorded", overlap["error"])
            first = hub.wait_for(lambda m: m["type"] == "reply" and m["reqId"] == 2)
            self.assertTrue(first["ok"])
        finally:
            child.kill()
            child.wait()

    def test_cpu_sampler_charges_elapsed_time_and_handles_a_missing_thread(self):
        clock = iter([0.0, 0.1, 0.2, 0.3])

        class Code:
            co_name = "work"
            co_filename = "/app/job.py"
            co_firstlineno = 7

        class Frame:
            f_code = Code
            f_lineno = 12
            f_back = None

        seen = iter([{1: Frame}, {}, {1: Frame}])
        out = agent.sample_cpu(
            250, 1, current_frames=lambda: next(seen), clock=lambda: next(clock), sleep=lambda _: None
        )
        self.assertAlmostEqual(out["durationMs"], 300)
        self.assertEqual(out["sampling"], "stack", "time here includes blocking, and says so")
        work = out["root"]["children"][0]
        self.assertEqual((work["name"], work["file"]), ("work", "job.py:7"))
        # Two of three intervals saw the thread; the gap is not attributed to it.
        self.assertAlmostEqual(work["self"], 200)

    def test_percentile(self):
        self.assertIsNone(agent.percentile([], 99))
        self.assertEqual(agent.percentile([3], 99), 3)
        self.assertEqual(agent.percentile(list(range(100)), 99), 99)
        self.assertEqual(agent.percentile(list(range(100)), 50), 50)

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
