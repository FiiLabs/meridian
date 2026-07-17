/**
 * Integration tests for the /admin hot-swap route HANDLERS (server.ts), driven
 * through the real Hono app via app.fetch. Covers credential + egress-proxy
 * swap: auth gating, input validation, persistence, and success paths.
 *
 * node:child_process.spawn is mocked (before imports) so gost is never really
 * launched — the sandbox blocks spawning arbitrary processes and we only need
 * to assert handler behavior + reported state.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, mock } from "bun:test"
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Preserve the real module (server's transitive deps use execFile/exec) and
// override only spawn so gost is never really launched.
const realChildProcess = await import("node:child_process")
mock.module("node:child_process", () => ({
  ...realChildProcess,
  default: (realChildProcess as any).default ?? realChildProcess,
  spawn: () => {
    const listeners: Record<string, Array<(...a: any[]) => void>> = {}
    return {
      killed: false, pid: 4242,
      on(ev: string, cb: (...a: any[]) => void) { (listeners[ev] ||= []).push(cb) },
      once(ev: string, cb: (...a: any[]) => void) { (listeners[ev] ||= []).push(cb) },
      kill() { this.killed = true; (listeners["exit"] || []).forEach((f) => f()) },
    }
  },
}))

const ADMIN = "admin-secret-tok"
const SEATKEY = "seat-api-key"
const SAVED = { admin: process.env.MERIDIAN_ADMIN_TOKEN, key: process.env.MERIDIAN_API_KEY, cfg: process.env.CLAUDE_CONFIG_DIR, ef: process.env.MERIDIAN_EGRESS_PROXY_FILE }

let home: string, cfgDir: string
const { createProxyServer } = await import("../proxy/server")
let app: any

function mkApp() {
  const { app: a } = createProxyServer({
    installProcessErrorHandlers: false,
    // NOTE: the profile field is `claudeConfigDir` — profiles.ts turns it into
    // env.CLAUDE_CONFIG_DIR. Passing `env` directly is IGNORED, which would make
    // the credential store fall back to the REAL ~/.claude/.credentials.json and
    // let this test clobber the developer's own Claude login. The guard in
    // assertSandboxed() below is the safety net for that mistake.
    profiles: [{ id: "default", type: "claude-max", claudeConfigDir: cfgDir }],
    defaultProfile: "default",
  })
  return a
}

/** Fail loudly rather than ever touching the developer's real credentials. */
function assertSandboxed() {
  const real = join(process.env.REAL_HOME || require("node:os").homedir(), ".claude")
  if (!cfgDir.startsWith(tmpdir())) throw new Error(`refusing to run: cfgDir ${cfgDir} is not under ${tmpdir()}`)
  if (join(cfgDir) === real) throw new Error("refusing to run: cfgDir resolves to the REAL ~/.claude")
}
async function call(method: string, path: string, tok: string | null, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (tok) headers["Authorization"] = `Bearer ${tok}`
  const res = await app.fetch(new Request("http://localhost" + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  }))
  let json: any = null
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "admin-rt-"))
  cfgDir = join(home, ".claude")
  process.env.MERIDIAN_ADMIN_TOKEN = ADMIN
  process.env.MERIDIAN_API_KEY = SEATKEY
  process.env.CLAUDE_CONFIG_DIR = cfgDir
  process.env.MERIDIAN_EGRESS_PROXY_FILE = join(home, "egress-proxy.json")
  process.env.MERIDIAN_GOST_BIN = "gost-fake"
  assertSandboxed()
  app = mkApp()
})
afterEach(() => { try { rmSync(home, { recursive: true, force: true }) } catch {} })
afterAll(() => {
  for (const [k, v] of [["MERIDIAN_ADMIN_TOKEN", SAVED.admin], ["MERIDIAN_API_KEY", SAVED.key], ["CLAUDE_CONFIG_DIR", SAVED.cfg], ["MERIDIAN_EGRESS_PROXY_FILE", SAVED.ef]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

const goodCreds = () => ({ claudeAiOauth: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000, subscriptionType: "max" } })

describe("POST /admin/credentials", () => {
  it("401 without admin token (seat API key is NOT accepted)", async () => {
    expect((await call("POST", "/admin/credentials", null, { credentials: goodCreds() })).status).toBe(401)
    expect((await call("POST", "/admin/credentials", SEATKEY, { credentials: goodCreds() })).status).toBe(401)
  })
  // NOTE: `claudeJson` is deliberately NOT exercised here — the handler writes
  // it to os.homedir()/.claude.json, and os.homedir() ignores a runtime HOME
  // override, so asserting it would write to the developer's real home.
  it("writes valid credentials to the profile config dir and returns 200", async () => {
    const r = await call("POST", "/admin/credentials", ADMIN, { credentials: goodCreds() })
    expect(r.status).toBe(200)
    expect(r.json.success).toBe(true)
    const credPath = join(cfgDir, ".credentials.json")
    expect(existsSync(credPath)).toBe(true)
    expect(JSON.parse(readFileSync(credPath, "utf-8")).claudeAiOauth.accessToken).toBe("at-1")
  })
  it("accepts credentials passed as a JSON string", async () => {
    const r = await call("POST", "/admin/credentials", ADMIN, { credentials: JSON.stringify(goodCreds()) })
    expect(r.status).toBe(200)
  })
  it("400 when credentials missing", async () => {
    expect((await call("POST", "/admin/credentials", ADMIN, {})).status).toBe(400)
  })
  it("400 when credentials lack claudeAiOauth.accessToken/refreshToken", async () => {
    expect((await call("POST", "/admin/credentials", ADMIN, { credentials: { foo: 1 } })).status).toBe(400)
    expect((await call("POST", "/admin/credentials", ADMIN, { credentials: { claudeAiOauth: { accessToken: "x" } } })).status).toBe(400)
  })
  it("400 on a non-JSON credentials string", async () => {
    expect((await call("POST", "/admin/credentials", ADMIN, { credentials: "not json" })).status).toBe(400)
  })
})

describe("POST/GET /admin/proxy", () => {
  it("401 without admin token", async () => {
    expect((await call("POST", "/admin/proxy", null, { socks5: null })).status).toBe(401)
    expect((await call("GET", "/admin/proxy", null)).status).toBe(401)
  })
  it("sets a socks5 proxy, persists it, and never echoes the URL back", async () => {
    const r = await call("POST", "/admin/proxy", ADMIN, { socks5: "socks5://u:p@1.2.3.4:6017" })
    expect(r.status).toBe(200)
    expect(r.json.proxy.enabled).toBe(true)
    expect(JSON.stringify(r.json)).not.toContain("1.2.3.4")
    const persisted = JSON.parse(readFileSync(process.env.MERIDIAN_EGRESS_PROXY_FILE!, "utf-8"))
    expect(persisted.socks5).toBe("socks5://u:p@1.2.3.4:6017")
  })
  it("removes the proxy (direct) via disable:true and persists null", async () => {
    await call("POST", "/admin/proxy", ADMIN, { socks5: "socks5://u:p@1.2.3.4:6017" })
    const r = await call("POST", "/admin/proxy", ADMIN, { disable: true })
    expect(r.status).toBe(200)
    expect(r.json.proxy.enabled).toBe(false)
    expect(JSON.parse(readFileSync(process.env.MERIDIAN_EGRESS_PROXY_FILE!, "utf-8")).socks5).toBeNull()
  })
  it("removes the proxy via socks5:null", async () => {
    const r = await call("POST", "/admin/proxy", ADMIN, { socks5: null })
    expect(r.status).toBe(200)
    expect(r.json.proxy.enabled).toBe(false)
  })
  it("400 on a non-socks5 scheme", async () => {
    expect((await call("POST", "/admin/proxy", ADMIN, { socks5: "http://nope" })).status).toBe(400)
  })
  it("400 on a bad body (no socks5 / disable)", async () => {
    expect((await call("POST", "/admin/proxy", ADMIN, { foo: 1 })).status).toBe(400)
  })
  it("GET reports current state", async () => {
    await call("POST", "/admin/proxy", ADMIN, { socks5: "socks5://u:p@9.9.9.9:6017" })
    const r = await call("GET", "/admin/proxy", ADMIN)
    expect(r.status).toBe(200)
    expect(r.json.enabled).toBe(true)
    expect(typeof r.json.endpoint).toBe("string")
  })
})
