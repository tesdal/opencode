import type { SessionID } from "../schema"

/**
 * Sink interface for auto-reply telemetry. The auto-reply core is intentionally
 * unaware of how/where these events surface (stdout JSON, structured logger,
 * test capture, ACP transport, …) so it can be reused across CLI run mode,
 * future TUI headless / daemon mode, and ACP without dragging emission policy
 * into the bus-subscription core.
 *
 * Each method is fire-and-forget — synchronous, no return value. Implementations
 * that need async work (network emit, etc.) should fire-and-forget internally;
 * the bus dispatch path can not block on emission.
 *
 * **Contract: callbacks must not throw.** Sink invocations happen inside the
 * auto-reply fiber *before* the `question.reject` / `permission.reply` side
 * effects. A throwing sink would fail the fiber and skip the side effect, so
 * the auto-reply contract (subagent always gets a response) would silently
 * break. If a sink target can fail (closed pipe, network error, full disk),
 * the implementation must catch the failure internally and either drop the
 * event or buffer it. The core does not wrap callbacks in try/catch.
 */
export type Sink = {
  readonly onAutoReject: (input: {
    readonly kind: "question" | "permission"
    readonly sessionID: SessionID
    readonly total: number
  }) => void
  readonly onAutoApprove: (input: {
    readonly kind: "permission"
    readonly sessionID: SessionID
    readonly total: number
  }) => void
  readonly onLivelockWarn: (input: { readonly rootSessionID: SessionID }) => void
}

/**
 * No-op sink. Intended for tests and contexts that only care about the Stats
 * counters on the returned handle (e.g. F12 regression-test reuse).
 */
export const silentSink: Sink = {
  onAutoReject: () => {},
  onAutoApprove: () => {},
  onLivelockWarn: () => {},
}

export * as AutoReplySink from "./sink"
