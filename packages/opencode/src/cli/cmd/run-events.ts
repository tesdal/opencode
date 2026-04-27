import { Cause, Effect, Fiber, Option } from "effect"
import { Bus } from "@/bus"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { Session } from "@/session"
import { NotFoundError } from "@/storage"
import { SessionID } from "@/session/schema"
import { Log } from "@/util"

const log = Log.create({ service: "run-events" })

export const LIVELOCK_WARN_THRESHOLD = 5
export const MAX_LINEAGE_DEPTH = 32

export interface Config {
  rootSessionID: SessionID
  skipPermissions: boolean
  jsonMode: boolean
}

export interface Stats {
  autoRejectedQuestions: number
  autoRejectedPermissions: number
  autoApprovedPermissions: number
  livelockWarned: boolean
}

export interface Handle {
  readonly stats: Stats
  readonly unsubscribe: () => void
}

export const make = Effect.fn("RunEvents.make")(function* (config: Config) {
  const question = yield* Question.Service
  const permission = yield* Permission.Service
  const bus = yield* Bus.Service
  const session = yield* Session.Service

  const stats: Stats = {
    autoRejectedQuestions: 0,
    autoRejectedPermissions: 0,
    autoApprovedPermissions: 0,
    livelockWarned: false,
  }

  const descendants = new Set<SessionID>([config.rootSessionID])

  const emit = (type: string, data: Record<string, unknown>) => {
    if (!config.jsonMode) return
    process.stdout.write(
      JSON.stringify({ type, timestamp: Date.now(), sessionID: config.rootSessionID, ...data }) + "\n",
    )
  }

  const isDescendant = Effect.fn("RunEvents.isDescendant")(function* (sid: SessionID) {
    if (descendants.has(sid)) return true
    let cur: SessionID | undefined = sid
    const chain: SessionID[] = []
    let depth = 0
    while (cur !== undefined && !descendants.has(cur) && depth < MAX_LINEAGE_DEPTH) {
      chain.push(cur)
      depth++
      const lookup: Option.Option<Session.Info> = yield* session.get(cur).pipe(
        Effect.option,
        Effect.catchDefect((defect) => {
          if (!NotFoundError.isInstance(defect)) return Effect.die(defect)
          return Effect.succeed(Option.none<Session.Info>())
        }),
      )
      if (Option.isNone(lookup)) break
      cur = lookup.value.parentID ?? undefined
    }
    if (cur === undefined || !descendants.has(cur)) return false
    chain.forEach((item) => descendants.add(item))
    return true
  })

  const bump = (kind: "question" | "permission", sid: SessionID) => {
    if (kind === "question") stats.autoRejectedQuestions++
    else stats.autoRejectedPermissions++
    const total = stats.autoRejectedQuestions + stats.autoRejectedPermissions
    emit("auto-reject", { kind, autoRejectSessionID: sid, totalAutoRejects: total })
    if (!stats.livelockWarned && total > LIVELOCK_WARN_THRESHOLD) {
      stats.livelockWarned = true
      log.warn("possible subagent livelock: >5 auto-rejects in a single run", {
        rootSessionID: config.rootSessionID,
      })
    }
  }

  // No question-equivalent of bumpApprove: questions are always auto-rejected
  // when they belong to our subagent lineage, never auto-approved. The approve
  // counter is also intentionally separate from the livelock total — operators
  // opt into skipPermissions and shouldn't trip the warn-threshold meant to
  // detect auto-reject loops.
  const bumpApprove = (sid: SessionID) => {
    stats.autoApprovedPermissions++
    emit("auto-approve", {
      kind: "permission",
      autoApproveSessionID: sid,
      totalAutoApproves: stats.autoApprovedPermissions,
    })
  }

  // bus.subscribeCallback wraps the callback in an Effect.tryPromise-based
  // subscription handler, so a Promise-returning callback (like Effect.runPromise)
  // serializes handler completion per subscription. runFork returns a Fiber
  // synchronously (non-thenable), unblocking dispatch so descendant question/
  // permission events are processed concurrently — important for long-running
  // subagent loops with many simultaneous descendants. Defects inside the forked
  // fiber do not surface through that subscription callback wrapper, so log them
  // here instead. Track in-flight fibers so unsubscribe() can interrupt them and
  // bound handler work to the RunEvents lifecycle.
  const inflight = new Set<Fiber.Fiber<void>>()
  let closed = false
  const fork = (effect: Effect.Effect<void>) => {
    if (closed) {
      // unsubscribe() already ran but bus subscription teardown is async, so
      // a late callback can still reach fork(). Skip starting the handler
      // entirely so no side effects (bump, reject, reply) leak past teardown.
      // Returning undefined (not a Promise) still unblocks the bus dispatch
      // wrapper without spawning a no-op fiber.
      return
    }
    const fiber = Effect.runFork(
      effect.pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.sync(() => log.error("handler failed", { cause })),
        ),
      ),
    )
    inflight.add(fiber)
    // Register cleanup outside the forked effect to avoid a TDZ/race between
    // synchronous fiber completion and inflight.add — Fiber.await observes
    // completion regardless of how fast the fiber runs.
    Effect.runFork(Fiber.await(fiber).pipe(Effect.ensuring(Effect.sync(() => inflight.delete(fiber)))))
  }

  const unsubQuestion = yield* bus.subscribeCallback(Question.Event.Asked, (evt) =>
    fork(
      Effect.gen(function* () {
        const mine = yield* isDescendant(evt.properties.sessionID)
        if (!mine) return
        bump("question", evt.properties.sessionID)
        yield* question.reject(evt.properties.id)
      }),
    ),
  )

  const unsubPermission = yield* bus.subscribeCallback(Permission.Event.Asked, (evt) =>
    fork(
      Effect.gen(function* () {
        const mine = yield* isDescendant(evt.properties.sessionID)
        if (!mine) return
        if (config.skipPermissions) {
          bumpApprove(evt.properties.sessionID)
          yield* permission.reply({ requestID: evt.properties.id, reply: "once" })
          return
        }
        bump("permission", evt.properties.sessionID)
        yield* permission.reply({ requestID: evt.properties.id, reply: "reject" })
      }),
    ),
  )

  const unsubscribe = () => {
    closed = true
    unsubQuestion()
    unsubPermission()
    inflight.forEach((fiber) => Effect.runFork(Fiber.interrupt(fiber)))
    // Don't clear() — let the per-fiber Fiber.await observers remove entries
    // as their interrupts settle, so any stragglers caught by the closed-flag
    // branch above still get cleaned up correctly.
  }

  return { stats, unsubscribe } satisfies Handle
})

export * as RunEvents from "./run-events"
