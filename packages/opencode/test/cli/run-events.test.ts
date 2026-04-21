import { describe, expect } from "bun:test"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Question } from "../../src/question"
import { Permission } from "../../src/permission"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { SessionID } from "../../src/session/schema"
import { MAX_LINEAGE_DEPTH, RunEvents } from "../../src/cli/cmd/run-events"

const it = testEffect(
  Layer.mergeAll(
    Question.defaultLayer,
    Permission.defaultLayer,
    Session.defaultLayer,
    Bus.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

const waitForQuestionCount = (
  question: Question.Interface,
  count: number,
): Effect.Effect<ReadonlyArray<Question.Request>, Error> =>
  Effect.gen(function* () {
    for (const _ of Array.from({ length: 100 })) {
      const pending = yield* question.list()
      if (pending.length === count) return pending
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${count} question(s)`))
  })

const waitForPermissionCount = (
  permission: Permission.Interface,
  count: number,
): Effect.Effect<ReadonlyArray<Permission.Request>, Error> =>
  Effect.gen(function* () {
    for (const _ of Array.from({ length: 100 })) {
      const pending = yield* permission.list()
      if (pending.length === count) return pending
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${count} permission(s)`))
  })

describe("cli/run-events", () => {
  it.live("auto-rejects question.asked for the root session (non-attach, non-json)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const rootSessionID = SessionID.make("ses_root_0000000000000000000000")
        const handler = yield* RunEvents.make({
          rootSessionID,
          skipPermissions: false,
          jsonMode: false,
        })

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
        const handler = yield* RunEvents.make({
          rootSessionID,
          skipPermissions: false,
          jsonMode: false,
        })

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
        const handler = yield* RunEvents.make({
          rootSessionID,
          skipPermissions: false,
          jsonMode: false,
        })

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
        const handler = yield* RunEvents.make({
          rootSessionID,
          skipPermissions: false,
          jsonMode: false,
        })

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

        const pending = yield* waitForQuestionCount(question, 1)

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
        const handler = yield* RunEvents.make({
          rootSessionID,
          skipPermissions: false,
          jsonMode: false,
        })

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

        const pending = yield* waitForQuestionCount(question, 1)
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

  it.live("RunEvents.Config does not expose an attach field", () =>
    Effect.sync(() => {
      const validConfig: RunEvents.Config = {
        rootSessionID: SessionID.make("ses_root_cfg_0000000000000000000"),
        skipPermissions: false,
        jsonMode: false,
      }
      void validConfig

      const invalidConfig: RunEvents.Config = {
        rootSessionID: SessionID.make("ses_root_cfg_0000000000000000001"),
        skipPermissions: false,
        jsonMode: false,
        // @ts-expect-error attach mode is represented by not creating RunEvents
        attach: true,
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
        const handler = yield* RunEvents.make({
          rootSessionID,
          skipPermissions: false,
          jsonMode: false,
        })

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
        const handler = yield* RunEvents.make({
          rootSessionID,
          skipPermissions: true,
          jsonMode: false,
        })

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
        const handler = yield* RunEvents.make({
          rootSessionID,
          skipPermissions: false,
          jsonMode: false,
        })

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
        const firstPending = yield* waitForPermissionCount(permission, 1)
        expect(firstPending[0].sessionID).toBe(y.id)
        expect(handler.stats.autoRejectedPermissions).toBe(0)
        yield* permission.reply({ requestID: firstPending[0].id, reply: "once" })
        const yExit = yield* Fiber.await(yFiber)
        expect(Exit.isSuccess(yExit)).toBe(true)

        const xFiber = yield* askPermission(x.id).pipe(Effect.forkScoped)
        const secondPending = yield* waitForPermissionCount(permission, 1)
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
        const handler = yield* RunEvents.make({
          rootSessionID,
          skipPermissions: true,
          jsonMode: false,
        })

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

        yield* Effect.gen(function* () {
          for (const _ of Array.from({ length: 100 })) {
            if (replies.length === 1) return
            yield* Effect.sleep("10 millis")
          }
          return yield* Effect.fail(new Error("timed out waiting for permission.replied event"))
        })

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

  it.live("emits structured JSON event to stdout when jsonMode=true", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const rootSessionID = SessionID.make("ses_root_json_00000000000000000000")
        const writes: string[] = []
        const originalWrite = process.stdout.write.bind(process.stdout)
        process.stdout.write = ((chunk: string | Uint8Array) => {
          writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
          return true
        }) as typeof process.stdout.write

        yield* Effect.acquireUseRelease(
          RunEvents.make({
            rootSessionID,
            skipPermissions: false,
            jsonMode: true,
          }),
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
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              process.stdout.write = originalWrite
            }),
          ),
        )

        const payload = JSON.parse((writes[0] ?? "").trim()) as {
          type: string
          timestamp: number
          sessionID: string
          kind: string
          autoRejectSessionID: string
          totalAutoRejects: number
        }

        expect(payload.type).toBe("auto-reject")
        expect(typeof payload.timestamp).toBe("number")
        expect(payload.sessionID).toBe(rootSessionID)
        expect(payload.kind).toBe("question")
        expect(payload.autoRejectSessionID).toBe(rootSessionID)
        expect(payload.totalAutoRejects).toBe(1)
      }),
    ),
  )

  it.live("sets livelockWarned=true on the 6th cumulative auto-reject", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const rootSessionID = SessionID.make("ses_root_livelock_000000000000000")
        const handler = yield* RunEvents.make({
          rootSessionID,
          skipPermissions: false,
          jsonMode: false,
        })

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

        const sixthExit = yield* askOnce()
        expect(Exit.isFailure(sixthExit)).toBe(true)
        expect(handler.stats.autoRejectedQuestions).toBe(6)
        expect(handler.stats.livelockWarned).toBe(true)

        yield* Effect.sync(() => handler.unsubscribe())
      }),
    ),
  )
})
