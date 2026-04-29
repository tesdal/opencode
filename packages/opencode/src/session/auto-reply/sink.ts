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
