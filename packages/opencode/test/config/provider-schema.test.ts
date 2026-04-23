import { describe, expect, test } from "bun:test"
import { ConfigProvider } from "../../src/config/provider"

describe("ConfigProvider schema", () => {
  test("chunkTimeout has exactly one description annotation", () => {
    const json = JSON.stringify(ConfigProvider.Info.ast)
    const needle = "Timeout in milliseconds between streamed SSE chunks"
    const count = json.split(needle).length - 1
    expect(count).toBe(1)
  })

  test("timeout has exactly one description annotation", () => {
    const json = JSON.stringify(ConfigProvider.Info.ast)
    const needle = "Timeout in milliseconds for requests to this provider"
    const count = json.split(needle).length - 1
    expect(count).toBe(1)
  })
})
