// What a proof found, kept so that its counts can't flatter it. Each check is observed to pass,
// observed to fail, or never observed. Only the first counts as evidence: something required that
// couldn't be seen fails the proof, and isn't a pass with a note on it.
export function newRecord(log = console.log) {
  const entries = {}
  return {
    entries,
    check(name, ok, detail) {
      entries[name] = { result: ok ? "pass" : "fail", ok: !!ok, detail }
      log(ok ? "ok  " : "FAIL", name, detail ?? "")
    },
    unobserved(name, detail) {
      entries[name] = { result: "unobserved", ok: false, unobserved: true, detail }
      log("NOT OBSERVED", name, detail ?? "")
    },
    counts: () => tally(entries),
    passed: () => passed(entries),
  }
}

export function tally(entries) {
  const counts = { pass: 0, fail: 0, unobserved: 0, total: 0 }
  for (const e of Object.values(entries)) {
    counts[e.result]++
    counts.total++
  }
  return counts
}

/** Nothing failed, nothing went unseen, and something was actually checked. */
export function passed(entries) {
  const c = tally(entries)
  return c.total > 0 && c.pass === c.total
}
