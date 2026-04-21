// Phase C regression gates for the subagent-hang hardening effort.
//
// Two failure modes this file pins down:
//
//   1. SSE stall = indefinite hang. If a provider starts a response and then
//      stops sending chunks, the loop used to block forever. Phase A wrapped
//      SSE bodies with `wrapSSE`, which raises `SSEStallError` on inter-chunk
//      timeout. `SSEStallError` is classified transport-retryable by
//      `SessionRetry.retryable` (see src/session/retry.ts:25) so the
//      processor's `Effect.retry(SessionRetry.policy(...))` observes it,
//      calls `SessionStatus.set({ type: "retry", ... })`, then backs off.
//      The `session.error` bus event only fires AFTER retries are exhausted
//      (5 transport attempts, 2+4+8+16+30s = 60s of backoff). This test
//      therefore gates on the retry transition — if the stall surfaced as
//      a terminal error instead, or hung indefinitely without triggering
//      retry, this test fails fast.
//
//   2. Subagent question in headless run = deadlock. A subagent that invokes
//      the `question` tool publishes `question.asked` and awaits an answer.
//      In `opencode run` (headless) there is no interactive client, so
//      Phase B added `RunEvents` which subscribes to the Bus and auto-rejects
//      descendant questions/permissions. Without that handler the loop
//      never returns. RunEvents lives in the CLI layer (see
//      `src/cli/cmd/run-events.ts` + `src/cli/cmd/run.ts`); it is NOT wired
//      into `SessionPrompt.loop` directly. This test therefore drives the
//      loop directly and mounts an in-test subscriber that mirrors the
//      RunEvents contract (reject descendant questions, reject permissions).
//      That still pins the end-to-end contract — if the Bus events are no
//      longer published, or Question.reject no longer unblocks the tool, or
//      the task-tool flow no longer propagates subagent completion back to
//      the parent, the test fails.
//
// Any change that makes either assertion fail is a regression.

import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "../../src/config"
import { LSP } from "../../src/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "../../src/provider"
import { Env } from "../../src/env"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "../../src/tool"
import { Truncate } from "../../src/tool"
import { Log } from "../../src/util"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in regression tests"),
    authenticate: () => Effect.die("unexpected MCP auth in regression tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in regression tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

// Copied verbatim from `prompt-effect.test.ts` — that file exports nothing,
// so we can't import the helper. Keeping the composition identical guarantees
// this regression gate exercises the same service wiring the rest of the
// loop tests do (real Session/SessionPrompt/ToolRegistry/Question/Permission,
// stubbed Summary/MCP/LSP).
function makeHttp() {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    AppFileSystem.defaultLayer,
    status,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps))
  const compact = SessionCompaction.layer.pipe(Layer.provideMerge(proc), Layer.provideMerge(deps))
  return Layer.mergeAll(
    TestLLMServer.layer,
    SessionPrompt.layer.pipe(
      Layer.provide(SessionRevert.defaultLayer),
      Layer.provide(summary),
      Layer.provideMerge(run),
      Layer.provideMerge(compact),
      Layer.provideMerge(proc),
      Layer.provideMerge(registry),
      Layer.provideMerge(trunc),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(SystemPrompt.defaultLayer),
      Layer.provideMerge(deps),
    ),
  ).pipe(Layer.provide(summary))
}

const it = testEffect(makeHttp())

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
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const sessionStatus = yield* SessionStatus.Service

        // Queue an SSE reply that opens the stream (role chunk) then never
        // sends another frame. With chunkTimeout=1000ms the loop's wrapSSE
        // fires SSEStallError after ~1s, which the retry schedule catches
        // and converts into a status transition.
        yield* llm.push(reply().hang().item())

        const chat = yield* sessions.create({
          title: "SSE stall",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* user(chat.id, "trigger stall")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

        // Bounded wait for the retry transition. Budget covers: first
        // setup pass (cold provider state, models.dev load), one chunk
        // timeout (1s), plus schedule classification. If the fiber never
        // transitions to retry, the hang regression is back.
        const observed = yield* Effect.promise(async () => {
          const end = Date.now() + 8_000
          while (Date.now() < end) {
            const exit = fiber.pollUnsafe()
            if (exit) {
              throw new Error(`loop exited before retry observed: ${JSON.stringify(exit)}`)
            }
            const snap = await Effect.runPromise(sessionStatus.get(chat.id))
            if (snap.type === "retry") return snap
            await new Promise((done) => setTimeout(done, 25))
          }
          const snap = await Effect.runPromise(sessionStatus.get(chat.id))
          throw new Error(`expected retry status within 8s; last status: ${JSON.stringify(snap)}`)
        })

        expect(observed.type).toBe("retry")
        expect(observed.attempt).toBeGreaterThanOrEqual(1)
        // SessionRetry.transportMessage populates the retry message from
        // SSEStallError.data.message ("SSE read timed out after 1000ms").
        expect(observed.message).toMatch(/SSE|timed out/i)

        // Stop the loop before the 2s exponential backoff fires a second
        // attempt (and another 1s stall) and blows the 15s test budget.
        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: (url) => providerCfg(url, 1_000) },
    ),
  20_000,
)

it.live(
  "subagent question in headless run does not deadlock",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const bus = yield* Bus.Service
        const question = yield* Question.Service
        const permission = yield* Permission.Service
        const sessionStatus = yield* SessionStatus.Service

        // Reply 1 (root): dispatch the task tool to spawn a subagent.
        yield* llm.tool("task", {
          description: "ask the user",
          prompt: "use the question tool to ask the user",
          subagent_type: "general",
        })
        // Reply 2 (subagent): call the question tool. Our bus subscriber
        // mirrors the RunEvents contract and rejects this question, which
        // unblocks the subagent's question tool with RejectedError.
        yield* llm.tool("question", {
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
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unsubQuestion()
            unsubPermission()
          }),
        )

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

        // Primary gate: the root fiber must complete in bounded time. If the
        // subagent's question tool were left blocked on an unanswered
        // deferred, this poll would never see the fiber finish. 10s upper
        // bound — the happy-path finish is well under a second.
        yield* Effect.promise(async () => {
          const end = Date.now() + 10_000
          while (Date.now() < end) {
            if (fiber.pollUnsafe()) return
            await new Promise((done) => setTimeout(done, 25))
          }
          throw new Error("root loop did not complete within 10s — subagent question likely deadlocked")
        })

        // Fiber completed. The subagent's question tool should have been
        // rejected at least once — that is the whole Phase B contract under
        // test.
        expect(questionsRejected).toBeGreaterThanOrEqual(1)
        // And the root session should settle idle (not stuck busy).
        const finalStatus = yield* sessionStatus.get(chat.id)
        expect(finalStatus.type).toBe("idle")

        yield* Fiber.await(fiber)
      }),
      { git: true, config: (url) => ({ ...providerCfg(url), agent: { general: { permission: { question: "allow" } } } }) },
    ),
  15_000,
)
