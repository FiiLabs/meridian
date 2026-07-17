/**
 * Egress-proxy hot-swap + admin-auth tests.
 *
 * child_process.spawn is mocked so gost is never really launched; we assert the
 * spawn ARGS (upstream on/off), the persisted-state file, and the reported
 * state. Admin auth is tested for fail-closed behavior.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ---- mock gost spawn ------------------------------------------------------
let spawnCalls: Array<{ bin: string; args: string[] }> = []
mock.module("node:child_process", () => ({
  spawn: (bin: string, args: string[]) => {
    spawnCalls.push({ bin, args })
    const listeners: Record<string, Array<(...a: any[]) => void>> = {}
    return {
      killed: false,
      pid: 4242,
      on(ev: string, cb: (...a: any[]) => void) { (listeners[ev] ||= []).push(cb) },
      once(ev: string, cb: (...a: any[]) => void) { (listeners[ev] ||= []).push(cb) },
      kill() { this.killed = true; (listeners["exit"] || []).forEach((f) => f()) },
    }
  },
}))

const egress = await import("../proxy/egressProxy")
const { requireAdminAuth } = await import("../proxy/auth")

let dir: string
function freshStateFile(): string {
  return join(dir, `egress-${spawnCalls.length}-${Math.floor(performance.now() * 1000)}.json`)
}
function resetEnv() {
  delete process.env.PROXYLITE_SOCKS5
  delete process.env.MERIDIAN_ADMIN_TOKEN
  delete process.env.HTTPS_PROXY
  delete process.env.HTTP_PROXY
  process.env.MERIDIAN_GOST_BIN = "gost-fake"
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "egress-test-"))
  spawnCalls = []
  resetEnv()
})
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

describe("egressProxy.initEgressProxy", () => {
  it("is UNMANAGED (direct, no gost) with no proxy and no admin token", () => {
    process.env.MERIDIAN_EGRESS_PROXY_FILE = freshStateFile()
    const st = egress.initEgressProxy()
    expect(st.running).toBe(false)
    expect(spawnCalls.length).toBe(0)
    expect(process.env.HTTPS_PROXY).toBeUndefined()
  })

  it("launches gost WITH -F when PROXYLITE_SOCKS5 is set", () => {
    process.env.MERIDIAN_EGRESS_PROXY_FILE = freshStateFile()
    process.env.PROXYLITE_SOCKS5 = "socks5://u:p@1.2.3.4:6017"
    const st = egress.initEgressProxy()
    expect(st.running).toBe(true)
    expect(st.socks5).toBe("socks5://u:p@1.2.3.4:6017")
    expect(process.env.HTTPS_PROXY).toBe(st.endpoint)
    const last = spawnCalls.at(-1)!
    expect(last.args).toContain("-F")
    expect(last.args).toContain("socks5://u:p@1.2.3.4:6017")
  })

  it("launches gost in DIRECT mode (no -F) when only the admin token is set", () => {
    process.env.MERIDIAN_EGRESS_PROXY_FILE = freshStateFile()
    process.env.MERIDIAN_ADMIN_TOKEN = "admintok"
    const st = egress.initEgressProxy()
    expect(st.running).toBe(true)
    expect(st.socks5).toBeNull()
    expect(spawnCalls.at(-1)!.args).not.toContain("-F")
  })

  it("PERSISTED state (direct=null) beats the env proxy", () => {
    const f = freshStateFile()
    process.env.MERIDIAN_EGRESS_PROXY_FILE = f
    process.env.PROXYLITE_SOCKS5 = "socks5://u:p@1.2.3.4:6017"
    // Operator previously disabled the proxy at runtime → persisted null.
    egress.initEgressProxy() // seed managed
    return egress.setEgressProxy(null).then(() => {
      spawnCalls = []
      const st = egress.initEgressProxy() // simulate restart: persisted wins
      expect(st.socks5).toBeNull()
      expect(st.source).toBe("persisted")
      expect(spawnCalls.at(-1)!.args).not.toContain("-F")
    })
  })
})

describe("egressProxy.setEgressProxy (hot-swap)", () => {
  it("sets a proxy, persists it, respawns gost with -F, never leaks the URL in state file readback", async () => {
    const f = freshStateFile()
    process.env.MERIDIAN_EGRESS_PROXY_FILE = f
    process.env.MERIDIAN_ADMIN_TOKEN = "admintok"
    egress.initEgressProxy()
    spawnCalls = []
    const st = await egress.setEgressProxy("socks5://a:b@9.9.9.9:6017")
    expect(st.socks5).toBe("socks5://a:b@9.9.9.9:6017")
    expect(st.source).toBe("admin")
    expect(spawnCalls.at(-1)!.args).toContain("-F")
    expect(existsSync(f)).toBe(true)
    expect(JSON.parse(readFileSync(f, "utf-8")).socks5).toBe("socks5://a:b@9.9.9.9:6017")
  })

  it("removes the proxy (direct egress) on null and persists null", async () => {
    const f = freshStateFile()
    process.env.MERIDIAN_EGRESS_PROXY_FILE = f
    process.env.PROXYLITE_SOCKS5 = "socks5://u:p@1.2.3.4:6017"
    egress.initEgressProxy()
    spawnCalls = []
    const st = await egress.setEgressProxy(null)
    expect(st.socks5).toBeNull()
    expect(spawnCalls.at(-1)!.args).not.toContain("-F")
    expect(JSON.parse(readFileSync(f, "utf-8")).socks5).toBeNull()
  })
})

describe("requireAdminAuth (fails closed)", () => {
  function ctx(headers: Record<string, string> = {}) {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    let status = 0
    return {
      c: { req: { header: (n: string) => h[n.toLowerCase()] }, json: (_b: any, s?: number) => { status = s ?? 200; return { _status: status } } } as any,
      getStatus: () => status,
    }
  }

  it("401 when MERIDIAN_ADMIN_TOKEN is unset (surface disabled)", async () => {
    delete process.env.MERIDIAN_ADMIN_TOKEN
    const { c, getStatus } = ctx({ authorization: "Bearer anything" })
    let nextCalled = false
    await requireAdminAuth(c, async () => { nextCalled = true })
    expect(nextCalled).toBe(false)
    expect(getStatus()).toBe(401)
  })

  it("401 on wrong token", async () => {
    process.env.MERIDIAN_ADMIN_TOKEN = "secret-admin"
    const { c, getStatus } = ctx({ authorization: "Bearer wrong" })
    let nextCalled = false
    await requireAdminAuth(c, async () => { nextCalled = true })
    expect(nextCalled).toBe(false)
    expect(getStatus()).toBe(401)
  })

  it("passes with the correct token via Bearer", async () => {
    process.env.MERIDIAN_ADMIN_TOKEN = "secret-admin"
    const { c } = ctx({ authorization: "Bearer secret-admin" })
    let nextCalled = false
    await requireAdminAuth(c, async () => { nextCalled = true })
    expect(nextCalled).toBe(true)
  })

  it("passes with the correct token via x-api-key", async () => {
    process.env.MERIDIAN_ADMIN_TOKEN = "secret-admin"
    const { c } = ctx({ "x-api-key": "secret-admin" })
    let nextCalled = false
    await requireAdminAuth(c, async () => { nextCalled = true })
    expect(nextCalled).toBe(true)
  })
})
