/**
 * Per-block content sanitizer for orchestration wrapper leakage.
 *
 * Agent harnesses (OpenCode, Droid, ForgeCode, oh-my-opencode, etc.) inject
 * internal markup into message content — `<system-reminder>`, `<env>`,
 * `<task_metadata>`, and similar tags. When the proxy flattens messages into
 * a text prompt for the Agent SDK, these tags become model-visible text that
 * can confuse the model or cause it to echo them back ("talking to itself").
 *
 * This module strips known orchestration tags from **individual text blocks**
 * before flattening — not from the final concatenated string. Operating
 * per-block eliminates the cross-message regex risk that makes full-string
 * sanitization fragile.
 *
 * Pure module — no I/O, no imports from server.ts or session/.
 *
 * Fixes: https://github.com/rynfar/meridian/issues/167
 */

// ---------------------------------------------------------------------------
// Exact tag names known to be orchestration-only.
// These are NOT prefix patterns — each entry is a specific tag name that
// harnesses inject and that never appears in legitimate user content.
// ---------------------------------------------------------------------------

// Tags stripped unconditionally (every adapter).
// `system-reminder` is NOT here — it is overloaded: Droid uses it to leak CWD
// (should strip), but OpenCode's oh-my-opencode harness uses it to surface
// background-task IDs and other orchestration state the model MUST see. So it
// is only stripped when the caller opts in via { stripSystemReminder: true }.
const ORCHESTRATION_TAGS = [
  // OpenCode / Crush: environment context blocks
  "env",
  // ForgeCode: system info wrapper and children
  "system_information",
  "current_working_directory",
  "operating_system",
  "default_shell",
  "home_directory",
  // OpenCode: task/tool/skill orchestration
  "task_metadata",
  "tool_exec",
  "tool_output",
  "skill_content",
  "skill_files",
  // OpenCode: context injection blocks
  "directories",
  "available_skills",
  // Leaked thinking tags (NOT the structured content block type —
  // these are raw XML tags that appear in text content on replay)
  "thinking",
]

// Build regex for paired tags: <tagname ...>...</tagname>
// Each tag gets its own regex to avoid cross-tag matching.
const PAIRED_TAG_PATTERNS: RegExp[] = ORCHESTRATION_TAGS.map(
  (tag) => new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi")
)

// Self-closing variants: <tagname ... />
const SELF_CLOSING_TAG_PATTERNS: RegExp[] = ORCHESTRATION_TAGS.map(
  (tag) => new RegExp(`<${tag}\\b[^>]*\\/>`, "gi")
)

// Non-XML orchestration markers (unique, branded — zero false-positive risk)
const NON_XML_PATTERNS: RegExp[] = [
  // oh-my-opencode internal markers
  /<!--\s*OMO_INTERNAL_INITIATOR\s*-->/gi,
  /\[SYSTEM DIRECTIVE: OH-MY-OPENCODE[^\]]*\]/gi,
  // Background task markers
  /⚙\s*background_output\s*\[task_id=[^\]]*\]\n?/g,
  // Meridian's own file change summary leaking back into conversation
  /\n?---\nFiles changed:[^\n]*(?:\n(?:  [-•*] [^\n]*))*\n?/g,
]

const ALL_PATTERNS = [
  ...PAIRED_TAG_PATTERNS,
  ...SELF_CLOSING_TAG_PATTERNS,
  ...NON_XML_PATTERNS,
]

// Opt-in: only used when the adapter reports that it leaks CWD/env through
// `<system-reminder>` blocks (Droid). Other adapters must preserve these
// blocks — they carry model-visible harness state (see ORCHESTRATION_TAGS).
const SYSTEM_REMINDER_PATTERNS: RegExp[] = [
  /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi,
  /<system-reminder\b[^>]*\/>/gi,
]

export interface SanitizeOptions {
  /** Strip `<system-reminder>` blocks. Enable for adapters (Droid) that leak
   *  CWD/env through this tag. */
  stripSystemReminder?: boolean
}

/**
 * Strip orchestration wrappers from a single text string.
 *
 * Designed to be called on individual content blocks (not concatenated
 * prompt strings) to eliminate cross-block regex matching risk.
 */
export function sanitizeTextContent(text: string, opts: SanitizeOptions = {}): string {
  let result = text
  const patterns = opts.stripSystemReminder
    ? [...ALL_PATTERNS, ...SYSTEM_REMINDER_PATTERNS]
    : ALL_PATTERNS
  for (const pattern of patterns) {
    // Reset lastIndex for stateful regexes (those with 'g' flag)
    pattern.lastIndex = 0
    result = result.replace(pattern, "")
  }
  // Collapse runs of 3+ newlines into 2 (avoids large gaps where tags were)
  result = result.replace(/\n{3,}/g, "\n\n")
  return result.trim()
}

// ===========================================================================
// OUTPUT-side scrub: strip leaked harness scaffolding from the model's REPLY.
//
// On the fresh (non-resume) path the flattened history can make the model
// PREPEND fabricated harness scaffolding to its answer instead of just
// answering: a `<system-reminder>` block, an `[Assistant: …]` wrapper, bare
// `Human:`/`Assistant:` role labels, or a numbered `(N) user:/assistant:`
// transcript continuation (issues #111/#386/#496; reproduced on prod 2026-07-16
// as a prepended `<system-reminder>` block). buildFramedReferenceMessages
// reduces this at the SOURCE but does not fully eliminate it; this is the belt-
// and-suspenders catch on the way OUT.
//
// Conservative by construction: only strips scaffolding at the LEADING edge of
// the reply (where the leak appears), looping until the head is clean. Body
// content is never touched, so a reply that legitimately mentions these tokens
// later on is fully preserved.
// ===========================================================================

// Leading scaffolding patterns, anchored to the START of the (left-trimmed) reply.
const LEADING_SCAFFOLD_PATTERNS: RegExp[] = [
  // Fabricated harness context blocks (paired tags) at the head.
  /^<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/i,
  // UNTERMINATED <system-reminder>: the model reproduces Claude's injected
  // reminder but omits the closing tag and runs straight into its answer (no
  // delimiter). Anchor the end greedily on Claude's known reminder hallmark
  // sentences — these strings only occur in that harness text, and the whole
  // pattern requires the reply to START with <system-reminder>, so it never
  // touches real content. Fully-general blank-line bounding is deliberately
  // avoided: Claude reminders are multi-paragraph (they contain their own blank
  // lines), so a "strip to first \n\n" would leave the reminder's tail behind.
  // Enrich this list as new reminder phrasings are observed leaking.
  new RegExp(
    "^<system-reminder\\b[^>]*>[\\s\\S]*(?:" +
    [
      // continuation / new-conversation reminders (#496, reproduced 2026-07-16)
      "respond to the latest user turn directly\\.",
      "This is the start of a new conversation\\.",
      "Any previous conversation was ended\\.",
      "so you should NOT ask questions\\.?",
      "The transcript picks up from here",
      "everything above is a completed record",
      "Treat this as the live continuation point",
      // tool-result / keep-going reminders (v9 residual)
      "Keep going until the task is fully handled\\.",
      "you can stop and give your summary\\.",
      "without additional tool calls\\.",
      "contains a tool result\\.",
      "Look at the transcript to determine what the actual latest user message",
      // generic ephemeral-reminder tails
      "This is just a gentle reminder[^\\n]*",
      "unless the user explicitly asks you to\\.",
      "unless it is highly relevant to your task\\.",
    ].join("|") +
    ")",
    "i",
  ),
  /^<(env|task_metadata|thinking|tool_output|tool_exec|skill_content|skill_files|directories|available_skills|system_information|current_working_directory|background_output)\b[^>]*>[\s\S]*?<\/\1>/i,
  // Classic `[Assistant: …]` / `[Human: …]` wrapper leak (single line).
  /^\[(assistant|human)\b[^\]\n]*\]?/i,
  // Bare role label at the very start of the reply.
  /^(assistant|human|user)\s*[:：][ \t]*/i,
  // Numbered transcript-continuation marker: "(31) assistant:" / "(1) user:".
  /^\(\s*\d+\s*\)\s*(assistant|user|human)\s*[:：][ \t]*/i,
]

/**
 * Strip leaked harness scaffolding from the LEADING edge of a reply. Loops so a
 * stacked leak (e.g. a `<system-reminder>` block followed by a role label) is
 * fully removed. Returns the cleaned text (left-trimmed).
 */
export function scrubResponseText(text: string): string {
  if (!text) return text
  let out = text.replace(/^\s+/, "")
  for (let changed = true; changed; ) {
    changed = false
    for (const re of LEADING_SCAFFOLD_PATTERNS) {
      const m = out.match(re)
      if (m && m.index === 0 && m[0].length > 0) {
        out = out.slice(m[0].length).replace(/^\s+/, "")
        changed = true
        break
      }
    }
  }
  return out
}

// Prefixes whose appearance at the head of a reply means it MIGHT be leaked
// scaffolding — the only case the streaming scrubber buffers for. Anything else
// streams through untouched (zero added latency on the common path).
const SCAFFOLD_OPENERS = [
  "<system-reminder",
  "<env",
  "<task_metadata",
  "<thinking",
  "<tool_output",
  "<tool_exec",
  "<skill_content",
  "[assistant",
  "[human",
  "assistant:",
  "human:",
  "user:",
]

/**
 * True when `head` (a left-trimmed leading slice of a streamed reply) could
 * still be the beginning of leaked scaffolding — i.e. it is a prefix of, or
 * starts with, a known opener, or looks like a numbered "(N) role:" marker.
 * Used by the streaming scrubber to decide whether to keep buffering the head.
 */
export function couldBeScaffoldPrefix(head: string): boolean {
  const s = head.replace(/^\s+/, "").toLowerCase()
  if (s === "") return true // only whitespace so far — undecided
  if (/^\(\s*\d/.test(s)) return true // "(3" → possible numbered marker
  if (/^\(\s*$/.test(s)) return true // just "(" — could become "(3)"
  // A trailing CLOSING-tag fragment ("</system-", "</env") means a scaffold
  // block's closing tag is still streaming in. Without this, an unterminated-
  // reminder pattern can strip up to a known sentence and prematurely resolve,
  // leaving the "</system-reminder>" tail behind (it isn't an opener, so the
  // check below would report clean). Keep buffering until the tag completes so
  // the paired-tag pattern can remove the whole block. Only fires for "</xxx"
  // fragments — an opening "<div>" (with '>') and normal prose are unaffected.
  if (/^<\/[a-z][a-z0-9_-]*$/i.test(s)) return true
  return SCAFFOLD_OPENERS.some((o) => o.startsWith(s) || s.startsWith(o))
}

/**
 * Stateful scrubber for a STREAMED reply's first text block. Buffers only while
 * the head could still be leaked scaffolding; once the head is known-clean it
 * resolves and passes every subsequent chunk through verbatim.
 */
export function makeLeadingScrubber() {
  let buf = ""
  let resolved = false
  return {
    /** Feed a text delta. Returns text to emit now (possibly ""), or null to
     *  withhold this chunk (still buffering the head). */
    feed(chunk: string): string | null {
      if (resolved) return chunk
      buf += chunk
      if (couldBeScaffoldPrefix(buf)) {
        const scrubbed = scrubResponseText(buf)
        // Fully stripped AND the remainder is no longer scaffold-like → resolve.
        if (scrubbed !== buf && !couldBeScaffoldPrefix(scrubbed)) {
          resolved = true
          buf = ""
          return scrubbed
        }
        return null // incomplete/ambiguous — keep buffering
      }
      // Head is definitively NOT scaffolding → flush and pass through hereafter.
      resolved = true
      const out = buf
      buf = ""
      return out
    },
    /** Called when the head text block ends — flush whatever is buffered,
     *  scrubbed. Returns "" if nothing to emit. */
    flush(): string {
      if (resolved) return ""
      resolved = true
      const out = scrubResponseText(buf)
      buf = ""
      return out
    },
  }
}
