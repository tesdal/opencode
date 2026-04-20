import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Question } from "../../src/question"
import { Permission } from "../../src/permission"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { SessionID } from "../../src/session/schema"
import { RunEvents } from "../../src/cli/cmd/run-events"

const it = testEffect(
  Layer.mergeAll(Question.defaultLayer, Permission.defaultLayer, Session.defaultLayer, Bus.defaultLayer),
)

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

        const result = yield* Effect.either(
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

        expect(result._tag).toBe("Left")
        expect(handler.stats.autoRejectedQuestions).toBe(1)

        yield* Effect.sync(() => handler.unsubscribe())
      }),
    ),
  )
})
