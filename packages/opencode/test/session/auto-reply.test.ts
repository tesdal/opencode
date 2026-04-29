import { describe, expect } from "bun:test"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import { pollForLength, pollUntil } from "../lib/polling"
import { Question } from "../../src/question"
import { Permission } from "../../src/permission"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { SessionID } from "../../src/session/schema"
import { MAX_LINEAGE_DEPTH, SessionAutoReply } from "../../src/session/auto-reply/auto-reply"
import { AutoReplySink } from "../../src/session/auto-reply/sink"

const it = testEffect(
  Layer.mergeAll(
    Question.defaultLayer,
    Permission.defaultLayer,
    Session.defaultLayer,
    Bus.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

// Test sink that captures every Sink event into a single ordered array. Lets
// jsonMode-equivalent tests assert on the auto-reject/auto-approve contract
// without monkey-patching process.stdout (the previous RunEvents test pattern).
type CapturedEvent =
  | { readonly type: "auto-reject"; readonly kind: "question" | "permission"; readonly sessionID: SessionID; readonly total: number }
  | { readonly type: "auto-approve"; readonly kind: "permission"; readonly sessionID: SessionID; readonly total: number }
  | { readonly type: "livelock-warn"; readonly rootSessionID: SessionID }

function captureSink() {
  const events: CapturedEvent[] = []
  const sink: AutoReplySink.Sink = {
    onAutoReject: (input) =>
      events.push({ type: "auto-reject", kind: input.kind, sessionID: input.sessionID, total: input.total }),
    onAutoApprove: (input) =>
      events.push({ type: "auto-approve", kind: input.kind, sessionID: input.sessionID, total: input.total }),
    onLivelockWarn: (input) => events.push({ type: "livelock-warn", rootSessionID: input.rootSessionID }),
  }
  return { sink, events }
}

describe("session/auto-reply", () => {
  it.live("auto-rejects question.asked for the root session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const rootSessionID = SessionID.make("ses_root_0000000000000000000000")
        const handler = yield* SessionAutoReply.make(
          { rootSessionID, skipPermissions: false },
          AutoReplySink.silentSink,
        )

        const result = yield* Effect.exit(
          question.ask({
            sessionID: rootSessionID,
            questions: [
              {
                question: "color?",
                header: "h",
                options: [{ label: "red", description: "r" }],
              },
            ],
          }),
        )

        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBeInstanceOf(Question.RejectedError)
        expect(handler.stats.autoRejectedQuestions).toBe(1)

        yield* Effect.sync(() => handler.unsubscribe())
      }),
    ),
  )

  it.live("auto-rejects question.asked for a descendant session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const session = yield* Session.Service
        const rootSessionID = SessionID.make("ses_root_desc_0000000000000000")
        const child = yield* session.create({ parentID: rootSessionID, title: "Child" })
        const handler = yield* SessionAutoReply.make(
          { rootSessionID, skipPermissions: false },
          AutoReplySink.silentSink,
        )

        const result = yield* Effect.exit(
          question.ask({
            sessionID: child.id,
            questions: [
              {
                question: "size?",
                header: "h",
                options: [{ label: "small", description: "s" }],
              },
            ],
          }),
        )

        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBeInstanceOf(Question.RejectedError)
        expect(handler.stats.autoRejectedQuestions).toBe(1)

        yield* Effect.sync(() => handler.unsubscribe())
      }),
    ),
  )

  it.live("auto-rejects question.asked across a grandchild lineage walk", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const session = yield* Session.Service
        const rootSessionID = SessionID.make("ses_root_grandchild_0000000000000")
        const middle = yield* session.create({ parentID: rootSessionID, title: "Middle" })
        const child = yield* session.create({ parentID: middle.id, title: "Grandchild" })
        const handler = yield* SessionAutoReply.make(
          { rootSessionID, skipPermissions: false },
          AutoReplySink.silentSink,
        )

        const childResult = yield* Effect.exit(
          question.ask({
            sessionID: child.id,
            questions: [
              {
                question: "first?",
                header: "h",
                options: [{ label: "a", description: "a" }],
              },
            ],
          }),
        )

        expect(Exit.isFailure(childResult)).toBe(true)
        if (Exit.isFailure(childResult)) {
          expect(Cause.squash(childResult.cause)).toBeInstanceOf(Question.RejectedError)
        }

        const middleResult = yield* Effect.exit(
          question.ask({
            sessionID: middle.id,
            questions: [
              {
                question: "second?",
                header: "h",
                options: [{ label: "b", description: "b" }],
              },
            ],
          }),
        )

        expect(Exit.isFailure(middleResult)).toBe(true)
        if (Exit.isFailure(middleResult)) {
          expect(Cause.squash(middleResult.cause)).toBeInstanceOf(Question.RejectedError)
        }
        expect(handler.stats.autoRejectedQuestions).toBe(2)

        yield* Effect.sync(() => handler.unsubscribe())
      }),
    ),
  )

  it.live("ignores question.asked for an unrelated session tree", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const rootSessionID = SessionID.make("ses_root_unrelated_000000000000")
        const unrelatedSessionID = SessionID.make("ses_unrelated_000000000000000")
        const handler = yield* SessionAutoReply.make(
          { rootSessionID, skipPermissions: false },
          AutoReplySink.silentSink,
        )

        const fiber = yield* question
          .ask({
            sessionID: unrelatedSessionID,
            questions: [
              {
                question: "animal?",
                header: "h",
                options: [{ label: "cat", description: "c" }],
              },
            ],
          })
          .pipe(Effect.forkScoped)

        const pending = yield* pollForLength(() => question.list(), 1)

        expect(handler.stats.autoRejectedQuestions).toBe(0)
        expect(pending[0].sessionID).toBe(unrelatedSessionID)

        yield* question.reject(pending[0].id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Question.RejectedError)

        yield* Effect.sync(() => handler.unsubscribe())
      }),
    ),
  )

  it.live("does not auto-reject when lineage depth exceeds MAX_LINEAGE_DEPTH", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const session = yield* Session.Service
        const rootSessionID = SessionID.make("ses_root_depth_cutoff_000000000000")
        const handler = yield* SessionAutoReply.make(
          { rootSessionID, skipPermissions: false },
          AutoReplySink.silentSink,
        )

        const createDeepChild = (parentID: SessionID, remaining: number): Effect.Effect<SessionID> => {
          if (remaining === 0) return Effect.succeed(parentID)
          return session
            .create({ parentID, title: "Depth child" })
            .pipe(Effect.flatMap((created) => createDeepChild(created.id, remaining - 1)))
        }

        const deepSessionID = yield* createDeepChild(rootSessionID, MAX_LINEAGE_DEPTH + 1)
        const fiber = yield* question
          .ask({
            sessionID: deepSessionID,
            questions: [
              {
                question: "deep?",
                header: "h",
                options: [{ label: "n", description: "n" }],
              },
            ],
          })
          .pipe(Effect.forkScoped)

        const pending = yield* pollForLength(() => question.list(), 1)
        expect(pending[0].sessionID).toBe(deepSessionID)
        expect(handler.stats.autoRejectedQuestions).toBe(0)

        yield* question.reject(pending[0].id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Question.RejectedError)

        yield* Effect.sync(() => handler.unsubscribe())
      }),
    ),
  )

  it.live("Config does not expose attach or jsonMode fields", () =>
    Effect.sync(() => {
      const validConfig: SessionAutoReply.Config = {
        rootSessionID: SessionID.make("ses_root_cfg_0000000000000000000"),
        skipPermissions: false,
      }
      void validConfig

      const invalidConfig: SessionAutoReply.Config = {
        rootSessionID: SessionID.make("ses_root_cfg_0000000000000000001"),
        skipPermissions: false,
        // @ts-expect-error attach mode is represented by not creating SessionAutoReply,
        // and jsonMode is now a caller (run.ts) sink concern, not core config
        attach: true,
        jsonMode: true,
      }
      void invalidConfig
    }),
  )

  it.live("auto-rejects permission.asked for descendant sessions", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const session = yield* Session.Service
        const rootSessionID = SessionID.make("ses_root_perm_desc_000000000000")
        const child = yield* session.create({ parentID: rootSessionID, title: "Child" })
        const handler = yield* SessionAutoReply.make(
          { rootSessionID, skipPermissions: false },
          AutoReplySink.silentSink,
        )

        const fiber = yield* permission
          .ask({
            sessionID: child.id,
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            always: [],
            ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
          })
          .pipe(Effect.forkScoped)

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Permission.RejectedError)
        expect(handler.stats.autoRejectedPermissions).toBe(1)

        yield* Effect.sync(() => handler.unsubscribe())
      }),
    ),
  )

  it.live("auto-approves permission.asked when skipPermissions=true", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const session = yield* Session.Service
        const rootSessionID = SessionID.make("ses_root_skip_perm_000000000000")
        const child = yield* session.create({ parentID: rootSessionID, title: "Child" })
        const handler = yield* SessionAutoReply.make(
          { rootSessionID, skipPermissions: true },
          AutoReplySink.silentSink,
        )

        const exit = yield* Effect.exit(
          permission.ask({
            sessionID: child.id,
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            always: [],
            ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
          }),
        )

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(handler.stats.autoRejectedPermissions).toBe(0)
        expect(yield* permission.list()).toHaveLength(0)

        yield* Effect.sync(() => handler.unsubscribe())
      }),
    ),
  )

  it.live("does not cache unrelated walks as descendants for permission.asked", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const session = yield* Session.Service
        const rootSessionID = SessionID.make("ses_root_cache_guard_0000000000000")
        const unrelatedRootSessionID = SessionID.make("ses_unrelated_root_000000000000")
        const x = yield* session.create({ parentID: unrelatedRootSessionID, title: "X" })
        const y = yield* session.create({ parentID: x.id, title: "Y" })
        const handler = yield* SessionAutoReply.make(
          { rootSessionID, skipPermissions: false },
          AutoReplySink.silentSink,
        )

        const askPermission = (sessionID: SessionID) =>
          permission.ask({
            sessionID,
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            always: [],
            ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
          })

        const yFiber = yield* askPermission(y.id).pipe(Effect.forkScoped)
        const firstPending = yield* pollForLength(() => permission.list(), 1)
        expect(firstPending[0].sessionID).toBe(y.id)
        expect(handler.stats.autoRejectedPermissions).toBe(0)
        yield* permission.reply({ requestID: firstPending[0].id, reply: "once" })
        const yExit = yield* Fiber.await(yFiber)
        expect(Exit.isSuccess(yExit)).toBe(true)

        const xFiber = yield* askPermission(x.id).pipe(Effect.forkScoped)
        const secondPending = yield* pollForLength(() => permission.list(), 1)
        expect(secondPending[0].sessionID).toBe(x.id)
        expect(handler.stats.autoRejectedPermissions).toBe(0)
        yield* permission.reply({ requestID: secondPending[0].id, reply: "once" })
        const xExit = yield* Fiber.await(xFiber)
        expect(Exit.isSuccess(xExit)).toBe(true)

        const descendant = yield* session.create({ parentID: rootSessionID, title: "Descendant" })
        const descendantExit = yield* Effect.exit(askPermission(descendant.id))
        expect(Exit.isFailure(descendantExit)).toBe(true)
        if (Exit.isFailure(descendantExit)) {
          expect(Cause.squash(descendantExit.cause)).toBeInstanceOf(Permission.RejectedError)
        }
        expect(handler.stats.autoRejectedPermissions).toBe(1)

        yield* Effect.sync(() => handler.unsubscribe())
      }),
    ),
  )

  it.live("auto-approves permission.asked for the root when skipPermissions=true", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const bus = yield* Bus.Service
        const rootSessionID = SessionID.make("ses_root_skip_perm_root_000000000")
        const replies: Array<{ sessionID: SessionID; reply: string }> = []
        const unsubscribeReply = yield* bus.subscribeCallback(Permission.Event.Replied, (evt) => {
          replies.push({ sessionID: evt.properties.sessionID, reply: evt.properties.reply })
        })
        const handler = yield* SessionAutoReply.make(
          { rootSessionID, skipPermissions: true },
          AutoReplySink.silentSink,
        )

        const exit = yield* Effect.exit(
          permission.ask({
            sessionID: rootSessionID,
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            always: [],
            ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
          }),
        )

        yield* pollUntil(
          () => Effect.sync(() => (replies.length === 1 ? Option.some(true) : Option.none())),
          { label: "permission.replied event" },
        )

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(handler.stats.autoRejectedPermissions).toBe(0)
        expect(replies[0]?.sessionID).toBe(rootSessionID)
        expect(replies[0]?.reply).toBe("once")
        expect(yield* permission.list()).toHaveLength(0)

        yield* Effect.sync(() => {
          unsubscribeReply()
          handler.unsubscribe()
        })
      }),
    ),
  )

  // F11: jsonMode emission moved out of the core into run.ts's sink. The core
  // contract is now "Sink.onAutoReject is invoked with the right shape" — JSON
  // serialization is verified separately by the run.ts sink builder. This
  // replaces the previous stdout-monkey-patching jsonMode test.
  it.live("calls Sink.onAutoReject with kind='question' on auto-reject", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const rootSessionID = SessionID.make("ses_root_sink_reject_000000000000")
        const captured = captureSink()

        yield* Effect.acquireUseRelease(
          SessionAutoReply.make({ rootSessionID, skipPermissions: false }, captured.sink),
          (handle) =>
            Effect.gen(function* () {
              const result = yield* Effect.exit(
                question.ask({
                  sessionID: rootSessionID,
                  questions: [
                    {
                      question: "json?",
                      header: "h",
                      options: [{ label: "yes", description: "y" }],
                    },
                  ],
                }),
              )
              expect(Exit.isFailure(result)).toBe(true)
              expect(handle.stats.autoRejectedQuestions).toBe(1)
            }),
          (handle) => Effect.sync(() => handle.unsubscribe()),
        )

        expect(captured.events).toHaveLength(1)
        expect(captured.events[0]).toEqual({
          type: "auto-reject",
          kind: "question",
          sessionID: rootSessionID,
          total: 1,
        })
      }),
    ),
  )

  it.live("sets livelockWarned=true and calls onLivelockWarn on the 6th cumulative auto-reject", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const rootSessionID = SessionID.make("ses_root_livelock_000000000000000")
        const captured = captureSink()
        const handler = yield* SessionAutoReply.make(
          { rootSessionID, skipPermissions: false },
          captured.sink,
        )

        const askOnce = () =>
          Effect.exit(
            question.ask({
              sessionID: rootSessionID,
              questions: [
                {
                  question: "loop?",
                  header: "h",
                  options: [{ label: "n", description: "n" }],
                },
              ],
            }),
          )

        const firstFiveExits = yield* Effect.all(Array.from({ length: 5 }, askOnce), {
          concurrency: 1,
        })
        expect(firstFiveExits.every(Exit.isFailure)).toBe(true)
        expect(handler.stats.livelockWarned).toBe(false)
        expect(captured.events.filter((e) => e.type === "livelock-warn")).toHaveLength(0)

        const sixthExit = yield* askOnce()
        expect(Exit.isFailure(sixthExit)).toBe(true)
        expect(handler.stats.autoRejectedQuestions).toBe(6)
        expect(handler.stats.livelockWarned).toBe(true)

        const livelockEvents = captured.events.filter((e) => e.type === "livelock-warn")
        expect(livelockEvents).toHaveLength(1)
        expect(livelockEvents[0]).toEqual({ type: "livelock-warn", rootSessionID })

        yield* Effect.sync(() => handler.unsubscribe())
      }),
    ),
  )

  // Lifecycle test for F7 fiber-tracking: after unsubscribe(), late-arriving
  // bus callbacks must not produce new auto-rejects. This exercises both the
  // bus unsubscription path and the `closed` flag in fork() that prevents
  // late callbacks from forking new handler fibers after teardown has begun.
  it.live("does not auto-reject question.asked after unsubscribe()", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const rootSessionID = SessionID.make("ses_root_post_unsub_000000000000")
        const handler = yield* SessionAutoReply.make(
          { rootSessionID, skipPermissions: false },
          AutoReplySink.silentSink,
        )
        yield* Effect.sync(() => handler.unsubscribe())

        // Ask after unsubscribe — without the bus subscription, no auto-reject
        // handler runs and the question stays pending.
        const fiber = yield* question
          .ask({
            sessionID: rootSessionID,
            questions: [{ question: "post?", header: "h", options: [{ label: "x", description: "x" }] }],
          })
          .pipe(Effect.forkScoped)

        const pending = yield* pollForLength(() => question.list(), 1)
        expect(pending[0].sessionID).toBe(rootSessionID)
        expect(handler.stats.autoRejectedQuestions).toBe(0)

        // Give any late async bus callbacks a chance to run, then verify the
        // question is still pending and no auto-reject occurred.
        yield* Effect.sleep("50 millis")
        const stillPending = yield* question.list()
        expect(stillPending).toHaveLength(1)
        expect(stillPending[0].id).toBe(pending[0].id)
        expect(stillPending[0].sessionID).toBe(rootSessionID)
        expect(handler.stats.autoRejectedQuestions).toBe(0)

        // Manually clear the pending question so the test can finish.
        yield* question.reject(pending[0].id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ),
  )

  // F8: when skipPermissions=true the auto-approve branch must produce symmetric
  // telemetry — Stats counter + Sink event — so operators running
  // --dangerously-skip-permissions get an audit trail of what was approved.
  it.live("increments autoApprovedPermissions and calls Sink.onAutoApprove when skipPermissions=true", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const bus = yield* Bus.Service
        const rootSessionID = SessionID.make("ses_root_auto_approve_0000000000000")
        const replies: Array<{ sessionID: SessionID; reply: string }> = []
        const unsubscribeReply = yield* bus.subscribeCallback(Permission.Event.Replied, (evt) => {
          replies.push({ sessionID: evt.properties.sessionID, reply: evt.properties.reply })
        })
        const captured = captureSink()

        yield* Effect.acquireUseRelease(
          SessionAutoReply.make({ rootSessionID, skipPermissions: true }, captured.sink),
          (handle) =>
            Effect.gen(function* () {
              const exit = yield* Effect.exit(
                permission.ask({
                  sessionID: rootSessionID,
                  permission: "bash",
                  patterns: ["ls"],
                  metadata: {},
                  always: [],
                  ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
                }),
              )

              yield* pollUntil(
                () => Effect.sync(() => (replies.length === 1 ? Option.some(true) : Option.none())),
                { label: "permission.replied event" },
              )

              expect(Exit.isSuccess(exit)).toBe(true)
              expect(replies[0]?.reply).toBe("once")
              expect(handle.stats.autoApprovedPermissions).toBe(1)
              expect(handle.stats.autoRejectedPermissions).toBe(0)
            }),
          (handle) =>
            Effect.sync(() => {
              unsubscribeReply()
              handle.unsubscribe()
            }),
        )

        expect(captured.events).toHaveLength(1)
        expect(captured.events[0]).toEqual({
          type: "auto-approve",
          kind: "permission",
          sessionID: rootSessionID,
          total: 1,
        })
      }),
    ),
  )
})
