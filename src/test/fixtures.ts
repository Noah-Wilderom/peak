import type { Proc, Sample } from "@/lib/types"

export function sample(t: number, rss: number, extra: Partial<Sample> = {}): Sample {
  return {
    t, rss, heap: rss / 2, heapTotal: rss * 0.6, external: rss * 0.1, code: 1, stack: 1,
    cpu: 10, cpuUser: 8, cpuSys: 2, read: 1, write: 1, alloc: 1, faults: 1, ...extra,
  }
}

export function makeProc(over: Partial<Proc> = {}): Proc {
  const samples = over.samples ?? [sample(1000, 100), sample(1500, 200)]
  return {
    id: "p1", pid: 42, ppid: 1, user: "noah", exe: "/usr/bin/node", command: "node app.js", cwd: "/tmp",
    runtime: "node", status: "running", startedAt: 1000, nice: 0, threads: 4, vsz: 0, swap: 0,
    fds: { files: 1, sockets: 0, pipes: 0 },
    counters: { cpuUserMs: 0, cpuSysMs: 0, minorFaults: 0, majorFaults: 0, ctxVoluntary: 0, ctxInvoluntary: 0, readTotal: 0, writeTotal: 0, syscalls: 0 },
    samples, peak: samples.at(-1)!, gc: [], hasGc: true, profiling: true, snapshots: [], logs: [], children: [],
    ...over,
  }
}
