/**
 * Mocked process monitor — used when the UI runs outside Tauri (plain
 * `vite dev`, tests, screenshots). Simulates captured processes and streams a
 * sample for each running one every TICK_MS.
 */

import { AlertEngine, applyAlerts } from "@/lib/alerts"
import { formatBytes } from "@/lib/format"
import type { MonitorApi } from "@/lib/monitor-api"
import {
  MAX_SAMPLES,
  SYSTEM_MEMORY,
  TICK_MS,
  DEFAULT_SETTINGS,
  NEW_TARGET,
  frameTotal,
  type AllocFrame,
  type Attachable,
  type CpuProfile,
  type GcEvent,
  type HeapEntry,
  type HeapSnapshot,
  type LaunchSpec,
  type MonitorEvent,
  type Proc,
  type RunSummary,
  type Runtime,
  type Sample,
  type Settings,
  type State,
  type StorageInfo,
  type SystemSample,
  type TargetSpec,
  type TargetState,
  type Status,
  type AgentInfo,
} from "@/lib/types"

export * from "@/lib/types"

const MAX_LOGS = 400
const MAX_GC = 3000
const MB = 1024 * 1024

type Profile = "leak" | "sawtooth" | "spiky" | "steady" | "ramp"

interface SimState {
  profile: Profile
  tick: number
  base: number
  level: number
  /** MB leaked per tick for the "leak" profile. */
  growth: number
  code: number
  rand: () => number
  /** Ticks until the process exits on its own (scripts, builds, tests). */
  lifespan?: number
  /** Memory ceiling that triggers an OOM kill. */
  oomAt?: number
}

export interface MockProc extends Proc {
  sim: SimState
}

// ─── deterministic randomness ────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// ─── log templates ───────────────────────────────────────────────────────────

const LOGS: Record<Profile, { out: string[]; err: string[] }> = {
  leak: {
    out: [
      "GET /api/users 200 in 14ms",
      "GET /api/session 200 in 3ms",
      "POST /api/events 201 in 22ms",
      "GET /dashboard 200 in 41ms",
      "ws: client connected (total {n})",
      "cache: stored entry #{n}",
    ],
    err: ["(node) MaxListenersExceededWarning: 11 listeners added to [EventEmitter]"],
  },
  sawtooth: {
    out: [
      "[gc] scavenge {m} MB -> {k} MB",
      "processed batch {n} (512 items)",
      "queue depth {k}",
      "flushed {n} records to disk",
    ],
    err: [],
  },
  spiky: {
    out: [
      "epoch {e} step {n} loss={l}",
      "loading shard {k}/64",
      "dataloader: prefetching batch {n}",
      "checkpoint saved to ./ckpt/step_{n}.pt",
    ],
    err: ["UserWarning: TypedStorage is deprecated"],
  },
  steady: {
    out: [
      "[watch] no changes",
      "[watch] change detected: src/lib.rs",
      "Compiling core v0.4.1",
      "Finished `dev` profile in 1.{k}s",
    ],
    err: [],
  },
  ramp: {
    out: [
      "transforming modules ({n} done)",
      "bundling chunk {k}",
      "✓ {n} modules transformed",
      "rendering chunks…",
      "computing gzip size…",
    ],
    err: ["(!) Some chunks are larger than 500 kB after minification"],
  },
}

function fillTemplate(tpl: string, p: MockProc) {
  const r = p.sim.rand
  return tpl
    .replace("{n}", String(p.sim.tick * 3 + Math.floor(r() * 9)))
    .replace("{k}", String(Math.floor(r() * 64)))
    .replace("{m}", String(Math.round(p.samples.at(-1)!.heap / MB)))
    .replace("{e}", String(1 + Math.floor(p.sim.tick / 200)))
    .replace("{l}", (2.4 * Math.exp(-p.sim.tick / 900) + r() * 0.08).toFixed(4))
}

// ─── heap profiles ───────────────────────────────────────────────────────────

/** [name, avg object size, share of baseline heap] */
type TypeSpec = [string, number, number]

const HEAP_TYPES: Record<"js" | "python" | "rust", TypeSpec[]> = {
  js: [
    ["(string)", 64, 0.2],
    ["Object", 96, 0.16],
    ["(compiled code)", 512, 0.12],
    ["Array", 128, 0.1],
    ["(closure)", 72, 0.08],
    ["Buffer", 4096, 0.06],
    ["Map", 256, 0.05],
    ["Promise", 80, 0.03],
    ["EventEmitter", 320, 0.02],
    ["Socket", 2048, 0.02],
  ],
  python: [
    ["dict", 232, 0.2],
    ["str", 72, 0.18],
    ["list", 120, 0.1],
    ["tuple", 64, 0.08],
    ["bytes", 2048, 0.06],
    ["function", 136, 0.05],
    ["int", 28, 0.05],
    ["type", 1056, 0.03],
  ],
  rust: [
    ["Vec<u8>", 512, 0.26],
    ["String", 48, 0.18],
    ["HashMap<Symbol, DefId>", 1024, 0.14],
    ["Arc<SourceFile>", 4096, 0.1],
    ["rustc_ast::Expr", 96, 0.1],
    ["Box<Ty>", 64, 0.08],
  ],
}

/** The type that grows with `sim.level` for each profile — the "suspect". */
const GROWING: Record<Profile, Partial<Record<"js" | "python" | "rust", [string, number]>>> = {
  leak: { js: ["CacheEntry", 4096], python: ["pandas.DataFrame", 8 * MB], rust: ["Vec<Event>", 2048] },
  sawtooth: { js: ["Job", 1024], python: ["Job", 1024] },
  spiky: { python: ["torch.Tensor", 4 * MB], js: ["Float32Array", 256 * 1024] },
  steady: { rust: ["rustc_middle::ty::TyS", 128] },
  ramp: { js: ["ModuleNode", 1536], python: ["ast.Module", 2048], rust: ["rustc_ast::Item", 512] },
}

function heapFamily(r: Runtime): "js" | "python" | "rust" {
  if (r === "python") return "python"
  if (r === "rust") return "rust"
  return "js"
}

/** [name, file, weight, growsWithLevel, children] */
type SiteSpec = [string, string, number, boolean, SiteSpec[]]

const SITES: Record<Profile, SiteSpec> = {
  leak: ["(root)", "", 0, false, [
    ["main", "server.ts:12", 0.02, false, [
      ["handleRequest", "routes/api.ts:42", 0.04, false, [
        ["SessionCache.set", "lib/cache.ts:18", 0.06, true, []],
        ["JSON.parse", "(native)", 0.12, false, []],
        ["renderTemplate", "views/render.ts:77", 0.1, false, [
          ["String.concat", "(native)", 0.08, false, []],
        ]],
      ]],
      ["WebSocketServer.onConnection", "ws.ts:31", 0.03, false, [
        ["Buffer.alloc", "(native)", 0.07, false, []],
        ["EventEmitter.on", "node:events", 0.02, true, []],
      ]],
    ]],
    ["(module loading)", "node:internal/modules", 0.18, false, [
      ["compileFunction", "(native)", 0.14, false, []],
    ]],
    ["(runtime)", "", 0.14, false, []],
  ]],
  sawtooth: ["(root)", "", 0, false, [
    ["Worker.run", "worker.js:8", 0.03, false, [
      ["Queue.pull", "lib/queue.js:54", 0.08, false, [
        ["JSON.parse", "(native)", 0.18, true, []],
      ]],
      ["processJob", "jobs/email.js:21", 0.05, false, [
        ["renderEmail", "jobs/templates.js:90", 0.16, true, []],
        ["smtp.send", "lib/smtp.js:12", 0.1, false, [
          ["Buffer.from", "(native)", 0.08, false, []],
        ]],
      ]],
    ]],
    ["(module loading)", "node:internal/modules", 0.18, false, []],
    ["(runtime)", "", 0.14, false, []],
  ]],
  spiky: ["(root)", "", 0, false, [
    ["train", "train.py:88", 0.02, false, [
      ["DataLoader.__next__", "torch/utils/data/dataloader.py:630", 0.04, false, [
        ["collate", "torch/utils/data/_utils/collate.py:141", 0.08, true, []],
        ["Image.open", "PIL/Image.py:3227", 0.06, false, []],
      ]],
      ["model.forward", "model.py:42", 0.03, false, [
        ["conv2d", "torch/nn/functional.py", 0.1, true, []],
        ["attention", "model.py:71", 0.12, true, []],
      ]],
      ["optimizer.step", "torch/optim/adamw.py:184", 0.1, false, []],
    ]],
    ["import torch", "<frozen importlib>", 0.25, false, []],
    ["(interpreter)", "", 0.08, false, []],
  ]],
  steady: ["(root)", "", 0, false, [
    ["cargo::ops::compile", "cargo/src/ops/cargo_compile.rs:311", 0.04, false, [
      ["rustc_driver::run", "rustc_driver/src/lib.rs:244", 0.05, false, [
        ["rustc_parse::parse_crate", "rustc_parse/src/lib.rs:90", 0.16, false, []],
        ["rustc_typeck::check_crate", "rustc_hir_analysis/src/lib.rs:180", 0.24, true, []],
        ["rustc_codegen_llvm", "rustc_codegen_llvm/src/base.rs:96", 0.18, false, []],
      ]],
    ]],
    ["notify::Watcher", "notify/src/inotify.rs:422", 0.06, false, []],
    ["(allocator)", "", 0.1, false, []],
  ]],
  ramp: ["(root)", "", 0, false, [
    ["build", "vite/dist/node/build.js:440", 0.02, false, [
      ["rolldown.bundle", "rolldown/binding", 0.04, false, [
        ["parseModule", "rolldown/parser", 0.2, true, []],
        ["transform", "plugin-react/index.js:210", 0.18, true, []],
        ["generateChunks", "rolldown/chunk.rs", 0.12, false, []],
      ]],
      ["minify", "oxc/minifier", 0.14, false, []],
    ]],
    ["(module loading)", "node:internal/modules", 0.14, false, []],
    ["(runtime)", "", 0.06, false, []],
  ]],
}

function makeSnapshot(p: MockProc, t: number): HeapSnapshot {
  const r = p.sim.rand
  const last = p.samples.at(-1)!
  const family = heapFamily(p.runtime)
  const types = HEAP_TYPES[family]
  const grow = GROWING[p.sim.profile][family]
  // Share of heap held by the growing type rises with the simulated level.
  const growShare = grow ? clamp(0.04 + (p.sim.level / (p.sim.level + 200 * MB)) * 0.7, 0, 0.75) : 0
  const rest = 1 - growShare

  const entries: HeapEntry[] = types.map(([name, size, share]) => {
    const shallow = last.heap * share * rest * (0.85 + r() * 0.3)
    return {
      name,
      count: Math.max(1, Math.round(shallow / size)),
      shallow,
      retained: shallow * (1.05 + r() * (name.match(/Map|dict|Object|Array|list|Vec|HashMap/) ? 1.6 : 0.3)),
    }
  })
  if (grow) {
    const shallow = last.heap * growShare
    entries.push({ name: grow[0], count: Math.max(1, Math.round(shallow / grow[1])), shallow, retained: shallow * 1.4 })
  }
  entries.sort((a, b) => b.retained - a.retained)

  const levelBoost = 1 + (p.sim.level / (p.sim.level + 150 * MB)) * 4
  const build = ([name, file, w, grows, kids]: SiteSpec): AllocFrame => ({
    name,
    file: file || undefined,
    self: last.heap * w * (grows ? levelBoost : 1) * (0.85 + r() * 0.3),
    children: kids.map(build),
  })
  const sites = build(SITES[p.sim.profile])
  // Normalize so the tree sums to the live heap.
  const total = frameTotal(sites)
  const scale = last.heap / total
  const rescale = (f: AllocFrame): AllocFrame => ({ ...f, self: f.self * scale, children: f.children.map(rescale) })

  return {
    id: `s_${t.toString(36)}_${Math.floor(r() * 1e6).toString(36)}`,
    t,
    heapUsed: last.heap,
    entries,
    sites: rescale(sites),
  }
}


// ─── simulation ──────────────────────────────────────────────────────────────

function nextSample(p: MockProc, t: number): Sample {
  const s = p.sim
  const r = s.rand
  const noise = (amp: number) => (r() - 0.5) * 2 * amp
  const prev = p.samples.at(-1)
  s.tick++

  let rss = s.base
  let cpu = 5
  let read = 0
  let write = 0
  let external = 0
  let churn = 0.04 // fraction of heap allocated per second

  switch (s.profile) {
    case "leak": {
      // Slow, unbounded growth with request-driven noise.
      s.level += s.growth * MB + Math.max(0, noise(0.35 * MB))
      rss = s.base + s.level + noise(4 * MB)
      cpu = 6 + Math.abs(noise(9)) + (r() > 0.92 ? 30 * r() : 0)
      read = 40_000 + r() * 120_000
      write = 10_000 + r() * 30_000
      churn = 0.08
      break
    }
    case "sawtooth": {
      // Allocations climb until the GC collects them.
      const before = s.level
      s.level += (1.4 + r() * 1.2) * MB
      if (s.level > 180 * MB) {
        s.level = 8 * MB + r() * 10 * MB
        recordGc(p, t, "major", 18 + r() * 42, before - s.level)
      }
      rss = s.base + s.level + noise(2 * MB)
      cpu = 28 + noise(14) + (s.level < 20 * MB ? 40 : 0)
      read = 200_000 + r() * 800_000
      write = 600_000 + r() * 1_400_000
      churn = 0.3
      break
    }
    case "spiky": {
      // Periodic batches load large tensors, then release them.
      const phase = s.tick % 46
      const target = phase < 12 ? 900 * MB * Math.sin((phase / 12) * Math.PI) : 0
      s.level += (target - s.level) * 0.35
      rss = s.base + s.level + noise(12 * MB)
      external = s.level * 0.7
      cpu = phase < 12 ? 340 + noise(50) : 90 + noise(30)
      read = phase < 3 ? 40_000_000 + r() * 30_000_000 : 300_000 + r() * 400_000
      write = phase === 20 ? 120_000_000 : r() * 50_000
      if (phase === 12) recordGc(p, t, "major", 30 + r() * 60, 400 * MB * r())
      churn = phase < 12 ? 0.5 : 0.06
      break
    }
    case "steady": {
      const building = s.tick % 80 < 6
      rss = s.base + noise(1.5 * MB) + (building ? 60 * MB : 0)
      cpu = building ? 260 + noise(80) : 0.6 + Math.abs(noise(1.2))
      read = building ? 8_000_000 * r() : 2_000 * r()
      write = building ? 14_000_000 * r() : 0
      churn = building ? 0.6 : 0.002
      break
    }
    case "ramp": {
      // Build-style: warm up, plateau while bundling, taper to exit.
      const life = s.lifespan! // ramp processes always have one
      const x = clamp(s.tick / life, 0, 1)
      const shape = Math.sin(Math.PI * Math.pow(x, 0.7))
      s.level = 1.1 * 1024 * MB * shape
      rss = s.base + s.level + noise(16 * MB)
      cpu = 120 + 380 * shape + noise(40)
      read = 6_000_000 * shape + r() * 2_000_000
      write = x > 0.75 ? 24_000_000 * r() : 300_000 * r()
      churn = 0.4
      break
    }
  }

  rss = Math.max(rss, 4 * MB)
  cpu = clamp(cpu, 0, 800)
  const code = s.code
  const stack = p.threads * 0.75 * MB
  external = Math.max(external, rss * (0.05 + r() * 0.03))
  const heapish = Math.max(0, rss - code - stack - external)
  const heap = heapish * (0.6 + r() * 0.05)
  const heapTotal = Math.min(heapish, heap * 1.18)
  const ioShare = clamp((read + write) / 80_000_000, 0, 0.35)
  const cpuSys = cpu * (0.1 + ioShare + r() * 0.04)
  const grew = prev ? Math.max(0, rss - prev.rss) : 0

  // Minor GCs for managed runtimes.
  if (p.hasGc && r() < 0.28) {
    recordGc(p, t, "minor", p.runtime === "python" ? 0.1 + r() * 0.9 : 0.3 + r() * 2.4, heap * (0.01 + r() * 0.03))
  }
  if (p.hasGc && (s.profile === "leak" || s.profile === "ramp") && r() < 0.012) {
    recordGc(p, t, "major", 8 + r() * 30, heap * 0.05)
  }

  return {
    t,
    rss,
    heap,
    heapTotal,
    external,
    code,
    stack,
    cpu,
    cpuUser: cpu - cpuSys,
    cpuSys,
    read: Math.max(0, read),
    write: Math.max(0, write),
    alloc: heap * churn * (0.7 + r() * 0.6) + grew * 2,
    faults: grew / 4096 + 40 + r() * 200 + (cpu > 200 ? 2000 * r() : 0),
    threads: p.threads,
    files: p.fds.files,
    sockets: p.fds.sockets,
    pipes: p.fds.pipes,
    // Only a runtime with an agent can report its own responsiveness.
    ...(p.profiling ? { loopLag: Math.max(0, (cpu > 150 ? 18 : 2) + noise(cpu > 150 ? 12 : 1.5)) } : {}),
  }
}

function recordGc(p: MockProc, t: number, kind: GcEvent["kind"], pauseMs: number, freed: number) {
  if (!p.hasGc) return
  p.gc.push({ t, kind, pauseMs, freed: Math.max(0, freed) })
  if (p.gc.length > MAX_GC) p.gc.splice(0, p.gc.length - MAX_GC)
}

let logId = 0

function maybeLog(p: MockProc, t: number) {
  const r = p.sim.rand
  const tpl = LOGS[p.sim.profile]
  if (r() < 0.35) {
    const isErr = tpl.err.length > 0 && r() < 0.06
    const pool = isErr ? tpl.err : tpl.out
    p.logs.push({
      id: logId++,
      t,
      stream: isErr ? "stderr" : "stdout",
      text: fillTemplate(pool[Math.floor(r() * pool.length)], p),
    })
    if (p.logs.length > MAX_LOGS) p.logs.splice(0, p.logs.length - MAX_LOGS)
  }
}

function jitterChildren(p: MockProc) {
  const r = p.sim.rand
  const last = p.samples.at(-1)!
  p.children = p.children.map((c, i) => ({
    ...c,
    cpu: clamp((last.cpu / (p.children.length + 1)) * (0.6 + r() * 0.8), 0, 100),
    rss: Math.max(2 * MB, (last.rss / (p.children.length + 2)) * (0.7 + 0.1 * i + r() * 0.2)),
  }))
}

function accumulate(p: MockProc, s: Sample) {
  const r = p.sim.rand
  const c = p.counters
  const sec = TICK_MS / 1000
  c.cpuUserMs += (s.cpuUser / 100) * TICK_MS
  c.cpuSysMs += (s.cpuSys / 100) * TICK_MS
  c.minorFaults += Math.round(s.faults * sec)
  if (r() < 0.004) c.majorFaults += 1 + Math.floor(r() * 3)
  c.ctxVoluntary += Math.round((80 + r() * 300 + (s.read + s.write) / 50_000) * sec)
  c.ctxInvoluntary += Math.round((s.cpu / 100) * (5 + r() * 25) * sec)
  c.readTotal += s.read * sec
  c.writeTotal += s.write * sec
  c.syscalls += Math.round((2000 + s.cpu * 40 + (s.read + s.write) / 4096) * sec)
  p.vsz = Math.max(p.vsz, s.rss * 3.2 + 1.2 * 1024 * MB)
  p.swap = s.rss > 1.5 * 1024 * MB ? (s.rss - 1.5 * 1024 * MB) * 0.1 : 0
  p.fds = {
    files: clamp(p.fds.files + Math.round((r() - 0.5) * 3), 6, 4096),
    sockets: clamp(p.fds.sockets + (p.sim.profile === "leak" && r() < 0.06 ? 1 : Math.round((r() - 0.5) * 1.2)), 0, 2048),
    pipes: p.fds.pipes,
  }
}

/** Advance one tick. Returns a terminal status if the process just ended. */
function step(p: MockProc, t: number): Status | null {
  const sample = nextSample(p, t)
  p.samples.push(sample)
  if (p.samples.length > MAX_SAMPLES) p.samples.splice(0, p.samples.length - MAX_SAMPLES)
  if (sample.rss >= p.peak.rss) p.peak = sample
  p.threads = clamp(p.threads + (p.sim.rand() < 0.1 ? (p.sim.rand() < 0.5 ? -1 : 1) : 0), 1, 64)
  accumulate(p, sample)
  maybeLog(p, t)
  jitterChildren(p)
  sample.kids = p.children.map((c) => ({ pid: c.pid, rss: c.rss, cpu: c.cpu }))

  if (p.sim.oomAt && sample.rss >= p.sim.oomAt) {
    end(p, t, "crashed", 137, "SIGKILL")
    p.logs.push({ id: logId++, t, stream: "stderr", text: "Killed (out of memory)" })
    return "crashed"
  }
  if (p.sim.lifespan && p.sim.tick >= p.sim.lifespan) {
    // Linters in the demo always find something.
    if (/\blint\b/.test(p.command)) {
      end(p, t, "crashed", 1)
      p.logs.push({ id: logId++, t, stream: "stderr", text: "✖ 3 problems (3 errors, 0 warnings)" })
      return "crashed"
    }
    end(p, t, "exited", 0)
    p.logs.push({ id: logId++, t, stream: "stdout", text: "Done." })
    return "exited"
  }
  return null
}

function end(p: MockProc, t: number, status: Status, code: number | undefined, signal?: string) {
  p.status = status
  p.endedAt = t
  p.exitCode = code
  p.signal = signal
  p.children = []
}

// ─── process factory ─────────────────────────────────────────────────────────

const CHILDREN: Partial<Record<Runtime, string[]>> = {
  bun: ["esbuild", "esbuild"],
  node: ["node (worker)", "esbuild"],
  python: ["pt_data_worker", "pt_data_worker", "pt_data_worker"],
  rust: ["rustc", "cc"],
}

const EXE: Record<Runtime, string> = {
  bun: "/home/noah/.bun/bin/bun",
  node: "/usr/bin/node",
  python: "/home/noah/.venv/bin/python3.13",
  rust: "/home/noah/.cargo/bin/cargo",
  go: "/usr/bin/go",
  php: "/usr/bin/php",
  shell: "/usr/bin/bash",
}

const AGENT_VERSION = "0.1.1"
/** What each runtime's real agent says about itself, for the browser simulation. */
const MOCK_AGENTS: Partial<Record<Runtime, AgentInfo>> = {
  node: { runtimeVersion: "22.11.0", agentVersion: AGENT_VERSION, capabilities: ["heap", "gc", "lag", "cpu", "snapshot", "forcegc"], notes: { lag: "Event-loop delay, p99" } },
  bun: {
    runtimeVersion: "1.2.20",
    agentVersion: AGENT_VERSION,
    capabilities: ["heap", "lag", "cpu", "snapshot", "forcegc"],
    unavailable: { gc: "Bun doesn't publish individual garbage collections, so none are listed." },
    notes: { lag: "How late a 20 ms timer fired, p99" },
    gauges: [{ name: "Live objects", value: 182_000, unit: "count" }],
  },
  python: { runtimeVersion: "3.12.3", agentVersion: AGENT_VERSION, capabilities: ["gc", "lag", "cpu", "snapshot", "forcegc"], notes: { lag: "How late a 10 ms sleep woke up, p99: time waiting for the GIL and a CPU" } },
  php: {
    runtimeVersion: "8.3.6",
    agentVersion: AGENT_VERSION,
    capabilities: ["heap", "gc", "cpu", "forcegc"],
    unavailable: { lag: "PHP runs one request from start to end, with no event loop to delay.", snapshot: "PHP has no built-in way to list what is in memory.", gcFreed: "PHP counts the values it collects, not their bytes." },
    gauges: [{ name: "Collector runs", value: 12, unit: "count" }],
  },
}

function inferRuntime(command: string): Runtime {
  const bin = command.trim().split(/\s+/)[0]
  if (/^(bun|bunx)$/.test(bin)) return "bun"
  if (/^(node|npm|npx|pnpm|yarn|tsx|vite)$/.test(bin)) return "node"
  if (/^(python3?|uv|pytest|poetry)$/.test(bin)) return "python"
  if (/^(cargo|rustc)$/.test(bin)) return "rust"
  if (bin === "go") return "go"
  if (/^php|^(composer|artisan)$/.test(bin)) return "php"
  return "shell"
}

function inferProfile(command: string): { profile: Profile; lifespan?: number } {
  if (/\b(build|bundle|compile)\b/.test(command)) return { profile: "ramp", lifespan: 160 }
  if (/\btest\b/.test(command)) return { profile: "ramp", lifespan: 90 }
  if (/\blint\b/.test(command)) return { profile: "ramp", lifespan: 30 }
  if (/\b(train|ingest|etl|\.py)\b/.test(command)) return { profile: "spiky" }
  if (/\b(dev|serve|server|start)\b/.test(command)) return { profile: "leak" }
  if (/\b(worker|queue|consume)\b/.test(command)) return { profile: "sawtooth" }
  return { profile: "steady" }
}

interface Spec {
  command: string
  cwd: string
  pid?: number
  profile?: Profile
  base?: number
  lifespan?: number
  oomAt?: number
  growth?: number
  /** How many ticks of history to pre-generate. */
  history?: number
  /** Stop pre-generating at this point and leave the process ended. */
  endedAgoMs?: number
}

function createProc(spec: Spec, now: number): MockProc {
  const seed = hash(spec.command + spec.cwd + (spec.pid ?? Math.random()))
  const rand = mulberry32(seed)
  const inferred = inferProfile(spec.command)
  const runtime = inferRuntime(spec.command)
  const history = spec.history ?? 0
  const endOffset = spec.endedAgoMs ?? 0
  const startedAt = now - endOffset - history * TICK_MS
  const pid = spec.pid ?? 20000 + Math.floor(rand() * 40000)

  const p: MockProc = {
    id: `p_${seed.toString(36)}`,
    pid,
    ppid: 2000 + Math.floor(rand() * 2000),
    user: "noah",
    exe: EXE[runtime],
    command: spec.command,
    cwd: spec.cwd,
    runtime,
    status: "running",
    startedAt,
    nice: 0,
    threads: 4 + Math.floor(rand() * 12),
    vsz: 0,
    swap: 0,
    fds: { files: 20 + Math.floor(rand() * 60), sockets: Math.floor(rand() * 12), pipes: 3 + Math.floor(rand() * 4) },
    counters: {
      cpuUserMs: 0,
      cpuSysMs: 0,
      minorFaults: 0,
      majorFaults: 0,
      ctxVoluntary: 0,
      ctxInvoluntary: 0,
      readTotal: 0,
      writeTotal: 0,
      syscalls: 0,
    },
    samples: [],
    peak: undefined as unknown as Sample,
    gc: [],
    hasGc: runtime !== "rust" && runtime !== "shell",
    profiling: runtime !== "shell" && runtime !== "go",
    agent: MOCK_AGENTS[runtime],
    snapshots: [],
    logs: [{ id: logId++, t: startedAt, stream: "stdout", text: `$ ${spec.command}` }],
    children: (CHILDREN[runtime] ?? []).map((name) => ({
      pid: 20000 + Math.floor(rand() * 40000),
      name,
      cpu: 0,
      rss: 0,
    })),
    sim: {
      profile: spec.profile ?? inferred.profile,
      tick: 0,
      base: spec.base ?? (40 + rand() * 80) * MB,
      level: 0,
      growth: spec.growth ?? 0.18,
      code: (14 + rand() * 30) * MB,
      rand,
      lifespan: spec.lifespan ?? inferred.lifespan,
      oomAt: spec.oomAt,
    },
  }

  p.childNames = Object.fromEntries(p.children.map((c) => [c.pid, c.name]))
  // Dev servers listen on something; batch jobs don't.
  if ((spec.profile ?? inferred.profile) === "leak") {
    p.ports = [
      { port: 3000, proto: "tcp", addr: "127.0.0.1", pid },
      { port: 24678, proto: "tcp6", addr: "::1", pid },
    ]
  }
  // Seed the first sample so the UI never sees an empty series.
  p.samples.push(nextSample(p, startedAt))
  p.peak = p.samples[0]
  // Pre-generate history, taking a couple of heap snapshots along the way.
  const snapAt = new Set([Math.floor(history * 0.35), Math.floor(history * 0.7)])
  for (let i = 1; i <= history; i++) {
    const t = startedAt + i * TICK_MS
    if (step(p, t)) break
    if (snapAt.has(i) && p.profiling) p.snapshots.push(makeSnapshot(p, t))
  }
  if (history > 0 && p.profiling) p.snapshots.push(makeSnapshot(p, p.samples.at(-1)!.t))
  return p
}

function seed(now: number): MockProc[] {
  const procs = [
    createProc({ command: "bun run dev", cwd: "~/dev/storefront", pid: 48213, history: 1900 }, now),
    createProc(
      { command: "python train.py --epochs 3", cwd: "~/dev/ml/classifier", pid: 51877, base: 420 * MB, history: 900 },
      now,
    ),
    createProc({ command: "node worker.js --queue emails", cwd: "~/dev/storefront", pid: 48390, history: 700 }, now),
    createProc(
      { command: "cargo watch -x check", cwd: "~/dev/tauri-test/src-tauri", pid: 39011, history: 7300 },
      now,
    ),
    createProc(
      {
        command: "bun run build",
        cwd: "~/dev/storefront",
        pid: 47702,
        lifespan: 220,
        history: 400,
        endedAgoMs: 6 * 60_000,
      },
      now,
    ),
    createProc(
      {
        command: "python scripts/ingest.py data/2026-10.parquet",
        cwd: "~/dev/ml/pipeline",
        pid: 45120,
        profile: "leak",
        base: 300 * MB,
        oomAt: 1.9 * 1024 * MB,
        growth: 1.4,
        history: 2000,
        endedAgoMs: 14 * 60_000,
      },
      now,
    ),
  ]
  // A run that crossed a limit before crashing, so markers and reports have an alert to show.
  const ingest = procs[5]
  const crossing = ingest.samples.find((s) => s.rss >= 1.5 * 1024 * MB)!
  ingest.alerts = [
    {
      t: crossing.t,
      kind: "memory",
      message: `Memory reached ${formatBytes(crossing.rss)} (limit 1.5 GiB)`,
      value: crossing.rss,
      threshold: 1.5 * 1024 * MB,
    },
  ]
  return procs
}

const DAY_MS = 86_400_000

/** Past runs, so history, comparison and retention have something to show. */
function seedHistory(now: number): MockProc[] {
  const past = (command: string, cwd: string, pid: number, days: number, extra: Partial<Spec> = {}) =>
    createProc({ command, cwd, pid, history: 240, lifespan: 240, endedAgoMs: days * DAY_MS, ...extra }, now)
  return [
    past("bun run build", "~/dev/storefront", 41001, 1),
    past("bun run build", "~/dev/storefront", 40044, 3, { base: 160 * MB, lifespan: 160 }),
    past("bun run build", "~/dev/storefront", 38120, 12, { base: 70 * MB, lifespan: 300, history: 300 }),
    past("npm test", "~/dev/storefront", 39500, 2, { lifespan: 90 }),
    past("npm test", "~/dev/storefront", 37002, 9, { lifespan: 120 }),
    past("python train.py --epochs 3", "~/dev/ml/classifier", 33121, 6, { base: 420 * MB, profile: "spiky" }),
    past("python scripts/ingest.py data/2026-09.parquet", "~/dev/ml/pipeline", 30219, 45, {
      profile: "leak",
      base: 300 * MB,
      growth: 7,
      oomAt: 1.9 * 1024 * MB,
    }),
  ]
}

/** A CPU profile shaped like the process's call sites; `self` is ms on-CPU. */
function makeCpuProfile(p: MockProc, ms: number, t: number): CpuProfile {
  const r = p.sim.rand
  const build = ([name, file, w, , kids]: SiteSpec): AllocFrame => ({ name, file: file || undefined, self: w * (0.8 + r() * 0.4), children: kids.map(build) })
  const root = build(SITES[p.sim.profile])
  const scale = ms / frameTotal(root)
  const rescale = (f: AllocFrame): AllocFrame => ({ ...f, self: f.self * scale, children: f.children.map(rescale) })
  const sampling = ({ python: "stack", bun: "jsc", php: "excimer-cpu" } as const)[p.runtime as "python"] ?? ("v8" as const)
  return { id: `c_${t.toString(36)}_${Math.floor(r() * 1e6).toString(36)}`, t, durationMs: ms, sampling, root: rescale(root) }
}

/** The machine's memory and load, drifting with what's running. */
function nextMachine(prev: SystemSample | undefined, procs: Proc[], t: number): SystemSample {
  const running = procs.filter((p) => p.status === "running")
  const used = running.reduce((a, p) => a + p.samples.at(-1)!.rss, 0)
  const cpu = running.reduce((a, p) => a + p.samples.at(-1)!.cpu, 0)
  const wobble = (Math.sin(t / 45_000) + 1) * 0.5
  return {
    t,
    memTotal: SYSTEM_MEMORY,
    memAvailable: Math.max(0, SYSTEM_MEMORY * (0.72 - wobble * 0.08) - used),
    swapTotal: 8 * 1024 ** 3,
    swapFree: prev?.swapFree ?? 7.4 * 1024 ** 3,
    psiSome: wobble * 1.5,
    psiFull: wobble * 0.2,
    load1: cpu / 100 + wobble,
    cpu: clamp((cpu / 12 + wobble * 10), 0, 100),
  }
}

function summarize(p: MockProc): RunSummary {
  return {
    id: p.id,
    pid: p.pid,
    command: p.command,
    cwd: p.cwd,
    runtime: p.runtime,
    status: p.status,
    startedAt: p.startedAt,
    endedAt: p.endedAt,
    exitCode: p.exitCode,
    signal: p.signal,
    peakRss: p.peak.rss,
    avgCpu: p.samples.reduce((a, s) => a + s.cpu, 0) / p.samples.length,
    samples: p.samples.length,
  }
}

// ─── simulated targets ───────────────────────────────────────────────────────
// Everything here is invented, for working on the UI without infrastructure.

const NO_CAPABILITIES = { collector: false, attach: false, launch: false, signal: false, runtimeAgents: false, containerTotals: false, containerLogs: false, containerTop: false }
const CONNECT_MS = 400

function simulatedState(spec: TargetSpec): TargetState {
  return { spec, state: "disconnected", error: null, capabilities: NO_CAPABILITIES, facts: null, system: null, clockOffsetMs: 0 }
}

function simulatedLink(t: TargetState): TargetState {
  const container = t.spec.kind !== "ssh"
  return {
    ...t,
    state: "connected",
    error: null,
    capabilities: {
      collector: true,
      attach: true,
      launch: true,
      signal: true,
      runtimeAgents: true,
      containerTotals: t.spec.kind === "docker",
      containerLogs: container,
      containerTop: t.spec.kind === "docker",
    },
    facts: {
      protocol: 1,
      collectorVersion: "simulated",
      arch: "x86_64",
      kernel: "simulated",
      hostname: t.spec.label,
      bootId: "simulated-boot",
      pidNs: "pid:[simulated]",
      uid: 1000,
      clkTck: 100,
      cpus: 8,
      hostMemory: 16 * 1024 ** 3,
      limits: { version: 2, memoryMax: container ? 2 * 1024 ** 3 : null, memoryCurrent: container ? 300 * MB : null, cpuQuotaCores: container ? 2 : null },
      runtimeAgents: true,
    },
    clockOffsetMs: 240,
  }
}

const TARGET_PROCESSES: Attachable[] = [
  { pid: 812, command: "node server.js --port 8080", cwd: "/srv/app", rss: 310 * MB, startTicks: 90210 },
  { pid: 1204, command: "python worker.py", cwd: "/srv/worker", rss: 180 * MB, startTicks: 91544 },
]

const DOCKER_CONTAINERS = [
  { id: "c0ffee000000a1", name: "shop-web (simulated)", image: "shop/web:1.4", state: "running", status: "Up 3 hours" },
  { id: "c0ffee000000b2", name: "shop-migrate (simulated)", image: "shop/web:1.4", state: "exited", status: "Exited (0) 3 hours ago" },
]

const KUBE_PODS = [
  {
    name: "api-7f9c (simulated)",
    uid: "11111111-2222-3333-4444-555555555555",
    namespace: "default",
    phase: "Running",
    node: "node-1",
    containers: [
      { name: "api", ready: true, state: "running", restarts: 0, containerId: "containerd://sim1" },
      { name: "proxy", ready: true, state: "running", restarts: 1, containerId: "containerd://sim2" },
    ],
  },
]

const SETTINGS_KEY = "peak-mock-settings"

function readSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** Rough on-disk cost of a stored sample, so storage figures move believably. */
const BYTES_PER_SAMPLE = 420

// ─── store ───────────────────────────────────────────────────────────────────

type Listener = () => void

const ATTACHABLE: Attachable[] = [
  { pid: 31244, command: "vite --port 5173", cwd: "~/dev/landing", rss: 182 * MB },
  { pid: 30187, command: "uv run serve.py", cwd: "~/dev/ml/api", rss: 611 * MB },
  { pid: 29950, command: "node worker.js --queue thumbnails", cwd: "~/dev/media", rss: 240 * MB },
]

export class MockMonitor implements MonitorApi {
  readonly mode = "mock" as const
  private state: State
  private frozen: MockProc[] | null = null
  private listeners = new Set<Listener>()
  private eventListeners = new Set<(e: MonitorEvent) => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  /** Stored runs that aren't in the session right now. */
  private archive: MockProc[]
  /** Space freed by deletions, reclaimed by vacuum. */
  private reclaimable = 0
  private settings = readSettings()
  private alerts = new AlertEngine()
  /** When each run stopped getting data, while its target is unreachable. */
  private gapFrom = new Map<string, number>()

  constructor() {
    this.alerts.configure(this.settings)
    const now = Date.now()
    const procs = seed(now)
    this.archive = seedHistory(now)
    const machine = Array.from({ length: 240 }, (_, i) => nextMachine(undefined, procs, now - (240 - i) * TICK_MS))
    this.state = {
      procs,
      selectedId: procs[0].id,
      paused: false,
      system: { totalMemory: SYSTEM_MEMORY, cpus: 12, hostname: "devbox", os: "Linux" },
      ready: true,
      machine,
      targets: [simulatedState({ ...NEW_TARGET, id: "staging", label: "staging-1 (simulated)", kind: "ssh", host: "me@staging-1", install: true })],
    }
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l)
    this.start()
    return () => {
      this.listeners.delete(l)
      if (this.listeners.size === 0) this.stop()
    }
  }

  onEvent = (l: (e: MonitorEvent) => void) => {
    this.eventListeners.add(l)
    return () => void this.eventListeners.delete(l)
  }

  getSnapshot = () => this.state

  private start() {
    if (this.timer) return
    this.timer = setInterval(this.tick, TICK_MS)
  }

  private stop() {
    clearInterval(this.timer)
    this.timer = undefined
  }

  private set(next: Partial<State>) {
    this.state = { ...this.state, ...next }
    this.listeners.forEach((l) => l())
  }

  private emit(e: MonitorEvent) {
    this.eventListeners.forEach((l) => l(e))
  }

  private tick = () => {
    const t = Date.now()
    const events: MonitorEvent[] = []
    // Sampling continues while paused; only the UI snapshot freezes.
    const stepped = this.current().map((p) => {
      if (p.status !== "running" || !this.linked(p)) return p
      const next: MockProc = { ...p, samples: [...p.samples], logs: [...p.logs], gc: [...p.gc], counters: { ...p.counters } }
      const ended = step(next, t)
      if (ended) events.push({ type: ended, proc: next } as MonitorEvent)
      return next
    })
    const procs = applyAlerts(this.alerts, stepped, (proc, alert) => {
      events.push({ type: "alert", proc, alert, notify: this.settings.notifications })
    })
    if (this.state.paused) {
      this.frozen = procs
    } else {
      const machine = [...this.state.machine, nextMachine(this.state.machine.at(-1), procs, t)].slice(-MAX_SAMPLES)
      this.set({ procs, machine })
    }
    events.forEach((e) => this.emit(e))
  }

  // ─── actions ───

  select = (id: string) => this.set({ selectedId: id })

  open = (id: string) => this.set({ selectedId: id, openRequest: { id, seq: (this.state.openRequest?.seq ?? 0) + 1 } })

  setPaused = (paused: boolean) => {
    if (!paused && this.frozen) {
      this.set({ paused, procs: this.frozen })
      this.frozen = null
    } else {
      this.set({ paused })
    }
  }

  capture = async (command: string, cwd: string, pid?: number) => {
    const proc = createProc({ command, cwd: cwd || "~", pid }, Date.now())
    this.set({ procs: [proc, ...this.current()], selectedId: proc.id })
    this.emit({ type: "captured", proc })
  }

  attach = async (pid: number) => {
    const a = ATTACHABLE.find((x) => x.pid === pid)
    await this.capture(a?.command ?? `pid ${pid}`, a?.cwd ?? "~", pid)
  }

  listAttachable = async () => ATTACHABLE

  takeSnapshot = async (id: string) => {
    let snapshot: HeapSnapshot | null = null
    this.update(id, (p) => {
      snapshot = makeSnapshot(p, p.samples.at(-1)!.t)
      p.snapshots = [...p.snapshots, snapshot]
    })
    const proc = this.current().find((p) => p.id === id)
    if (snapshot && proc) this.emit({ type: "snapshot", proc, snapshot })
    return snapshot as HeapSnapshot | null
  }

  cpuProfile = async (id: string, ms: number) => {
    const proc = this.current().find((p) => p.id === id)
    if (!proc?.profiling) throw new Error("no profiling agent is attached to this process")
    await new Promise((r) => setTimeout(r, ms))
    const profile = makeCpuProfile(proc, ms, Date.now())
    this.update(id, (p) => {
      p.cpuProfiles = [...(p.cpuProfiles ?? []), profile]
    })
    return profile
  }

  forceGc = (id: string) => {
    const t = Date.now()
    this.update(id, (p) => {
      const last = p.samples.at(-1)!
      p.gc = [...p.gc]
      recordGc(p, t, "major", 25 + p.sim.rand() * 40, last.heap * 0.12)
      if (p.sim.profile === "sawtooth") p.sim.level = 8 * MB
    })
  }

  kill = (id: string) => {
    const t = Date.now()
    this.update(id, (p) => {
      end(p, t, "exited", 130, "SIGINT")
      p.logs.push({ id: logId++, t, stream: "stderr", text: "^C  interrupted" })
    })
  }

  restart = (id: string) => {
    const old = this.current().find((p) => p.id === id)
    if (!old) return
    const proc = createProc(
      { command: old.command, cwd: old.cwd, profile: old.sim.profile, lifespan: old.sim.lifespan },
      Date.now(),
    )
    if (old.target) {
      proc.id = `${old.target.targetId}~${proc.id}`
      proc.target = old.target
    }
    // The earlier run stays in history, as it does in the real database.
    this.archive.push(old)
    this.set({
      procs: this.current().map((p) => (p.id === id ? proc : p)),
      selectedId: proc.id,
    })
  }

  remove = (id: string) => this.keep((p) => p.id !== id)

  clearEnded = () => this.keep((p) => p.status === "running")

  /** Keep matching session processes; the rest stay in history, like the real database. */
  private keep(keep: (p: MockProc) => boolean) {
    const all = this.current()
    const procs = all.filter(keep)
    this.archive.push(...all.filter((p) => !keep(p)))
    const selectedId = procs.some((p) => p.id === this.state.selectedId) ? this.state.selectedId : (procs[0]?.id ?? null)
    this.set({ procs, selectedId })
  }

  // ─── history ───

  private stored() {
    return [...this.current(), ...this.archive]
  }

  private linked(p: Proc) {
    return !p.target || this.state.targets.some((t) => t.spec.id === p.target!.targetId && t.state === "connected")
  }

  listRuns = async (query?: string) => {
    const q = query?.toLowerCase() ?? ""
    return this.stored()
      .filter((p) => p.command.toLowerCase().includes(q))
      .map(summarize)
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  private find(id: string) {
    const p = this.stored().find((x) => x.id === id)
    if (!p) throw new Error("run not found")
    return p
  }

  openRun = async (id: string) => {
    const p = this.find(id)
    if (this.current().includes(p)) return this.select(id)
    this.archive = this.archive.filter((x) => x !== p)
    this.set({ procs: [{ ...p, historical: true }, ...this.current()], selectedId: id })
  }

  loadRun = async (id: string): Promise<Proc> => this.find(id)

  deleteRun = async (id: string) => {
    if (this.current().some((p) => p.id === id && p.status === "running")) {
      throw new Error("stop the process before deleting its history")
    }
    const victim = this.stored().find((p) => p.id === id)
    if (!victim) return false
    this.reclaimable += victim.samples.length * BYTES_PER_SAMPLE
    this.keep((p) => p !== victim)
    this.archive = this.archive.filter((p) => p !== victim)
    return true
  }

  pruneRuns = async (olderThanDays?: number) => {
    const before = olderThanDays === undefined ? Infinity : Date.now() - olderThanDays * DAY_MS
    const old = (p: MockProc) => p.status !== "running" && p.endedAt! < before
    const victims = this.stored().filter(old)
    this.reclaimable += victims.reduce((a, p) => a + p.samples.length * BYTES_PER_SAMPLE, 0)
    this.keep((p) => !old(p))
    this.archive = this.archive.filter((p) => !old(p))
    return victims.length
  }

  // ─── simulated targets ───

  private setTarget(id: string, fn: (t: TargetState) => TargetState) {
    this.set({ targets: this.state.targets.map((t) => (t.spec.id === id ? fn(t) : t)) })
  }

  private target(id: string) {
    const t = this.state.targets.find((x) => x.spec.id === id)
    if (!t) throw new Error("unknown target")
    if (t.state !== "connected") throw new Error("target is not connected")
    return t
  }

  addTarget = async (spec: TargetSpec) => {
    const added = simulatedState({ ...spec, id: spec.id || `t${this.state.targets.length + 1}` })
    this.set({ targets: [...this.state.targets.filter((t) => t.spec.id !== added.spec.id), added] })
    return added
  }

  removeTarget = async (id: string) => {
    if (this.current().some((p) => p.target?.targetId === id && p.status === "running")) {
      throw new Error("detach from this target's processes first")
    }
    this.set({ targets: this.state.targets.filter((t) => t.spec.id !== id) })
  }

  connectTarget = async (id: string) => {
    this.setTarget(id, (t) => ({ ...t, state: "connecting" }))
    setTimeout(() => {
      this.setTarget(id, simulatedLink)
      // Back in touch: the same runs resume, and the outage shows as a gap.
      const now = Date.now()
      const procs = this.current().map((p) => {
        const from = this.gapFrom.get(p.id)
        if (p.target?.targetId !== id || from === undefined) return p
        this.gapFrom.delete(p.id)
        return { ...p, gaps: [...(p.gaps ?? []), { from, to: now }] }
      })
      this.set({ procs })
    }, CONNECT_MS)
  }

  /** Losing the link says nothing about the workload: runs stay as they were. */
  disconnectTarget = async (id: string) => {
    const t = Date.now()
    for (const p of this.current()) {
      if (p.target?.targetId !== id || p.status !== "running") continue
      // A command launched through the session ends with it; an attached one goes on.
      if (p.target.launched) this.update(p.id, (x) => end(x, t, "exited", undefined, "stopped with the session"))
      else this.gapFrom.set(p.id, p.samples.at(-1)!.t)
    }
    this.setTarget(id, (t) => ({ ...t, state: "disconnected", capabilities: NO_CAPABILITIES }))
  }

  listTargetProcesses = async (id: string) => {
    this.target(id)
    return TARGET_PROCESSES
  }

  private addRemote(id: string, command: string, cwd: string, pid: number | undefined, launched: boolean, spec?: LaunchSpec) {
    const t = this.target(id)
    const proc = createProc({ command, cwd, pid }, Date.now())
    proc.id = `${id}~${proc.id}`
    proc.profiling = launched && proc.profiling
    if (!launched) proc.logs = []
    proc.target = {
      targetId: id,
      label: t.spec.label,
      kind: t.spec.kind!,
      identity: { bootId: "simulated-boot", pidNs: "pid:[simulated]", pid: proc.pid, startTicks: 90210 },
      launched,
      spec,
      clockOffsetMs: t.clockOffsetMs,
    }
    this.set({ procs: [proc, ...this.current()], selectedId: proc.id })
    this.emit({ type: "captured", proc })
  }

  attachTarget = async (id: string, pid: number) => {
    const a = TARGET_PROCESSES.find((x) => x.pid === pid)
    this.addRemote(id, a?.command ?? `pid ${pid}`, a?.cwd ?? "/", pid, false)
  }

  launchTarget = async (id: string, spec: LaunchSpec) => {
    this.addRemote(id, spec.command ?? spec.argv!.join(" "), spec.cwd, undefined, true, spec)
  }

  /** Stop watching: it keeps running, as far as anyone knows. */
  detach = async (id: string) => {
    const t = Date.now()
    this.update(id, (p) => end(p, t, "exited", undefined, "monitoring stopped"))
  }

  signal = async (id: string, signal: string) => {
    const t = Date.now()
    this.update(id, (p) => end(p, t, "exited", undefined, `SIG${signal}`))
  }

  dockerContexts = async () => ["default", "remote-build"]

  dockerContainers = async () => DOCKER_CONTAINERS

  dockerTotals = async () => {
    const swing = Math.random()
    return { cpuPercent: 12 + swing * 30, memoryUsed: (280 + swing * 40) * MB, memoryLimit: 2 * 1024 ** 3, pids: 14, rawNet: "1.2MB / 800kB", rawBlock: "24MB / 0B" }
  }

  dockerTop = async () => [
    { pid: "48211", user: "root", command: "node server.js" },
    { pid: "48390", user: "root", command: "node worker.js" },
  ]

  dockerLogs = async () => "2026-11-06T09:00:00Z listening on :8080 (simulated)\n2026-11-06T09:00:04Z GET /health 200 (simulated)\n"

  kubeContexts = async () => ["kind-dev"]

  kubeNamespaces = async () => ["default", "web"]

  kubePods = async (_: string, namespace: string) => (namespace === "default" ? KUBE_PODS : [])

  kubeLogs = async () => "2026-11-06T09:00:00Z starting (simulated)\n"

  kubeMetrics = async () => null

  kubeAccess = async () => ({ listPods: true, readLogs: true, exec: true })

  // ─── settings and storage ───

  storageInfo = async (): Promise<StorageInfo> => {
    const runs = this.stored()
    const samples = runs.reduce((a, p) => a + p.samples.length, 0)
    return {
      path: "(in memory — browser mock)",
      bytes: samples * BYTES_PER_SAMPLE + this.reclaimable,
      runs: runs.length,
      stoppedRuns: runs.filter((p) => p.status !== "running").length,
      samples,
    }
  }

  vacuum = async () => {
    this.reclaimable = 0
  }

  getSettings = async () => this.settings

  setSettings = async (next: Settings) => {
    this.settings = next
    this.alerts.configure(next)
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
    } catch {
      // Private windows may refuse storage; settings then last for this session.
    }
    return next
  }

  private current() {
    return this.frozen ?? (this.state.procs as MockProc[])
  }

  private update(id: string, fn: (p: MockProc) => void) {
    const procs = this.current().map((p) => {
      if (p.id !== id) return p
      const next: MockProc = { ...p, logs: [...p.logs] }
      fn(next)
      return next
    })
    if (this.frozen) this.frozen = procs
    this.set({ procs })
  }
}

