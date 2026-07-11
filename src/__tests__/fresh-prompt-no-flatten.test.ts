/**
 * Regression test for the multi-turn flatten leak.
 *
 * Before the fix, a fresh (non-resume) request with multi-turn history was
 * flattened into a single `Human: …\n\nAssistant: …` transcript string and
 * handed to the single-turn SDK query(). The completion model then continued
 * the transcript on its own — fabricating fake `Human:` turns, replying on the
 * user's behalf, and leaking the raw prompt labels into the reply.
 *
 * The fix makes both the hot path (makePrompt) and the retry path
 * (buildFreshPrompt) always emit a STREAM of discrete structured user messages.
 * This test drives a real multi-turn request through the HTTP layer with a
 * mocked SDK and asserts:
 *   1. opts.prompt is an AsyncIterable, never a string.
 *   2. Every yielded item is a discrete { type:"user", message:{role:"user"} }.
 *   3. No yielded content is a dangling `Human:`/`Assistant:` transcript
 *      (i.e. no single string carrying BOTH role labels).
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import {
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
} from "./helpers"

let capturedPrompts: any[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    capturedPrompts.push(opts.prompt)
    return (async function* () {
      yield messageStart("msg-1")
      yield textBlockStart(0)
      yield textDelta(0, "ok")
      yield blockStop(0)
      yield messageDelta("end_turn")
      yield messageStop()
      yield {
        type: "assistant",
        uuid: "uuid-1",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: "sdk-fresh-1",
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

function post(app: any, body: any, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  )
}

async function drain(prompt: any): Promise<any[]> {
  const out: any[] = []
  for await (const m of prompt) out.push(m)
  return out
}

function isTranscriptString(s: string): boolean {
  // A dangling transcript carries BOTH role labels in one string.
  return /(^|\n)Human:\s/.test(s) && /(^|\n)Assistant:\s/.test(s)
}

describe("fresh multi-turn prompt is never a flattened transcript", () => {
  beforeEach(() => {
    clearSessionCache()
    capturedPrompts = []
  })

  it("emits a discrete-message AsyncIterable for a fresh text multi-turn request", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })

    const messages = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ]

    const res = await post(app, { model: "sonnet", stream: false, messages })
    expect(res.status).toBe(200)

    expect(capturedPrompts.length).toBeGreaterThan(0)
    const prompt = capturedPrompts[0]

    // 1) never a raw string
    expect(typeof prompt).not.toBe("string")
    // 2) is an async iterable
    expect(typeof prompt[Symbol.asyncIterator]).toBe("function")

    const items = await drain(prompt)
    expect(items.length).toBeGreaterThan(0)

    for (const it of items) {
      // 2) each is a discrete user message object
      expect(it.type).toBe("user")
      expect(it.message.role).toBe("user")
      // 3) no dangling combined transcript in any string content
      const c = it.message.content
      if (typeof c === "string") {
        expect(isTranscriptString(c)).toBe(false)
      }
    }

    // The whole point: the user's own turns are NOT concatenated with the
    // assistant turn into one transcript. We should see >= 2 discrete items
    // (2 user turns + 1 quoted assistant turn) for this 3-message history.
    expect(items.length).toBeGreaterThanOrEqual(2)
  })
})
