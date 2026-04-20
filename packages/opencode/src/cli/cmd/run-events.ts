import { Effect, Option } from "effect"
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

  const unsubQuestion = yield* bus.subscribeCallback(Question.Event.Asked, (evt) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const mine = yield* isDescendant(evt.properties.sessionID)
        if (!mine) return
        bump("question", evt.properties.sessionID)
        yield* question.reject(evt.properties.id)
      }),
    ),
  )

  const unsubPermission = yield* bus.subscribeCallback(Permission.Event.Asked, (evt) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const mine = yield* isDescendant(evt.properties.sessionID)
        if (!mine) return
        if (config.skipPermissions) {
          yield* permission.reply({ requestID: evt.properties.id, reply: "once" })
          return
        }
        bump("permission", evt.properties.sessionID)
        yield* permission.reply({ requestID: evt.properties.id, reply: "reject" })
      }),
    ),
  )

  const unsubscribe = () => {
    unsubQuestion()
    unsubPermission()
  }

  return { stats, unsubscribe } satisfies Handle
})

export * as RunEvents from "./run-events"
