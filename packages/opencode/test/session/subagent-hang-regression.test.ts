import { describe } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"

// Phase C regression gate — any future change that reintroduces either failure
// mode (SSE stall = indefinite hang; subagent question in headless run =
// deadlock) will fail these tests.
//
// Step 1: scaffold with `.skip`. Step 2 (next commit) fleshes out bodies using
// the test LLM server's `hang` helper and the Phase B auto-reject wiring.

const it = testEffect(Layer.empty)

describe("subagent hang regression", () => {
  it.live.skip("SSE stall triggers retry, not indefinite hang", () =>
    Effect.gen(function* () {
      // TODO(phase-c-2a): drive a stalling provider through SessionPrompt.loop.
      //   - provideTmpdirServer with llm.hang queued as first reply
      //   - configure chunkTimeout short enough to trip within test budget
      //   - assert session reaches session.error within 2x chunkTimeout
      //   - assert SessionStatus.set was called with attempt >= 1
    }),
  )

  it.live.skip("subagent question in headless run does not deadlock", () =>
    Effect.gen(function* () {
      // TODO(phase-c-2b): drive a provider that steers agent -> task -> subagent
      //   -> question in a single turn.
      //   - assert status.idle reached within N seconds (not indefinite)
      //   - assert tool-output contains the auto-rejection message from the
      //     Phase B handler (RunEvents auto-rejects descendant questions)
    }),
  )
})
