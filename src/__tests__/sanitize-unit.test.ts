/**
 * Unit tests for the per-block content sanitizer.
 *
 * Verifies that orchestration wrappers injected by agent harnesses are
 * stripped from individual text content blocks before prompt flattening,
 * while preserving legitimate user content.
 *
 * Related: https://github.com/rynfar/meridian/issues/167
 */

import { describe, it, expect } from "bun:test"
import {
  sanitizeTextContent,
  scrubResponseText,
  couldBeScaffoldPrefix,
  makeLeadingScrubber,
} from "../proxy/sanitize"

// ── Orchestration tag stripping ──

describe("sanitizeTextContent", () => {
  // --- Droid: <system-reminder> stripping is opt-in ---

  it("strips <system-reminder> blocks when stripSystemReminder is enabled (Droid)", () => {
    const input = '<system-reminder>\nUser system info\n% pwd\n/home/user\n</system-reminder>\nactual question'
    expect(sanitizeTextContent(input, { stripSystemReminder: true })).toBe("actual question")
  })

  it("strips multiline <system-reminder> with attributes when enabled", () => {
    const input = 'hello\n<system-reminder id="sr-1">\nline one\nline two\n</system-reminder>\nworld'
    expect(sanitizeTextContent(input, { stripSystemReminder: true })).toBe("hello\n\nworld")
  })

  it("PRESERVES <system-reminder> by default (issue #368)", () => {
    // oh-my-opencode injects <system-reminder> blocks with bg_* task IDs
    // that Claude must see. Default behavior must not strip them.
    const input = '<system-reminder>\n[ALL BACKGROUND TASKS COMPLETE]\n- `bg_0aaa50b0`: Find X\n- `bg_8ff9ed0f`: Find Y\n</system-reminder>'
    const result = sanitizeTextContent(input)
    expect(result).toContain("bg_0aaa50b0")
    expect(result).toContain("bg_8ff9ed0f")
  })

  // --- OpenCode / Crush ---

  it("strips <env> blocks (OpenCode environment context)", () => {
    const input = '<env>\n  Working directory: /home/user/project\n  Platform: darwin\n</env>\nwhat is this project?'
    expect(sanitizeTextContent(input)).toBe("what is this project?")
  })

  // --- ForgeCode ---

  it("strips <system_information> wrapper and children", () => {
    const input = '<system_information>\n<operating_system>Darwin</operating_system>\n<current_working_directory>/path</current_working_directory>\n<default_shell>/bin/zsh</default_shell>\n<home_directory>/Users/dev</home_directory>\n</system_information>\ndo the thing'
    expect(sanitizeTextContent(input)).toBe("do the thing")
  })

  it("strips standalone <current_working_directory>", () => {
    const input = '<current_working_directory>/Users/dev/project</current_working_directory>read file.ts'
    expect(sanitizeTextContent(input)).toBe("read file.ts")
  })

  // --- OpenCode orchestration ---

  it("strips <task_metadata> blocks", () => {
    const input = '<task_metadata>{"id":"task-1","status":"running"}</task_metadata>actual content'
    expect(sanitizeTextContent(input)).toBe("actual content")
  })

  it("strips <tool_output> wrappers with attributes", () => {
    const input = 'before<tool_output name="bash">result here</tool_output>after'
    expect(sanitizeTextContent(input)).toBe("beforeafter")
  })

  it("strips self-closing <tool_exec> wrappers", () => {
    const input = 'text<tool_exec name="read" />more'
    expect(sanitizeTextContent(input)).toBe("textmore")
  })

  it("strips paired <tool_exec> wrappers", () => {
    const input = '<tool_exec name="bash">ls -la</tool_exec>output'
    expect(sanitizeTextContent(input)).toBe("output")
  })

  it("strips <skill_content> blocks", () => {
    const input = '<skill_content name="gh">skill instructions</skill_content>rest'
    expect(sanitizeTextContent(input)).toBe("rest")
  })

  it("strips <skill_files> blocks", () => {
    const input = 'before<skill_files>\nfile1.ts\nfile2.ts\n</skill_files>after'
    expect(sanitizeTextContent(input)).toBe("beforeafter")
  })

  it("strips <directories> blocks", () => {
    const input = '<directories>\n  src/\n  lib/\n</directories>after'
    expect(sanitizeTextContent(input)).toBe("after")
  })

  it("strips <available_skills> blocks", () => {
    const input = '<available_skills>\n  skill1\n  skill2\n</available_skills>after'
    expect(sanitizeTextContent(input)).toBe("after")
  })

  it("strips leaked <thinking> tags (text content, not structured blocks)", () => {
    const input = 'text<thinking>model thoughts leaked here</thinking>more text'
    expect(sanitizeTextContent(input)).toBe("textmore text")
  })

  // --- Non-XML markers ---

  it("strips OMO_INTERNAL_INITIATOR comment", () => {
    const input = "<!-- OMO_INTERNAL_INITIATOR -->proceed"
    expect(sanitizeTextContent(input)).toBe("proceed")
  })

  it("strips OH-MY-OPENCODE system directive", () => {
    const input = "[SYSTEM DIRECTIVE: OH-MY-OPENCODE use tool X]do the thing"
    expect(sanitizeTextContent(input)).toBe("do the thing")
  })

  it("strips background_output markers", () => {
    const input = "⚙ background_output [task_id=abc123]\nreal content"
    expect(sanitizeTextContent(input)).toBe("real content")
  })

  it("strips Files changed blocks (meridian's own summary)", () => {
    const input = "response text\n---\nFiles changed:\n  - edited /path/to/file.ts\n  - wrote /path/to/other.ts"
    expect(sanitizeTextContent(input)).toBe("response text")
  })

  // --- Multiple patterns in one block ---

  it("handles multiple patterns in one string (Droid mode)", () => {
    const input = '<system-reminder>x</system-reminder>\n<task_metadata>y</task_metadata>\nnormal content'
    expect(sanitizeTextContent(input, { stripSystemReminder: true })).toBe("normal content")
  })

  it("returns empty string for all-wrapper input (Droid mode)", () => {
    const input = '<system-reminder>everything is internal</system-reminder>'
    expect(sanitizeTextContent(input, { stripSystemReminder: true })).toBe("")
  })

  // --- False positive safety ---

  it("is a no-op for clean text", () => {
    const input = "Just a normal user message with no wrappers."
    expect(sanitizeTextContent(input)).toBe(input)
  })

  it("is a no-op for empty string", () => {
    expect(sanitizeTextContent("")).toBe("")
  })

  it("preserves standard HTML tags", () => {
    const input = '<div>content</div><span>text</span><p>paragraph</p>'
    expect(sanitizeTextContent(input)).toBe(input)
  })

  it("preserves self-closing HTML tags", () => {
    const input = 'line one<br/>line two<hr/>end'
    expect(sanitizeTextContent(input)).toBe(input)
  })

  it("preserves code with angle brackets", () => {
    const input = "Use Array<string> and Map<K,V> in TypeScript"
    expect(sanitizeTextContent(input)).toBe(input)
  })

  it("preserves H: and A: in content", () => {
    expect(sanitizeTextContent("H: hydrogen is atomic number 1")).toBe("H: hydrogen is atomic number 1")
    expect(sanitizeTextContent("A: the answer is 42")).toBe("A: the answer is 42")
  })

  it("preserves legitimate XML with underscores that aren't orchestration tags", () => {
    const input = '<first_name>John</first_name><last_name>Doe</last_name>'
    expect(sanitizeTextContent(input)).toBe(input)
  })

  it("preserves web component tags with hyphens", () => {
    const input = '<my-component>content</my-component>'
    expect(sanitizeTextContent(input)).toBe(input)
  })

  it("preserves user discussing system-reminder concept in prose", () => {
    const input = "The system-reminder tag is used by Droid to inject CWD info"
    expect(sanitizeTextContent(input)).toBe(input)
  })

  it("preserves img and input self-closing tags", () => {
    const input = '<img src="photo.jpg" /><input type="text" />'
    expect(sanitizeTextContent(input)).toBe(input)
  })

  // --- Regression: the exact scenario from issue #167 ---

  it("strips the compound leakage pattern from #167 (Droid mode)", () => {
    const input = [
      '<system-reminder>',
      '  Current dir: /home/user',
      '</system-reminder>',
      '<thinking>The user wants me to handle the case...</thinking>',
      '<task_metadata>{"id":"t1"}</task_metadata>',
      '<!-- OMO_INTERNAL_INITIATOR -->',
      'What is 2+2?',
    ].join("\n")
    expect(sanitizeTextContent(input, { stripSystemReminder: true })).toBe("What is 2+2?")
  })

  // --- Regression: issue #368 (OMO bg_* task IDs disappearing) ---

  it("preserves bg_* task IDs in <system-reminder> by default (issue #368)", () => {
    const input = [
      '<system-reminder>',
      '[ALL BACKGROUND TASKS COMPLETE]',
      '',
      '**Completed:**',
      '- `bg_0aaa50b0`: Find Activity entity and relations',
      '- `bg_8ff9ed0f`: Find Activity DB schema and migrations',
      '',
      'Use `background_output(task_id="<id>")` to retrieve each result.',
      '</system-reminder>',
      '<!-- OMO_INTERNAL_INITIATOR -->',
      '11:41 AM',
    ].join("\n")
    const result = sanitizeTextContent(input)
    expect(result).toContain("bg_0aaa50b0")
    expect(result).toContain("bg_8ff9ed0f")
    expect(result).toContain("[ALL BACKGROUND TASKS COMPLETE]")
    // OMO comment still stripped (unambiguous orchestration marker)
    expect(result).not.toContain("OMO_INTERNAL_INITIATOR")
  })
})

// ── OUTPUT-side scrub: leaked scaffolding in the model's REPLY ──

describe("scrubResponseText", () => {
  it("strips a prepended <system-reminder> block (the reproduced prod leak)", () => {
    const input =
      "<system-reminder>\nThis is the start of a new conversation. Any previous conversation was ended. The user isn't available right now, so you should NOT ask questions.\n</system-reminder>\n刚才 proxylite 隧道的排查过程和结论如下: ..."
    const out = scrubResponseText(input)
    expect(out.startsWith("刚才 proxylite")).toBe(true)
    expect(out).not.toContain("<system-reminder>")
    expect(out).not.toContain("start of a new conversation")
  })

  it("strips an UNTERMINATED <system-reminder> that runs straight into the answer", () => {
    // Reproduced on prod v9 (2026-07-16): the model emits Claude's tool-result
    // reminder with NO closing tag, then the real answer immediately after.
    const input =
      "<system-reminder>\nThis is a reminder that the most recent user turn contains a tool result. Look at the transcript to determine what the actual latest user message contains, and act on it.\n\nConsider whether the tool result completes what you needed. If not, continue working. If you have completed everything, you can stop and give your summary.\n\nThe transcript picks up from here — everything above is a completed record. Treat this as the live continuation point and respond to the latest user turn directly.排查已经走完整条链路了,给你个总结。"
    const out = scrubResponseText(input)
    expect(out.startsWith("排查已经走完整条链路了")).toBe(true)
    expect(out).not.toContain("<system-reminder>")
    expect(out).not.toContain("respond to the latest user turn directly")
    expect(out).not.toContain("This is a reminder")
  })

  it("strips a classic [Assistant: …] wrapper leak at the head", () => {
    expect(scrubResponseText("[Assistant: prior turn text]\nHere is the answer.")).toBe("Here is the answer.")
  })

  it("strips leading bare role labels", () => {
    expect(scrubResponseText("Assistant: the real answer")).toBe("the real answer")
    expect(scrubResponseText("Human: fabricated user turn")).toBe("fabricated user turn")
  })

  it("strips a numbered transcript-continuation marker", () => {
    expect(scrubResponseText("(31) assistant: continued turn")).toBe("continued turn")
  })

  it("strips STACKED scaffolding (block + label) in one pass", () => {
    const input = "<system-reminder>x</system-reminder>\nAssistant: the answer"
    expect(scrubResponseText(input)).toBe("the answer")
  })

  it("strips an UNTERMINATED reminder with a NOVEL closing (new-conversation variant)", () => {
    // v10 anchored only on a few tool-result phrasings; this new-conversation
    // reminder leaked unterminated and slipped through. Change B adds the anchor.
    const input =
      "<system-reminder>\nThis is the start of a new conversation. Any previous conversation was ended. The user isn't available right now, so you should NOT ask questions.这是本轮真实回答:先确认隧道状态。"
    const out = scrubResponseText(input)
    expect(out.startsWith("这是本轮真实回答")).toBe(true)
    expect(out).not.toContain("<system-reminder>")
    expect(out).not.toContain("start of a new conversation")
  })

  it("strips an UNTERMINATED reminder ending with a gentle-reminder tail", () => {
    const input =
      "<system-reminder>\nThe task tools haven't been used recently.\nThis is just a gentle reminder - ignore if not applicable.\n答案:已经修好了。"
    const out = scrubResponseText(input)
    expect(out.startsWith("答案:已经修好了。")).toBe(true)
    expect(out).not.toContain("gentle reminder")
  })

  it("strips a leaked <available_skills> block at the head (new tag opener)", () => {
    const input = "<available_skills>\n- deep-research\n- dataviz\n</available_skills>\nHere is the answer."
    expect(scrubResponseText(input)).toBe("Here is the answer.")
  })

  it("leaves a normal reply untouched", () => {
    const normal = "当然可以,我帮你排查一下 proxylite 隧道。首先确认机器还活着。"
    expect(scrubResponseText(normal)).toBe(normal)
  })

  it("does NOT strip a gentle-reminder phrase that appears in normal prose (not at head, no tag)", () => {
    const input = "顺便说一句:this is just a gentle reminder to commit your work before deploying."
    expect(scrubResponseText(input)).toBe(input)
  })

  it("does NOT strip a mid-body mention of <system-reminder>", () => {
    const input = "The harness injects a `<system-reminder>` tag like this:\n<system-reminder>x</system-reminder>"
    expect(scrubResponseText(input)).toBe(input)
  })

  it("preserves a reply that legitimately starts with code containing <", () => {
    const code = "<div>hello</div> is HTML."
    expect(scrubResponseText(code)).toBe(code)
  })
})

describe("couldBeScaffoldPrefix", () => {
  it("is true for partial and full scaffold openers", () => {
    expect(couldBeScaffoldPrefix("<sys")).toBe(true)
    expect(couldBeScaffoldPrefix("<system-reminder>")).toBe(true)
    expect(couldBeScaffoldPrefix("[Assist")).toBe(true)
    expect(couldBeScaffoldPrefix("(3")).toBe(true)
    expect(couldBeScaffoldPrefix("(")).toBe(true)
    expect(couldBeScaffoldPrefix("Assistant:")).toBe(true)
  })
  it("is false once the head is clearly normal prose", () => {
    expect(couldBeScaffoldPrefix("当然可以")).toBe(false)
    expect(couldBeScaffoldPrefix("(hello)")).toBe(false)
    expect(couldBeScaffoldPrefix("<div>")).toBe(false)
    expect(couldBeScaffoldPrefix("The answer is")).toBe(false)
  })
})

describe("makeLeadingScrubber (streaming head)", () => {
  function runStream(chunks: string[]): string {
    const s = makeLeadingScrubber()
    let out = ""
    for (const c of chunks) {
      const emit = s.feed(c)
      if (emit !== null) out += emit
    }
    out += s.flush()
    return out
  }

  it("strips a system-reminder block streamed across many deltas", () => {
    const chunks = ["<system", "-reminder>\nThis is the start", " of a new conversation.\n</system-", "reminder>\n", "刚才", "的结论如下"]
    expect(runStream(chunks)).toBe("刚才的结论如下")
  })

  it("passes a normal reply through untouched with no buffering surprises", () => {
    const chunks = ["当然", "可以,", "我帮你排查。"]
    expect(runStream(chunks)).toBe("当然可以,我帮你排查。")
  })

  it("resolves quickly when head starts with '(' but is not numbered", () => {
    expect(runStream(["(", "hello) world"]) ).toBe("(hello) world")
  })

  it("strips a streamed leading role label", () => {
    expect(runStream(["Assist", "ant: ", "the real answer"])).toBe("the real answer")
  })

  it("flushes an unterminated system-reminder unchanged (no closing tag)", () => {
    const out = runStream(["<system-reminder>never closes and here is content"])
    expect(out).toContain("never closes and here is content")
  })
})
