import { describe, expect, test } from "bun:test"
import { resolveChunkTimeout, SSEStallError, wrapSSE } from "../../src/provider/provider"

describe("provider.resolveChunkTimeout", () => {
  test("returns 120s default when undefined for generic provider", () => {
    expect(resolveChunkTimeout("github-copilot", undefined)).toBe(120_000)
  })

  test("returns 600s default for Anthropic", () => {
    expect(resolveChunkTimeout("anthropic", undefined)).toBe(600_000)
  })

  test("returns 600s default for google-vertex-anthropic", () => {
    expect(resolveChunkTimeout("google-vertex-anthropic", undefined)).toBe(600_000)
  })

  test("returns 600s default for amazon-bedrock", () => {
    expect(resolveChunkTimeout("amazon-bedrock", undefined)).toBe(600_000)
  })

  test("returns 0 when explicitly disabled with false", () => {
    expect(resolveChunkTimeout("github-copilot", false)).toBe(0)
  })

  test("returns the user value when a positive number", () => {
    expect(resolveChunkTimeout("github-copilot", 60_000)).toBe(60_000)
  })

  test("falls back to provider default for non-numeric junk", () => {
    // Defensive branch — config schema prevents this, but runtime check guards misconfig.
    expect(resolveChunkTimeout("github-copilot", "not-a-number" as never)).toBe(120_000)
  })
})

describe("provider.wrapSSE — SSEStallError integration", () => {
  test("throws SSEStallError when chunk read exceeds timeout", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // deliberately emit nothing
      },
    })
    const res = new Response(stream, { headers: { "content-type": "text/event-stream" } })
    const ctl = new AbortController()
    const wrapped = wrapSSE(res, 50, ctl)
    const reader = wrapped.body!.getReader()
    let err: unknown
    await reader.read().catch((e: unknown) => {
      err = e
    })
    expect(err).toBeInstanceOf(SSEStallError)
    expect((err as Error).message).toContain("SSE read timed out")
  })

  test("does not wrap non-SSE responses", () => {
    const res = new Response("hello", { headers: { "content-type": "text/plain" } })
    const ctl = new AbortController()
    expect(wrapSSE(res, 50, ctl)).toBe(res)
  })

  test("returns original response when ms <= 0", () => {
    const res = new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
    const ctl = new AbortController()
    expect(wrapSSE(res, 0, ctl)).toBe(res)
    expect(wrapSSE(res, -1, ctl)).toBe(res)
  })
})
