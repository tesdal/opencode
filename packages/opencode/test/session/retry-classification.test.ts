import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRetry } from "../../src/session/retry"

describe("SessionRetry.classify", () => {
  test("returns undefined for non-retryable context overflow", () => {
    const err = new MessageV2.ContextOverflowError({ message: "too long" }).toObject()
    expect(SessionRetry.classify(err)).toBeUndefined()
  })

  test("returns transport classification for SSEStallError", () => {
    const err = new MessageV2.SSEStallError({ message: "SSE read timed out after 120000ms" }).toObject()
    const out = SessionRetry.classify(err)
    expect(out).toEqual({ message: "SSE read timed out after 120000ms", isTransport: true })
  })

  test("returns non-transport classification for APIError 5xx", () => {
    const err = new MessageV2.APIError({
      message: "upstream exploded",
      statusCode: 503,
      isRetryable: false,
    }).toObject()
    const out = SessionRetry.classify(err)
    expect(out?.message).toBe("upstream exploded")
    expect(out?.isTransport).toBeFalsy()
  })

  test("retryable() still returns a string for transport errors (legacy API)", () => {
    const err = new MessageV2.SSEStallError({ message: "SSE read timed out after 120000ms" }).toObject()
    expect(SessionRetry.retryable(err)).toBe("SSE read timed out after 120000ms")
  })

  test("classifies plain-text ETIMEDOUT transport error as isTransport", () => {
    const err = {
      _tag: "Error",
      name: "UnknownError",
      data: { message: "connect ETIMEDOUT 1.2.3.4:443" },
    } as unknown as Parameters<typeof SessionRetry.classify>[0]
    const out = SessionRetry.classify(err)
    expect(out).toEqual({ message: "connect ETIMEDOUT 1.2.3.4:443", isTransport: true })
  })

  test("mixed rate-limit + transport message keeps rate-limit message AND transport cap", () => {
    // Regression: legacy policy() treated any message matching a TRANSPORT_PATTERN
    // as transport for cap purposes, even when the rate-limit branch picked the
    // message. Preserve that cap behavior via isTransport.
    const err = {
      _tag: "Error",
      name: "UnknownError",
      data: { message: "rate limit exceeded (ETIMEDOUT during retry)" },
    } as unknown as Parameters<typeof SessionRetry.classify>[0]
    const out = SessionRetry.classify(err)
    expect(out?.message).toBe("rate limit exceeded (ETIMEDOUT during retry)")
    expect(out?.isTransport).toBe(true)
  })

  test("APIError with overloaded message returns non-transport", () => {
    const err = new MessageV2.APIError({
      message: "Overloaded",
      statusCode: 529,
      isRetryable: true,
    }).toObject()
    const out = SessionRetry.classify(err)
    expect(out).toEqual({ message: "Provider is overloaded" })
  })
})
