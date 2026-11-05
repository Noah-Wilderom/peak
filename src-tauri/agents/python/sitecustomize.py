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


def _peak_start():
    addr = os.environ.get("PEAK_AGENT_ADDR")
    token = os.environ.get("PEAK_AGENT_TOKEN")
    if not addr or not token:
        return None

    import gc
    import json
    import socket
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

    send({"type": "hello", "token": token, "pid": os.getpid(), "runtime": "python"})

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

    def handle(line):
        try:
            req = json.loads(line)
        except ValueError:
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
