// Phase C regression gates for the subagent-hang hardening effort.
//
//   1. SSE stall: Phase A's wrapSSE must convert a stalled stream into
//      SSEStallError, which SessionRetry classifies as transport-retryable
//      and surfaces as a `retry` SessionStatus. Gates against indefinite hangs.
//   2. Subagent question in headless: Phase B's Question→Bus publish +
//      Question.reject→Deferred.fail contract must allow an external
//      subscriber (mirroring RunEvents) to unblock a subagent question tool.
//      Gates against headless deadlock when the user can't answer.

import { expect } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { Bus } from "../../src/bus"
import { Permission } from "../../src/permission"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Question } from "../../src/question"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Log } from "../../src/util"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply } from "../lib/llm-server"
import { makePromptLayer } from "../lib/prompt-harness"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const it = testEffect(makePromptLayer())

// Provider config matching `prompt-effect.test.ts` but with an aggressively
// short chunkTimeout so Test A surfaces `SSEStallError` within the 4s budget
// instead of the production default (120s / 600s).
function providerCfg(url: string, chunkTimeout?: number) {
  return {
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: {
          apiKey: "test-key",
          baseURL: url,
          ...(chunkTimeout !== undefined ? { chunkTimeout } : {}),
        },
      },
    },
  }
}

const user = Effect.fn("regression.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

it.live(
  "SSE stall triggers retry, not indefinite hang",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* (input) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const sessionStatus = yield* SessionStatus.Service

        // Queue an SSE reply that opens the stream (role chunk) then never
        // sends another frame. With chunkTimeout=1000ms the loop's wrapSSE
        // fires SSEStallError after ~1s, which the retry schedule catches
        // and converts into a status transition.
        yield* input.llm.push(reply().hang().item())

        const chat = yield* sessions.create({
          title: "SSE stall",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* user(chat.id, "trigger stall")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

        // Bounded wait for the retry transition. Budget covers: first
        // setup pass (cold provider state, models.dev load), one chunk
        // timeout (1s), plus schedule classification. If the fiber never
        // transitions to retry, the hang regression is back. `pollUnsafe` is
        // the public synchronous-peek API — we use it to short-circuit if
        // the fiber dies early so the error cause surfaces, rather than
        // timing out blindly at 12s.
        const observed = yield* Effect.gen(function* () {
          const end = Date.now() + 12_000
          while (Date.now() < end) {
            const exit = fiber.pollUnsafe()
            if (exit) return yield* Effect.fail(new Error(`loop exited before retry observed: ${JSON.stringify(exit)}`))
            const snap = yield* sessionStatus.get(chat.id)
            if (snap.type === "retry") return snap
            yield* Effect.sleep("25 millis")
          }
          const snap = yield* sessionStatus.get(chat.id)
          if (snap.type === "retry") return snap
          return yield* Effect.fail(
            new Error(`expected retry status within 12s; last status: ${JSON.stringify(snap)}`),
          )
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* prompt.cancel(chat.id).pipe(Effect.timeout("1 second"), Effect.ignore)
              yield* Fiber.interrupt(fiber).pipe(Effect.timeout("3 seconds"), Effect.ignore)
            }),
          ),
        )

        expect(observed.type).toBe("retry")
        expect(observed.attempt).toBeGreaterThanOrEqual(1)
        // SessionRetry.transportMessage populates the retry message from
        // SSEStallError.data.message ("SSE read timed out after 1000ms").
        expect(observed.message).toMatch(/SSE|timed out/i)

        // Cleanup runs via Effect.ensuring above so failures don't leak a live loop.
      }),
      { git: true, config: (url) => providerCfg(url, 1_000) },
    ),
  20_000,
)

it.live(
  "subagent question in headless run does not deadlock",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* (input) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const bus = yield* Bus.Service
        const question = yield* Question.Service
        const permission = yield* Permission.Service
        const sessionStatus = yield* SessionStatus.Service

        // Reply 1 (root): dispatch the task tool to spawn a subagent.
        yield* input.llm.tool("task", {
          description: "ask the user",
          prompt: "use the question tool to ask the user",
          subagent_type: "general",
        })
        // Reply 2 (subagent): call the question tool. Our bus subscriber
        // mirrors the RunEvents contract and rejects this question, which
        // unblocks the subagent's question tool with RejectedError.
        yield* input.llm.tool("question", {
          questions: [
            {
              question: "proceed?",
              header: "confirm",
              options: [
                { label: "yes", description: "go" },
                { label: "no", description: "stop" },
              ],
            },
          ],
        })
        // After question rejection the subagent's next call plus the root's
        // follow-up call fall through to the server's auto "ok"/stop
        // response, so no more queue entries are required.

        const chat = yield* sessions.create({
          title: "Subagent question",
          // Allow task + subagent. The question tool will fire regardless of
          // permission rules because the ask() path inside the tool publishes
          // `question.asked` directly. Allow-all keeps the focus on the
          // deadlock contract.
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* user(chat.id, "please ask something")

        // Mirror of RunEvents.make semantics (see src/cli/cmd/run-events.ts):
        // reject any question or permission raised on a descendant of the
        // root session. This test is a single root with one subagent, so we
        // reject indiscriminately — the production handler does parent-chain
        // lineage checks which are orthogonal to the hang contract.
        let questionsRejected = 0
        yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const unsubQuestion = yield* bus.subscribeCallback(Question.Event.Asked, (event) =>
              Effect.runPromise(
                Effect.gen(function* () {
                  questionsRejected += 1
                  yield* question.reject(event.properties.id)
                }),
              ),
            )
            const unsubPermission = yield* bus.subscribeCallback(Permission.Event.Asked, (event) =>
              Effect.runPromise(
                Effect.gen(function* () {
                  yield* permission.reply({ requestID: event.properties.id, reply: "reject" })
                }),
              ),
            )
            return { unsubQuestion, unsubPermission }
          }),
          (handles) =>
            Effect.sync(() => {
              handles.unsubQuestion()
              handles.unsubPermission()
            }),
        )

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

        // Primary gate: the root fiber must complete in bounded time and
        // succeed. Join under a 10s timeout that fails with a clear message
        // if the loop hangs. Exit check guards against silent defect paths —
        // a passing `pollUnsafe()` truthy check could miss these.
        const exit = yield* Fiber.await(fiber).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => Effect.die(new Error("root loop did not complete within 10s — subagent question likely deadlocked")),
          }),
        )
        expect(Exit.isSuccess(exit)).toBe(true)

        // Phase B contract: the subagent's question tool must have been
        // rejected at least once via the bus subscriber.
        expect(questionsRejected).toBeGreaterThanOrEqual(1)

        // The rejection must propagate into the subagent's tool output so
        // the parent (task tool) sees the failure. Walk the root + child
        // sessions and locate the question tool part — it must be in error
        // state with the RejectedError message.
        const children = yield* sessions.children(chat.id)
        const allSessionIDs = [chat.id, ...children.map((c) => c.id)]
        const questionErrors: string[] = []
        for (const sid of allSessionIDs) {
          const messages = yield* sessions.messages({ sessionID: sid })
          for (const msg of messages) {
            for (const part of msg.parts) {
              if (part.type === "tool" && part.tool === "question" && part.state.status === "error") {
                questionErrors.push(part.state.error)
              }
            }
          }
        }
        expect(questionErrors.length).toBeGreaterThanOrEqual(1)
        // Question.RejectedError.message => "The user dismissed this question".
        expect(questionErrors.some((e) => /dismissed/i.test(e))).toBe(true)

        // And the root session should settle idle (not stuck busy).
        const finalStatus = yield* sessionStatus.get(chat.id)
        expect(finalStatus.type).toBe("idle")
      }),
      { git: true, config: (url) => ({ ...providerCfg(url), agent: { general: { permission: { question: "allow" } } } }) },
    ),
  15_000,
)
