import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { SSEStallError } from "../../src/provider/provider"
import { ProviderID } from "../../src/provider/schema"
import { MessageV2 } from "../../src/session/message-v2"

const providerID = ProviderID.make("github-copilot")

describe("session.message-v2.fromError — SSEStallError", () => {
  test("preserves SSEStallError for plain Error with SSEStallError name", () => {
    const error = new Error("SSE read timed out")
    error.name = "SSEStallError"

    const result = MessageV2.fromError(error, { providerID })

    expect(result.name).toBe("SSEStallError")
    expect(result.data.message).toBe("SSE read timed out")
  })

  test("MessageV2.SSEStallError.isInstance returns true", () => {
    const error = new Error("SSE read timed out")
    error.name = "SSEStallError"

    const result = MessageV2.fromError(error, { providerID })

    expect(MessageV2.SSEStallError.isInstance(result)).toBe(true)
  })

  test("detects SSE stall by timeout message without SSEStallError name", () => {
    const error = new Error("SSE chunk timeout after 120000ms")

    const result = MessageV2.fromError(error, { providerID })

    expect(result.name).toBe("SSEStallError")
    expect(result.data.message).toBe("SSE chunk timeout after 120000ms")
  })

  test("detects SSE stall through two-deep cause chain", () => {
    const stall = new SSEStallError("SSE read timed out")
    const middle = new Error("middle")
    middle.cause = stall
    const outer = new Error("outer")
    outer.cause = middle

    const result = MessageV2.fromError(outer, { providerID })

    expect(result.name).toBe("SSEStallError")
  })

  test("detects SSE stall when APICallError wraps SSEStallError", () => {
    const stall = new SSEStallError("SSE read timed out")
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
})
