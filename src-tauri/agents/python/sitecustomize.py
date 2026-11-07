"""peak runtime agent for Python — loaded through PYTHONPATH as sitecustomize.

Streams GC events to the peak app and answers heap snapshot / GC requests.
It runs on daemon threads and must never raise into the host program.
"""

import os


def _peak_chain_user_sitecustomize():
    """Keep any sitecustomize.py the user already had working."""
    import sys

    here = os.path.dirname(os.path.abspath(__file__))
    for entry in sys.path:
        base = os.path.abspath(entry or ".")
        if base == here:
            continue
        candidate = os.path.join(base, "sitecustomize.py")
        if os.path.isfile(candidate):
            with open(candidate) as f:
                code = compile(f.read(), candidate, "exec")
            exec(code, {"__name__": "sitecustomize", "__file__": candidate})
            return candidate
    return None


def _type_name(t):
    mod = getattr(t, "__module__", "builtins")
    name = getattr(t, "__qualname__", t.__name__)
    return name if mod in ("builtins", "__main__") else f"{mod}.{name}"


def summarize_objects(objects):
    import sys

    groups = {}
    for o in objects:
        name = _type_name(type(o))
        try:
            size = sys.getsizeof(o, 0)
        except Exception:
            size = 0
        g = groups.get(name)
        if g is None:
            groups[name] = {"name": name, "count": 1, "shallow": size}
        else:
            g["count"] += 1
            g["shallow"] += size
    out = sorted(groups.values(), key=lambda g: g["shallow"], reverse=True)[:60]
    for g in out:
        g["retained"] = g["shallow"]
    return out


def sites_from_tracemalloc(snapshot, limit=300):
    """Build an allocation-site tree (root → oldest frame → newest frame)."""
    root = {"name": "(root)", "self": 0, "children": []}
    for stat in snapshot.statistics("traceback")[:limit]:
        node = root
        for frame in stat.traceback:  # oldest first
            key = f"{os.path.basename(frame.filename)}:{frame.lineno}"
            child = next((c for c in node["children"] if c["file"] == key), None)
            if child is None:
                child = {"name": os.path.basename(frame.filename), "file": key, "self": 0, "children": []}
                node["children"].append(child)
            node = child
        node["self"] += stat.size
    return root


def percentile(values, p):
    """Nearest-rank percentile; None for no data (unknown, not zero)."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(p / 100 * len(ordered)))]


def add_stack(root, frames, ms):
    """Add one sampled stack (oldest frame first) to a call tree, in sampled ms."""
    node = root
    for name, file in frames:
        child = next((c for c in node["children"] if c["name"] == name and c.get("file") == file), None)
        if child is None:
            child = {"name": name, "file": file, "self": 0, "children": []}
            node["children"].append(child)
        node = child
    node["self"] += ms


def stack_of(frame, skip_files=()):
    """Frames of a Python stack, oldest first, skipping peak's own threads' files."""
    out = []
    while frame is not None:
        code = frame.f_code
        if code.co_filename not in skip_files:
            # The function's own line: one function stays one frame as it executes.
            out.append((code.co_name, f"{os.path.basename(code.co_filename)}:{code.co_firstlineno}"))
        frame = frame.f_back
    out.reverse()
    return out


def sample_cpu(duration_ms, target_thread, interval_ms=5, current_frames=None, clock=None, sleep=None):
    """Sample one thread's Python stack for `duration_ms`.

    Each observation is charged the time since the previous one, so the tree sums
    to the measured duration even when sampling falls behind under load. This
    samples the stack whether or not the thread is on-CPU: blocking calls appear
    under their Python frame, as in other wall-clock Python samplers.
    """
    import sys
    import time

    current_frames = current_frames or sys._current_frames
    clock = clock or time.perf_counter
    sleep = sleep or time.sleep
    root = {"name": "(root)", "self": 0, "children": []}
    began = clock()
    last = began
    deadline = began + duration_ms / 1000
    while True:
        sleep(interval_ms / 1000)
        now = clock()
        frame = current_frames().get(target_thread)
        if frame is not None:
            add_stack(root, stack_of(frame, (__file__,)), (now - last) * 1000)
        last = now
        if now >= deadline:
            return {"durationMs": (now - began) * 1000, "sampling": "stack", "root": root}


def _peak_start():
    addr = os.environ.get("PEAK_AGENT_ADDR")
    token = os.environ.get("PEAK_AGENT_TOKEN")
    if not addr or not token:
        return None

    import gc
    import json
    import socket
    import sys
    import threading
    import time
    import tracemalloc

    host, _, port = addr.rpartition(":")
    try:
        sock = socket.create_connection((host, int(port)), timeout=2)
    except (OSError, ValueError):
        return None
    sock.settimeout(None)
    lock = threading.Lock()

    def send(msg):
        data = (json.dumps(msg) + "\n").encode()
        with lock:
            try:
                sock.sendall(data)
            except OSError:
                pass

    send(
        {
            "type": "hello",
            "token": token,
            "pid": os.getpid(),
            "runtime": "python",
            "agent": {
                "runtimeVersion": ".".join(str(n) for n in sys.version_info[:3]),
                "agentVersion": os.environ.get("PEAK_AGENT_VERSION", "unknown"),
                "capabilities": ["gc", "lag", "cpu", "snapshot", "forcegc"],
                "unavailable": {"heap": "CPython has no cheap total for its heap, so memory here is the process's."},
                "notes": {
                    "lag": "How late a 10 ms sleep woke up, p99: time waiting for the GIL and a CPU",
                    "cpu": "Samples the main thread's stack whether it's on-CPU or not, so blocking calls count.",
                    "freed": "Estimated at 64 bytes per object collected.",
                    "snapshot": "Live objects by type. Allocation stacks start with the first snapshot.",
                },
            },
        }
    )

    # GC callbacks run inside the collector, so only record; a thread flushes.
    queue = []
    started = [0.0]

    def on_gc(phase, info):
        if phase == "start":
            started[0] = time.perf_counter()
            return
        queue.append(
            {
                "type": "gc",
                "kind": "major" if info.get("generation") == 2 else "minor",
                "pauseMs": (time.perf_counter() - started[0]) * 1000,
                # CPython reports objects, not bytes; ~64B is a typical small object.
                "freed": info.get("collected", 0) * 64,
                "t": int(time.time() * 1000),
            }
        )

    gc.callbacks.append(on_gc)

    def flush():
        while True:
            time.sleep(0.5)
            while queue:
                send(queue.pop(0))

    def measure_lag():
        # Oversleep of a short sleep: how long this thread waited to get the GIL
        # (and a CPU) back. Reported as p99 per 500ms; nothing is sent without data.
        period = 0.01
        window = []
        flushed = time.perf_counter()
        while True:
            began = time.perf_counter()
            time.sleep(period)
            now = time.perf_counter()
            window.append(max(0.0, (now - began - period) * 1000))
            if now - flushed >= 0.5:
                send({"type": "lag", "loopLag": percentile(window, 99)})
                window = []
                flushed = now

    profile_lock = threading.Lock()
    main_thread = threading.main_thread().ident

    def cpuprofile(ms):
        if not profile_lock.acquire(blocking=False):
            raise ValueError("a CPU profile is already being recorded")
        try:
            return sample_cpu(max(1, int(ms or 1000)), main_thread)
        finally:
            profile_lock.release()

    def snapshot():
        gc.collect()
        entries = summarize_objects(gc.get_objects())
        if tracemalloc.is_tracing():
            snap = tracemalloc.take_snapshot()
            sites = sites_from_tracemalloc(snap)
            heap_used = tracemalloc.get_traced_memory()[0]
        else:
            # Allocation tracking is costly, so it starts with the first snapshot.
            tracemalloc.start(25)
            sites = None
            heap_used = sum(e["shallow"] for e in entries)
        return {"heapUsed": heap_used, "entries": entries, "sites": sites}

    def serve_profile(req):
        # Off the read thread, so snapshots and GC stay responsive while recording.
        try:
            data = cpuprofile(req.get("ms"))
            send({"type": "reply", "reqId": req.get("reqId"), "ok": True, "data": data})
        except Exception as e:  # never raise into the host
            send({"type": "reply", "reqId": req.get("reqId"), "ok": False, "error": str(e)})

    def handle(line):
        try:
            req = json.loads(line)
        except ValueError:
            return
        if req.get("cmd") == "cpuprofile":
            threading.Thread(target=serve_profile, args=(req,), name="peak-profile", daemon=True).start()
            return
        try:
            if req.get("cmd") == "snapshot":
                data = snapshot()
            elif req.get("cmd") == "gc":
                gc.collect()
                data = None
            else:
                raise ValueError(f"unknown command {req.get('cmd')}")
            send({"type": "reply", "reqId": req.get("reqId"), "ok": True, "data": data})
        except Exception as e:  # never raise into the host
            send({"type": "reply", "reqId": req.get("reqId"), "ok": False, "error": str(e)})

    def read():
        buf = b""
        while True:
            try:
                chunk = sock.recv(65536)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                handle(line.decode("utf-8", "replace"))

    threading.Thread(target=measure_lag, name="peak-lag", daemon=True).start()
    threading.Thread(target=flush, name="peak-flush", daemon=True).start()
    threading.Thread(target=read, name="peak-agent", daemon=True).start()
    return sock


try:
    _peak_start()
except Exception:
    pass

try:
    _peak_chain_user_sitecustomize()
except Exception:
    pass
