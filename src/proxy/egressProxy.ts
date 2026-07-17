/**
 * Egress proxy management (ProxyLite hot-swap).
 *
 * Meridian owns the outbound egress path so the ProxyLite SOCKS5 account can be
 * swapped — or removed entirely (direct egress) — WITHOUT restarting the
 * container. The Claude Code SDK subprocess and Meridian's own fetches honor
 * HTTP proxy env only, so a local `gost` shim always listens on
 * 127.0.0.1:<port> and HTTP(S)_PROXY point at it CONSTANTLY. Only gost's
 * UPSTREAM (`-F socks5://…`, or none for direct) changes on a swap, so the SDK
 * subprocess env never churns — in-flight sessions are untouched and the next
 * session picks up the new route.
 *
 * State is persisted to a file on the seat's PERSISTENT volume so a hot-set
 * route survives a container restart (otherwise a restart would revert to the
 * possibly-dead ProxyLite account baked into sealed env).
 *
 * Previously this lived in entrypoint.sh (gost launched once at boot); moving it
 * here is what makes it reloadable via the /admin/proxy endpoint.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const DEFAULT_PORT = 8118

export interface EgressState {
  /** Active upstream SOCKS5 URL, or null for direct egress (gost forwards directly). */
  socks5: string | null
  /** Whether the local gost shim is currently running. */
  running: boolean
  /** Local HTTP proxy endpoint the SDK subprocess is pointed at. */
  endpoint: string
  source: "persisted" | "env" | "admin" | "none"
}

let gostProc: ChildProcess | null = null
let currentUpstream: string | null = null
let currentSource: EgressState["source"] = "none"
let managed = false

function port(): number {
  const raw = process.env.MERIDIAN_EGRESS_PROXY_PORT
  const n = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT
}

function endpoint(): string {
  return `http://127.0.0.1:${port()}`
}

/** Persisted-state file on the seat's persistent volume (~/.claude by default). */
export function stateFilePath(): string {
  return (
    process.env.MERIDIAN_EGRESS_PROXY_FILE ||
    join(homedir(), ".claude", "egress-proxy.json")
  )
}

function readPersisted(): string | null | undefined {
  const p = stateFilePath()
  if (!existsSync(p)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8"))
    // socks5 may be an explicit null (operator chose direct) — distinguish from
    // "no persisted state" (undefined) so a persisted `null` beats the env.
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, "socks5")) {
      const v = parsed.socks5
      return typeof v === "string" && v.trim() ? v.trim() : null
    }
  } catch {
    /* ignore malformed state — fall back to env */
  }
  return undefined
}

function writePersisted(socks5: string | null): void {
  const p = stateFilePath()
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify({ socks5, updatedAt: Date.now() }), { mode: 0o600 })
  } catch (e) {
    console.error(`[egress] failed to persist proxy state to ${p}: ${(e as Error).message}`)
  }
}

/** Point Meridian's own + the SDK subprocess's HTTP proxy env at the local shim. */
function exportProxyEnv(): void {
  const ep = endpoint()
  process.env.HTTP_PROXY = ep
  process.env.HTTPS_PROXY = ep
  process.env.http_proxy = ep
  process.env.https_proxy = ep
  const noProxy = process.env.NO_PROXY || "127.0.0.1,localhost"
  process.env.NO_PROXY = noProxy
  process.env.no_proxy = noProxy
}

/** Spawn (or respawn) the gost shim for the given upstream (null = direct). */
function spawnGost(upstream: string | null): void {
  const bin = process.env.MERIDIAN_GOST_BIN || "gost"
  const args = ["-L", `http://127.0.0.1:${port()}`]
  if (upstream) args.push("-F", upstream)
  try {
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "inherit"] })
    proc.on("error", (err) => {
      console.error(`[egress] gost spawn error: ${err.message} — egress may be direct/broken`)
    })
    gostProc = proc
    console.error(`[egress] gost listening on http://127.0.0.1:${port()} upstream=${upstream ? "socks5(set)" : "DIRECT"}`)
  } catch (e) {
    console.error(`[egress] failed to launch gost: ${(e as Error).message}`)
    gostProc = null
  }
}

function killGost(): Promise<void> {
  const proc = gostProc
  gostProc = null
  if (!proc || proc.killed) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => resolve()
    proc.once("exit", done)
    proc.kill("SIGTERM")
    // Safety: don't hang forever if the process is unresponsive.
    setTimeout(() => {
      try { proc.kill("SIGKILL") } catch {}
      resolve()
    }, 1500).unref?.()
  })
}

/**
 * Initialize egress management at server startup. Resolves the initial upstream
 * with precedence: persisted volume state > PROXYLITE_SOCKS5 env > none.
 *
 * The shim is managed when a proxy is configured OR the admin surface is enabled
 * (MERIDIAN_ADMIN_TOKEN set) so a later /admin/proxy call can turn a proxy on
 * without a restart. Otherwise egress stays truly direct (backward compatible).
 */
export function initEgressProxy(): EgressState {
  const persisted = readPersisted()
  const envUpstream = (process.env.PROXYLITE_SOCKS5 || "").trim() || null
  const adminEnabled = Boolean(process.env.MERIDIAN_ADMIN_TOKEN)

  let upstream: string | null
  if (persisted !== undefined) {
    upstream = persisted
    currentSource = "persisted"
  } else if (envUpstream) {
    upstream = envUpstream
    currentSource = "env"
  } else {
    upstream = null
    currentSource = "none"
  }

  managed = Boolean(upstream) || persisted !== undefined || adminEnabled
  currentUpstream = upstream

  if (!managed) {
    console.error("[egress] no proxy configured and admin disabled — direct egress, gost not managed")
    return { socks5: null, running: false, endpoint: endpoint(), source: "none" }
  }

  exportProxyEnv()
  spawnGost(upstream)
  return { socks5: upstream, running: Boolean(gostProc), endpoint: endpoint(), source: currentSource }
}

/**
 * Hot-swap the egress upstream. `null` removes the proxy (direct egress). Persists
 * the choice to the volume and respawns gost on the SAME local port, so the SDK
 * subprocess env is unchanged and only newly-opened connections take the new
 * route. Idempotent when the upstream is unchanged.
 */
export async function setEgressProxy(socks5: string | null): Promise<EgressState> {
  const next = socks5 && socks5.trim() ? socks5.trim() : null
  writePersisted(next)

  if (!managed) {
    // First time enabling management at runtime (admin turned a proxy on).
    managed = true
    exportProxyEnv()
  }
  if (next === currentUpstream && gostProc && !gostProc.killed) {
    currentUpstream = next
    currentSource = "admin"
    return getEgressState()
  }

  await killGost()
  currentUpstream = next
  currentSource = "admin"
  exportProxyEnv()
  spawnGost(next)
  return getEgressState()
}

export function getEgressState(): EgressState {
  return {
    socks5: currentUpstream,
    running: Boolean(gostProc && !gostProc.killed),
    endpoint: endpoint(),
    source: currentSource,
  }
}
