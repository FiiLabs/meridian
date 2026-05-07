/**
 * Tests for the Amp agent adapter.
 */
import { describe, it, expect } from "bun:test"
import { ampAdapter } from "../proxy/adapters/amp"

describe("ampAdapter — identity", () => {
  it("has name 'amp'", () => {
    expect(ampAdapter.name).toBe("amp")
  })

  it("getMcpServerName returns 'amp'", () => {
    expect(ampAdapter.getMcpServerName()).toBe("amp")
  })
})

describe("ampAdapter.getSessionId", () => {
  it("reads x-amp-thread-id header", () => {
    const ctx = {
      req: {
        header: (name: string) =>
          name === "x-amp-thread-id" ? "T-019d01b5-f70d-73ea-9445-f6d358f7213e" : undefined,
      },
    }
    expect(ampAdapter.getSessionId(ctx as any)).toBe("T-019d01b5-f70d-73ea-9445-f6d358f7213e")
  })

  it("returns undefined when header is absent", () => {
    const ctx = { req: { header: () => undefined } }
    expect(ampAdapter.getSessionId(ctx as any)).toBeUndefined()
  })

  it("does not fall back to other agents' headers", () => {
    const ctx = {
      req: {
        header: (name: string) =>
          name === "x-opencode-session" ? "sess-abc" : undefined,
      },
    }
    expect(ampAdapter.getSessionId(ctx as any)).toBeUndefined()
  })
})

describe("ampAdapter.normalizeContent", () => {
  it("normalizes string content", () => {
    expect(ampAdapter.normalizeContent("hello world")).toBe("hello world")
  })

  it("normalizes array of text blocks", () => {
    const content = [
      { type: "text", text: "First block" },
      { type: "text", text: "Second block" },
    ]
    const result = ampAdapter.normalizeContent(content)
    expect(result).toContain("First block")
    expect(result).toContain("Second block")
  })

  it("normalizes tool_use blocks", () => {
    const content = [
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
    ]
    const result = ampAdapter.normalizeContent(content)
    expect(result).toContain("tool_use")
    expect(result).toContain("bash")
  })

  it("handles null content", () => {
    expect(ampAdapter.normalizeContent(null as any)).toBe("null")
  })
})
