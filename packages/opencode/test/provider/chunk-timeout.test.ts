import { describe, expect, test } from "bun:test"
import { resolveChunkTimeout, SSEStallError, wrapSSE } from "../../src/provider/provider"

describe("provider.resolveChunkTimeout", () => {
  test("returns 120s default when undefined and reasoning=false", () => {
    expect(resolveChunkTimeout({ providerID: "github-copilot", reasoning: false }, undefined)).toBe(120_000)
  })

  test("returns 600s default when reasoning=true on anthropic", () => {
    expect(resolveChunkTimeout({ providerID: "anthropic", reasoning: true }, undefined)).toBe(600_000)
  })

  test("returns 600s default for reasoning=true regardless of provider ID (openrouter → anthropic/*)", () => {
    expect(resolveChunkTimeout({ providerID: "openrouter", reasoning: true }, undefined)).toBe(600_000)
  })

  test("returns 600s default when reasoning=true on google-vertex-anthropic", () => {
    expect(resolveChunkTimeout({ providerID: "google-vertex-anthropic", reasoning: true }, undefined)).toBe(600_000)
  })

  test("returns 600s default when reasoning=true on amazon-bedrock", () => {
    expect(resolveChunkTimeout({ providerID: "amazon-bedrock", reasoning: true }, undefined)).toBe(600_000)
  })

  test("returns 120s default when reasoning=false on anthropic (non-reasoning Claude)", () => {
    expect(resolveChunkTimeout({ providerID: "anthropic", reasoning: false }, undefined)).toBe(120_000)
  })

  test("returns 0 when explicitly disabled with false", () => {
    expect(resolveChunkTimeout({ providerID: "github-copilot", reasoning: false }, false)).toBe(0)
  })

  test("returns the user value when a positive number", () => {
    expect(resolveChunkTimeout({ providerID: "github-copilot", reasoning: false }, 60_000)).toBe(60_000)
  })

  test("explicit positive number wins over extended-thinking default", () => {
    expect(resolveChunkTimeout({ providerID: "anthropic", reasoning: true }, 30_000)).toBe(30_000)
  })

  test("false wins over extended-thinking default (returns 0)", () => {
    expect(resolveChunkTimeout({ providerID: "anthropic", reasoning: true }, false)).toBe(0)
  })

  test("falls back to model default for non-numeric junk", () => {
    // Defensive branch — config schema prevents this, but runtime check guards misconfig.
    expect(resolveChunkTimeout({ providerID: "github-copilot", reasoning: false }, "not-a-number" as never)).toBe(
      120_000,
    )
  })
})

describe("provider.wrapSSE — SSEStallError integration", () => {
  test("throws SSEStallError when chunk read exceeds timeout", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {}) // never resolves — forces stall
      },
    })
    const res = new Response(stream, { headers: { "content-type": "text/event-stream" } })
    const ctl = new AbortController()
    const wrapped = wrapSSE(res, 2, ctl)
    const reader = wrapped.body!.getReader()

    await expect(reader.read()).rejects.toBeInstanceOf(SSEStallError)
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
