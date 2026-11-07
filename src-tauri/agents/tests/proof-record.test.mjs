import { test } from "node:test"
import assert from "node:assert/strict"
import { newRecord, passed, tally } from "../../../scripts/e2e/smoke/record.mjs"

const quiet = () => {}

test("a proof with every check observed passes", () => {
  const r = newRecord(quiet)
  r.check("a", true)
  r.check("b", 1, "detail")
  assert.deepEqual(r.counts(), { pass: 2, fail: 0, unobserved: 0, total: 2 })
  assert.equal(r.passed(), true)
})

test("a required control nobody could observe fails the proof, and isn't counted as a pass", () => {
  const r = newRecord(quiet)
  r.check("a", true)
  r.unobserved("the button", "couldn't be found")
  assert.deepEqual(r.counts(), { pass: 1, fail: 0, unobserved: 1, total: 2 })
  assert.equal(r.passed(), false)
  assert.equal(r.entries["the button"].ok, false)
})

test("a failure fails it, and so does a proof that checked nothing", () => {
  const r = newRecord(quiet)
  r.check("a", false)
  assert.equal(r.passed(), false)
  assert.equal(passed({}), false)
})

// How the first macOS window runs were written down, for anyone rereading them with this.
test("an older record's ok flag on an unobserved control doesn't make it a pass", () => {
  assert.deepEqual(tally({ a: { result: "unobserved", ok: true, unobserved: true } }), { pass: 0, fail: 0, unobserved: 1, total: 1 })
})
