import { describe, expect, test } from "bun:test"
import { dispatchPermissionAsked, replyPermissionAttachMode } from "../../src/cli/cmd/run"

// In attach mode, `runEventsHandle` is null because the local `opencode run --attach`
// process is just an SSE viewer of a remote opencode server — and that server does
// not currently spin up its own RunEvents handler. So the local SSE-loop branch is
// the only auto-responder for `permission.asked` events. F10 collapses the dispatch
// into `dispatchPermissionAsked`; these tests pin the contract that:
//   - non-attach (hasRunEventsHandle=true) NEVER calls sdk.permission.reply
//   - attach (hasRunEventsHandle=false) calls sdk.permission.reply EXACTLY ONCE
// per permission.asked event matching the active sessionID.

type ReplyCall = { requestID: string; reply: "once" | "always" | "reject" }

function makeStubSdk() {
  const calls: ReplyCall[] = []
  return {
    sdk: {
      permission: {
        reply: async (input: { requestID: string; reply: "once" | "always" | "reject" }) => {
          calls.push({ requestID: input.requestID, reply: input.reply })
          return { data: undefined }
        },
      },
    },
    calls,
  }
}

const ROOT_SESSION = "ses_root_0000000000000000000000"

const askedEvent = {
  id: "perm_abc",
  sessionID: ROOT_SESSION,
  permission: "bash",
  patterns: ["rm -rf /"],
}

describe("cli/run replyPermissionAttachMode (helper unit tests)", () => {
  test("dangerously-skip-permissions=true: replies once, no UI", async () => {
    const { sdk, calls } = makeStubSdk()
    const printed: string[] = []

    await replyPermissionAttachMode({
      sdk,
      permission: askedEvent,
      skipPermissions: true,
      jsonMode: false,
      println: (msg) => printed.push(msg),
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ requestID: "perm_abc", reply: "once" })
    expect(printed).toEqual([])
  })

  test("dangerously-skip-permissions=false, jsonMode=false: rejects and prints UI", async () => {
    const { sdk, calls } = makeStubSdk()
    const printed: string[] = []

    await replyPermissionAttachMode({
      sdk,
      permission: askedEvent,
      skipPermissions: false,
      jsonMode: false,
      println: (msg) => printed.push(msg),
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ requestID: "perm_abc", reply: "reject" })
    expect(printed).toHaveLength(1)
    expect(printed[0]).toContain("permission requested: bash")
    expect(printed[0]).toContain("rm -rf /")
    expect(printed[0]).toContain("auto-rejecting")
  })

  test("dangerously-skip-permissions=false, jsonMode=true: rejects without UI", async () => {
    const { sdk, calls } = makeStubSdk()
    const printed: string[] = []

    await replyPermissionAttachMode({
      sdk,
      permission: askedEvent,
      skipPermissions: false,
      jsonMode: true,
      println: (msg) => printed.push(msg),
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ requestID: "perm_abc", reply: "reject" })
    expect(printed).toEqual([])
  })
})

describe("cli/run dispatchPermissionAsked (dual-path contract)", () => {
  test("F10 invariant: non-attach (hasRunEventsHandle=true) NEVER calls sdk.permission.reply", async () => {
    const { sdk, calls } = makeStubSdk()
    const printed: string[] = []

    const handled = await dispatchPermissionAsked({
      permission: askedEvent,
      sessionID: ROOT_SESSION,
      hasRunEventsHandle: true,
      sdk,
      skipPermissions: false,
      jsonMode: false,
      println: (msg) => printed.push(msg),
    })

    expect(handled).toBe(true)
    // The defining invariant: when RunEvents is active in-process, the SSE loop
    // must NOT also reply via SDK or both responders fire on the same event.
    expect(calls).toHaveLength(0)
    expect(printed).toHaveLength(1)
    expect(printed[0]).toContain("auto-rejecting")
  })

  test("non-attach + skipPermissions: still no SDK reply, and no UI line (RunEvents owns both)", async () => {
    const { sdk, calls } = makeStubSdk()
    const printed: string[] = []

    await dispatchPermissionAsked({
      permission: askedEvent,
      sessionID: ROOT_SESSION,
      hasRunEventsHandle: true,
      sdk,
      skipPermissions: true,
      jsonMode: false,
      println: (msg) => printed.push(msg),
    })

    expect(calls).toHaveLength(0)
    expect(printed).toEqual([])
  })

  test("non-attach + jsonMode: still no SDK reply, no UI line (RunEvents emits JSON)", async () => {
    const { sdk, calls } = makeStubSdk()
    const printed: string[] = []

    await dispatchPermissionAsked({
      permission: askedEvent,
      sessionID: ROOT_SESSION,
      hasRunEventsHandle: true,
      sdk,
      skipPermissions: false,
      jsonMode: true,
      println: (msg) => printed.push(msg),
    })

    expect(calls).toHaveLength(0)
    expect(printed).toEqual([])
  })

  test("F10 invariant: attach (hasRunEventsHandle=false) replies EXACTLY ONCE", async () => {
    const { sdk, calls } = makeStubSdk()
    const printed: string[] = []

    const handled = await dispatchPermissionAsked({
      permission: askedEvent,
      sessionID: ROOT_SESSION,
      hasRunEventsHandle: false,
      sdk,
      skipPermissions: false,
      jsonMode: false,
      println: (msg) => printed.push(msg),
    })

    expect(handled).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ requestID: "perm_abc", reply: "reject" })
  })

  test("filters out events for non-active sessions and does not reply or log", async () => {
    const { sdk, calls } = makeStubSdk()
    const printed: string[] = []

    const handled = await dispatchPermissionAsked({
      permission: { ...askedEvent, sessionID: "ses_other_0000000000000000000000" },
      sessionID: ROOT_SESSION,
      hasRunEventsHandle: false,
      sdk,
      skipPermissions: false,
      jsonMode: false,
      println: (msg) => printed.push(msg),
    })

    expect(handled).toBe(false)
    expect(calls).toEqual([])
    expect(printed).toEqual([])
  })

  test("non-attach branch is inert under all flag combinations: even invoked alongside the attach branch on one event, total replies = 1", async () => {
    // The F10 invariant is enforced by the call site (one dispatch per event).
    // This test pins the *dispatcher* contract that makes that enforcement
    // possible: regardless of skipPermissions/jsonMode, the non-attach branch
    // must never reply via SDK. If a future change accidentally fans the
    // non-attach branch out to also call sdk.permission.reply, this test fails.
    const { sdk, calls } = makeStubSdk()

    await dispatchPermissionAsked({
      permission: askedEvent,
      sessionID: ROOT_SESSION,
      hasRunEventsHandle: true,
      sdk,
      skipPermissions: false,
      jsonMode: true,
      println: () => {},
    })
    await dispatchPermissionAsked({
      permission: askedEvent,
      sessionID: ROOT_SESSION,
      hasRunEventsHandle: false,
      sdk,
      skipPermissions: false,
      jsonMode: true,
      println: () => {},
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].requestID).toBe("perm_abc")
  })
})
