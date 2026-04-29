import { describe, expect, test } from "bun:test"
import { makeRunSink } from "../../src/cli/cmd/run"
import { SessionID } from "../../src/session/schema"
import { silentSink as silentAutoReplySink } from "../../src/session/auto-reply/sink"

// F11 contract: makeRunSink translates the auto-reply Sink callbacks into the
// operator-facing JSON envelope written under `--output-format=json`. Operators
// have shell pipelines built against these field names; renaming any field is
// a breaking change to the CLI's external contract. This file pins the shape
// independently of the SessionAutoReply core's sink callback signature.
//
// Historical context: prior to F11 the JSON emission lived inline in
// run-events.ts's `emit()` helper, and the run-events.test.ts file pinned the
// shape by monkey-patching process.stdout. After F11 the sink interface
// removed jsonMode from the core, so the JSON shape now lives in run.ts and
// needs its own targeted test.

const ROOT = SessionID.make("ses_root_make_sink_test_000000")

describe("cli/run makeRunSink", () => {
  test("non-jsonMode returns the shared silentSink (no allocation, no emission)", () => {
    const sink = makeRunSink(false, ROOT)
    expect(sink).toBe(silentAutoReplySink)
  })

  test("jsonMode emits auto-reject with stable field names", () => {
    const writes: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stdout.write

    try {
      const sink = makeRunSink(true, ROOT)
      const childSessionID = SessionID.make("ses_child_make_sink_test_00000")
      sink.onAutoReject({ kind: "question", sessionID: childSessionID, total: 3 })
    } finally {
      process.stdout.write = original
    }

    expect(writes).toHaveLength(1)
    const payload = JSON.parse(writes[0].trim()) as Record<string, unknown>
    expect(payload.type).toBe("auto-reject")
    expect(typeof payload.timestamp).toBe("number")
    expect(payload.sessionID).toBe(ROOT)
    expect(payload.kind).toBe("question")
    expect(payload.autoRejectSessionID).toBe("ses_child_make_sink_test_00000")
    expect(payload.totalAutoRejects).toBe(3)
    expect(Object.keys(payload).sort()).toEqual(
      ["autoRejectSessionID", "kind", "sessionID", "timestamp", "totalAutoRejects", "type"].sort(),
    )
  })

  test("jsonMode emits auto-approve with stable field names", () => {
    const writes: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stdout.write

    try {
      const sink = makeRunSink(true, ROOT)
      sink.onAutoApprove({ kind: "permission", sessionID: ROOT, total: 1 })
    } finally {
      process.stdout.write = original
    }

    expect(writes).toHaveLength(1)
    const payload = JSON.parse(writes[0].trim()) as Record<string, unknown>
    expect(payload.type).toBe("auto-approve")
    expect(typeof payload.timestamp).toBe("number")
    expect(payload.sessionID).toBe(ROOT)
    expect(payload.kind).toBe("permission")
    expect(payload.autoApproveSessionID).toBe(ROOT)
    expect(payload.totalAutoApproves).toBe(1)
    expect(Object.keys(payload).sort()).toEqual(
      ["autoApproveSessionID", "kind", "sessionID", "timestamp", "totalAutoApproves", "type"].sort(),
    )
  })

  test("jsonMode does NOT emit a JSON line for onLivelockWarn (preserves pre-F11 behavior; log.warn handles it)", () => {
    const writes: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stdout.write

    try {
      const sink = makeRunSink(true, ROOT)
      sink.onLivelockWarn({ rootSessionID: ROOT })
    } finally {
      process.stdout.write = original
    }

    expect(writes).toHaveLength(0)
  })

  test("jsonMode emits one separate line per call (newline-delimited JSON)", () => {
    const writes: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stdout.write

    try {
      const sink = makeRunSink(true, ROOT)
      sink.onAutoReject({ kind: "question", sessionID: ROOT, total: 1 })
      sink.onAutoReject({ kind: "permission", sessionID: ROOT, total: 2 })
      sink.onAutoApprove({ kind: "permission", sessionID: ROOT, total: 1 })
    } finally {
      process.stdout.write = original
    }

    expect(writes).toHaveLength(3)
    expect(writes.every((w) => w.endsWith("\n"))).toBe(true)
    const parsed = writes.map((w) => JSON.parse(w.trim()) as { type: string })
    expect(parsed.map((p) => p.type)).toEqual(["auto-reject", "auto-reject", "auto-approve"])
  })
})
