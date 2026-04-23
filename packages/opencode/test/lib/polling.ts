// Generic "wait for predicate" helper for test fiber synchronization.
// Replaces per-file bespoke waitForXxx polling loops so the polling
// interval + timeout budget stays consistent across the suite.

import { Effect, Option } from "effect"

export interface PollOptions {
  readonly iterations?: number     // default 100
  readonly intervalMillis?: number // default 10
  readonly label?: string          // for timeout error message
}

export function pollUntil<A, E, R>(
  probe: () => Effect.Effect<Option.Option<A>, E, R>,
  opts: PollOptions = {},
): Effect.Effect<A, E | Error, R> {
  const iterations = opts.iterations ?? 100
  const interval = `${opts.intervalMillis ?? 10} millis` as const
  const label = opts.label ?? "pollUntil predicate"
  return Effect.gen(function* () {
    if (!Number.isInteger(iterations) || iterations < 0) {
      return yield* Effect.fail(
        new Error(`invalid iterations for ${label}: expected a non-negative integer, got ${String(iterations)}`),
      )
    }
    for (let i = 0; i < iterations; i++) {
      const value = yield* probe()
      if (Option.isSome(value)) return value.value
      yield* Effect.sleep(interval)
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${label}`))
  })
}

export function pollForLength<A, E, R>(
  probe: () => Effect.Effect<ReadonlyArray<A>, E, R>,
  count: number,
  opts: PollOptions = {},
): Effect.Effect<ReadonlyArray<A>, E | Error, R> {
  const label = opts.label ?? `list length=${count}`
  return Effect.gen(function* () {
    if (!Number.isInteger(count) || count < 0) {
      return yield* Effect.fail(
        new Error(`invalid count for ${label}: expected a non-negative integer, got ${String(count)}`),
      )
    }
    return yield* pollUntil(
      () =>
        Effect.gen(function* () {
          const list = yield* probe()
          return list.length === count ? Option.some(list) : Option.none()
        }),
      { ...opts, label },
    )
  })
}
