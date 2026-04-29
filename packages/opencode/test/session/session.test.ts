import { describe, expect, test } from "bun:test"
import path from "path"
import { Session as SessionNs } from "../../src/session"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util"
import { Instance } from "../../src/project/instance"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"

const projectRoot = path.join(__dirname, "../..")
void Log.init({ print: false })

function create(input?: SessionNs.CreateInput) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.create(input)))
}

function get(id: SessionID) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.get(id)))
}

function remove(id: SessionID) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.remove(id)))
}

function updateMessage<T extends MessageV2.Info>(msg: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
}

function updatePart<T extends MessageV2.Part>(part: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updatePart(part)))
}

describe("session.created event", () => {
  test("should emit session.created event when session is created", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let eventReceived = false
        let receivedInfo: SessionNs.Info | undefined

        const unsub = Bus.subscribe(SessionNs.Event.Created, (event) => {
          eventReceived = true
          receivedInfo = event.properties.info as SessionNs.Info
        })

        const info = await create({})
        await new Promise((resolve) => setTimeout(resolve, 100))
        unsub()

        expect(eventReceived).toBe(true)
        expect(receivedInfo).toBeDefined()
        expect(receivedInfo?.id).toBe(info.id)
        expect(receivedInfo?.projectID).toBe(info.projectID)
        expect(receivedInfo?.directory).toBe(info.directory)
        expect(receivedInfo?.title).toBe(info.title)

        await remove(info.id)
      },
    })
  })

  test("session.created event should be emitted before session.updated", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const events: string[] = []

        const unsubCreated = Bus.subscribe(SessionNs.Event.Created, () => {
          events.push("created")
        })

        const unsubUpdated = Bus.subscribe(SessionNs.Event.Updated, () => {
          events.push("updated")
        })

        const info = await create({})
        await new Promise((resolve) => setTimeout(resolve, 100))
        unsubCreated()
        unsubUpdated()

        expect(events).toContain("created")
        expect(events).toContain("updated")
        expect(events.indexOf("created")).toBeLessThan(events.indexOf("updated"))

        await remove(info.id)
      },
    })
  })
})

describe("step-finish token propagation via Bus event", () => {
  test(
    "non-zero tokens propagate through PartUpdated event",
    async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const info = await create({})

          const messageID = MessageID.ascending()
          await updateMessage({
            id: messageID,
            sessionID: info.id,
            role: "user",
            time: { created: Date.now() },
            agent: "user",
            model: { providerID: "test", modelID: "test" },
            tools: {},
            mode: "",
          } as unknown as MessageV2.Info)

          let received: MessageV2.Part | undefined
          const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
            received = event.properties.part
          })

          const tokens = {
            total: 1500,
            input: 500,
            output: 800,
            reasoning: 200,
            cache: { read: 100, write: 50 },
          }

          const partInput = {
            id: PartID.ascending(),
            messageID,
            sessionID: info.id,
            type: "step-finish" as const,
            reason: "stop",
            cost: 0.005,
            tokens,
          }

          await updatePart(partInput)
          await new Promise((resolve) => setTimeout(resolve, 100))

          expect(received).toBeDefined()
          expect(received!.type).toBe("step-finish")
          const finish = received as MessageV2.StepFinishPart
          expect(finish.tokens.input).toBe(500)
          expect(finish.tokens.output).toBe(800)
          expect(finish.tokens.reasoning).toBe(200)
          expect(finish.tokens.total).toBe(1500)
          expect(finish.tokens.cache.read).toBe(100)
          expect(finish.tokens.cache.write).toBe(50)
          expect(finish.cost).toBe(0.005)
          expect(received).not.toBe(partInput)

          unsub()
          await remove(info.id)
        },
      })
    },
    { timeout: 30000 },
  )
})

describe("Session", () => {
  test("remove works without an instance", async () => {
    await using tmp = await tmpdir({ git: true })

    const info = await Instance.provide({
      directory: tmp.path,
      fn: () => create({ title: "remove-without-instance" }),
    })

    await expect(async () => {
      await remove(info.id)
    }).not.toThrow()

    let missing = false
    await get(info.id).catch(() => {
      missing = true
    })

    expect(missing).toBe(true)
  })
})

function isDescendantOf(
  sid: SessionID,
  root: SessionID,
  opts?: { maxDepth?: number; cache?: Set<SessionID> },
) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.isDescendantOf(sid, root, opts)))
}

describe("Session.isDescendantOf", () => {
  test("identity: a session is its own descendant", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await create({ title: "root" })
        expect(await isDescendantOf(root.id, root.id)).toBe(true)
        await remove(root.id)
      },
    })
  })

  test("direct child is a descendant", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await create({ title: "root" })
        const child = await create({ title: "child", parentID: root.id })
        expect(await isDescendantOf(child.id, root.id)).toBe(true)
        await remove(root.id)
      },
    })
  })

  test("grandchild is a descendant", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await create({ title: "root" })
        const child = await create({ title: "child", parentID: root.id })
        const grandchild = await create({ title: "grandchild", parentID: child.id })
        expect(await isDescendantOf(grandchild.id, root.id)).toBe(true)
        await remove(root.id)
      },
    })
  })

  test("unrelated session is not a descendant", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rootA = await create({ title: "rootA" })
        const rootB = await create({ title: "rootB" })
        expect(await isDescendantOf(rootB.id, rootA.id)).toBe(false)
        await remove(rootA.id)
        await remove(rootB.id)
      },
    })
  })

  test("non-existent session id is not a descendant", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await create({ title: "root" })
        const ghost = SessionID.make("ses_ghost_does_not_exist_00000")
        expect(await isDescendantOf(ghost, root.id)).toBe(false)
        await remove(root.id)
      },
    })
  })

  test("respects maxDepth: returns false when chain is deeper than the limit", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await create({ title: "root" })
        // Build a chain root → c1 → c2 → c3.
        const c1 = await create({ title: "c1", parentID: root.id })
        const c2 = await create({ title: "c2", parentID: c1.id })
        const c3 = await create({ title: "c3", parentID: c2.id })
        // maxDepth: 1 means we walk at most one parent edge from c3, which
        // reaches c2 (not yet known), so we cannot confirm root and must
        // return false. With the default depth (64), c3 is reachable.
        expect(await isDescendantOf(c3.id, root.id, { maxDepth: 1 })).toBe(false)
        expect(await isDescendantOf(c3.id, root.id)).toBe(true)
        await remove(root.id)
      },
    })
  })

  test("cache accumulates confirmed descendants across calls", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await create({ title: "root" })
        const c1 = await create({ title: "c1", parentID: root.id })
        const c2 = await create({ title: "c2", parentID: c1.id })
        const cache = new Set<SessionID>([root.id])
        // First call walks the full chain c2 → c1 → root and promotes both
        // intermediate nodes into the cache.
        expect(await isDescendantOf(c2.id, root.id, { cache })).toBe(true)
        expect(cache.has(c1.id)).toBe(true)
        expect(cache.has(c2.id)).toBe(true)
        // A subsequent call for c1 short-circuits via the cache (depth: 0
        // forbids any walk; cache hit alone must satisfy the call).
        expect(await isDescendantOf(c1.id, root.id, { cache, maxDepth: 0 })).toBe(true)
        await remove(root.id)
      },
    })
  })

  test("auto-seeds root into cache so callers can pass an empty Set", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await create({ title: "root" })
        const child = await create({ title: "child", parentID: root.id })
        // Caller passes a fresh empty Set — root must still be reachable.
        // Without the auto-seed in isDescendantOf this would walk past root,
        // hit a not-found parent, and return false.
        const cache = new Set<SessionID>()
        expect(await isDescendantOf(child.id, root.id, { cache })).toBe(true)
        expect(cache.has(root.id)).toBe(true)
        await remove(root.id)
      },
    })
  })
})
