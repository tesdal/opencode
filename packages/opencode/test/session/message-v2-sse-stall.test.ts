import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { ProviderID } from "../../src/provider/schema"
import { MessageV2 } from "../../src/session/message-v2"

const providerID = ProviderID.make("github-copilot")

describe("session.message-v2.fromError — SSEStallError", () => {
  test("preserves SSEStallError for plain Error with SSEStallError name", () => {
    const error = new Error("SSE read timed out")
    error.name = "SSEStallError"

    const result = MessageV2.fromError(error, { providerID })

    expect(result.name).toBe("SSEStallError")
    expect(MessageV2.SSEStallError.isInstance(result)).toBe(true)
    if (!MessageV2.SSEStallError.isInstance(result)) throw new Error("Expected SSEStallError")
    expect(result.data.message).toBe("SSE read timed out")
  })

  test("MessageV2.SSEStallError.isInstance returns true", () => {
    const error = new Error("SSE read timed out")
    error.name = "SSEStallError"

    const result = MessageV2.fromError(error, { providerID })

    expect(MessageV2.SSEStallError.isInstance(result)).toBe(true)
  })

  test("detects SSE stall by timeout message without SSEStallError name", () => {
    const error = new Error("SSE read timed out after 120000ms")

    const result = MessageV2.fromError(error, { providerID })

    expect(result.name).toBe("SSEStallError")
    expect(MessageV2.SSEStallError.isInstance(result)).toBe(true)
    if (!MessageV2.SSEStallError.isInstance(result)) throw new Error("Expected SSEStallError")
    expect(result.data.message).toBe("SSE read timed out after 120000ms")
  })

  test("detects SSE stall through two-deep cause chain", () => {
    const stall = new MessageV2.SSEStallError({ message: "SSE read timed out" })
    const middle = new Error("middle")
    middle.cause = stall
    const outer = new Error("outer")
    outer.cause = middle

    const result = MessageV2.fromError(outer, { providerID })

    expect(result.name).toBe("SSEStallError")
  })

  test("detects SSE stall when APICallError wraps SSEStallError", () => {
    const stall = new MessageV2.SSEStallError({ message: "SSE read timed out" })
    const apiError = new APICallError({
      message: "stream error",
      url: "https://api.githubcopilot.com/chat/completions",
      requestBodyValues: {},
      cause: stall,
    })

    const result = MessageV2.fromError(apiError, { providerID })

    expect(result.name).toBe("SSEStallError")
    expect(MessageV2.APIError.isInstance(result)).toBe(false)
  })

  test("preserves canonical wrapSSE message when fromError receives a top-level MessageV2.SSEStallError", () => {
    // Regression for the F9 unification: schema-error instances have
    // `.message === "SSEStallError"` (the tag, set by `super(tag, options)` in
    // namedSchemaError), so fromError must read `.data.message` to recover the
    // real timing text. If extractStallMessage ever regresses, the result here
    // will be the literal string "SSEStallError" instead of the timing text.
    const stall = new MessageV2.SSEStallError({ message: "SSE read timed out after 2ms" })

    const result = MessageV2.fromError(stall, { providerID })

    expect(MessageV2.SSEStallError.isInstance(result)).toBe(true)
    if (!MessageV2.SSEStallError.isInstance(result)) throw new Error("Expected SSEStallError")
    expect(result.data.message).toBe("SSE read timed out after 2ms")
  })

  test("hasSSEStallCause: tag-based detection still works", () => {
    const tagged = Object.assign(new Error("anything"), { _tag: "SSEStallError" })
    const result = MessageV2.fromError(tagged, { providerID })
    expect(MessageV2.SSEStallError.isInstance(result)).toBe(true)
  })

  test("hasSSEStallCause: exact wrapSSE-format message is detected through cause chain", () => {
    const taggedless = new Error("SSE read timed out after 120000ms")
    const outer = new Error("outer")
    outer.cause = taggedless
    const result = MessageV2.fromError(outer, { providerID })
    expect(MessageV2.SSEStallError.isInstance(result)).toBe(true)
  })

  test("hasSSEStallCause: message-regex fallback rejects speculative 'chunk timeout' variants", () => {
    const speculative = new Error("SSE chunk timeout")
    const result = MessageV2.fromError(speculative, { providerID })
    expect(MessageV2.SSEStallError.isInstance(result)).toBe(false)
  })

  test("hasSSEStallCause: narrowed regex rejects shapes the old loose regex accepted", () => {
    // The previous regex /SSE (read|chunk) time(d out|out)/ matched all of these;
    // the narrowed /^SSE read timed out after \d+ms$/ rejects them all.
    // Any future wrapSSE format change must update the regex in lockstep.
    // Note: In JS regexes, `$` without the `m` flag matches only end-of-input
    // and does NOT match before a trailing "\n", so newline-suffixed messages
    // are rejected.
    const cases = [
      "SSE read timed out", // missing "after Nms" suffix
      "SSE chunk timed out after 120000ms", // wrong verb ("chunk" never emitted)
      "SSE read timeout after 120000ms", // "timeout" not "timed out"
      "prefix: SSE read timed out after 120000ms", // non-anchored prefix
      "SSE read timed out after 120000ms ", // trailing whitespace
      "SSE read timed out after 120000ms\n", // trailing newline ($ does not match before \n)
    ]
    for (const message of cases) {
      const result = MessageV2.fromError(new Error(message), { providerID })
      expect(MessageV2.SSEStallError.isInstance(result)).toBe(false)
    }
  })
})
