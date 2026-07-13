/**
 * Edge-case coverage for the fresh-path framed-reference builder
 * (buildFramedReferenceMessages), targeting shapes that occur in the PRODUCTION
 * architecture (real Claude Code + seat rotation → nearly every turn is fresh):
 *
 *   1. LIVE turn is a MULTIMODAL tool_result whose matching tool_use lives in a
 *      PRIOR (now-archived) assistant turn. The concern was an "orphaned"
 *      tool_result (tool_use_id with no matching tool_use) reaching the SDK and
 *      being rejected. This test proves the multimodal tool_result is UNWRAPPED
 *      into plain text+image blocks (wrapper + tool_use_id dropped) — no orphan.
 *   2. LIVE turn is a TEXT-ONLY tool_result → unwrapped to a plain string, no
 *      structured tool_result, no orphan.
 *   3. LONG history (many turns) collapses to EXACTLY one framed block + the live
 *      turn, regardless of length.
 *   4. A PRIOR user turn carrying an image → the real image block is preserved as
 *      a structured attachment on the framed reference turn (media not lost),
 *      while still reading as inert reference (no `[Assistant:]` transcript).
 *
 * All tests drive a FRESH (no session header, empty cache) request through the
 * real HTTP layer with a mocked SDK, and inspect the discrete user-message stream
 * handed to query().
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"

let capturedQueryParams: any = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      yield {
        type: "assistant",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: "sess-1",
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

let savedPassthrough: string | undefined

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(app: any, body: any) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }))
}

async function drain(prompt: any): Promise<any[]> {
  const out: any[] = []
  for await (const m of prompt) out.push(m)
  return out
}

/** Deep-stringify a captured item for substring/orphan scanning. */
function dump(x: any): string {
  return JSON.stringify(x)
}

/** No prompt-label leak markers and no fabricated tool-call text anywhere. */
function assertNoLeakMarkers(items: any[]) {
  const all = dump(items)
  expect(all).not.toContain("[Assistant:")
  expect(all).not.toContain("<invoke")
  // Line-leading Human:/Assistant: transcript labels in any string content.
  for (const it of items) {
    const c = it.message?.content
    if (typeof c === "string") {
      expect(/(^|\n)Human:\s/.test(c)).toBe(false)
      expect(/(^|\n)Assistant:\s/.test(c)).toBe(false)
    }
  }
}

/** No structured tool_result block, and the given tool_use_id appears nowhere. */
function assertNoOrphan(items: any[], toolUseId: string) {
  for (const it of items) {
    const c = it.message?.content
    if (Array.isArray(c)) {
      expect(c.some((b: any) => b?.type === "tool_result")).toBe(false)
    }
  }
  expect(dump(items)).not.toContain(toolUseId)
}

describe("fresh-path framed reference — production edge cases", () => {
  beforeEach(() => {
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
    capturedQueryParams = null
    clearSessionCache()
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("1) live turn is a MULTIMODAL tool_result → unwrapped, no orphaned tool_use_id", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "read the screenshot at /tmp/s.png" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll read it." },
            { type: "tool_use", id: "toolu_scr", name: "Read", input: { file_path: "/tmp/s.png" } },
          ],
        },
        {
          // LIVE turn: a tool_result whose matching tool_use (toolu_scr) is now in
          // the archived prior assistant turn.
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_scr",
              content: [
                { type: "text", text: "Here is the screenshot:" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
              ],
            },
          ],
        },
      ],
    })).json()

    expect(typeof capturedQueryParams.prompt).not.toBe("string")
    const items = await drain(capturedQueryParams.prompt)

    // framed reference block + the live turn
    expect(items.length).toBe(2)
    for (const it of items) {
      expect(it.type).toBe("user")
      expect(it.message.role).toBe("user")
    }

    // framed block references the earlier turns, reads as inert record
    const framed = items[0].message.content
    const framedStr = typeof framed === "string" ? framed : dump(framed)
    expect(framedStr).toContain("Read-only record")

    // LIVE turn: the multimodal tool_result was UNWRAPPED to text+image blocks
    const live = items[items.length - 1].message.content
    expect(Array.isArray(live)).toBe(true)
    expect(live.some((b: any) => b?.type === "image")).toBe(true)

    // The core assertion: NO structured tool_result and NO dangling toolu_scr id
    // reaches the SDK anywhere (no orphan → no API 400).
    assertNoOrphan(items, "toolu_scr")
    assertNoLeakMarkers(items)
  })

  it("2) live turn is a TEXT-ONLY tool_result → unwrapped to text, no orphan", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "run the build" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Running the build." },
            { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "make" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_bash", content: "build ok, 0 errors" },
          ],
        },
      ],
    })).json()

    const items = await drain(capturedQueryParams.prompt)
    expect(items.length).toBe(2)

    // Live turn flattened to a plain string (tool_result unwrapped).
    const live = items[items.length - 1].message.content
    expect(typeof live).toBe("string")
    expect(live).toContain("build ok, 0 errors")

    assertNoOrphan(items, "toolu_bash")
    assertNoLeakMarkers(items)
  })

  it("3) LONG history collapses to exactly one framed block + live turn", async () => {
    const app = createTestApp()
    const messages: any[] = []
    for (let i = 1; i <= 10; i++) {
      messages.push({ role: "user", content: `question ${i}` })
      messages.push({ role: "assistant", content: `answer ${i}` })
    }
    messages.push({ role: "user", content: "now summarize everything above" })

    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages,
    })).json()

    const items = await drain(capturedQueryParams.prompt)

    // The whole point: history NEVER expands into per-turn pseudo-messages.
    expect(items.length).toBe(2)

    const framed = items[0].message.content
    const framedStr = typeof framed === "string" ? framed : dump(framed)
    expect(framedStr).toContain("Read-only record")
    expect(framedStr).toContain("question 1")
    expect(framedStr).toContain("answer 10")

    // Last item is the genuine live turn (what the model must actually answer).
    expect(items[items.length - 1].message.content).toContain("summarize everything above")

    assertNoLeakMarkers(items)
  })

  it("4) prior USER turn with an image → image preserved on the framed turn", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is in this logo?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "logo123" } },
          ],
        },
        { role: "assistant", content: "It's a blue circle." },
        { role: "user", content: "and what color is the text?" },
      ],
    })).json()

    const items = await drain(capturedQueryParams.prompt)
    expect(items.length).toBe(2)

    // The framed reference turn carries the real image block (media not lost),
    // alongside the framed text.
    const framed = items[0].message.content
    expect(Array.isArray(framed)).toBe(true)
    expect(framed.some((b: any) => b?.type === "image")).toBe(true)
    expect(framed.some((b: any) => b?.type === "text" && b.text.includes("Read-only record"))).toBe(true)

    // Live turn is the genuine last question.
    expect(items[items.length - 1].message.content).toContain("what color is the text")

    assertNoLeakMarkers(items)
  })
})
