/**
 * dsh-savetoken-autolaunch — Host half.
 *
 * Token saving first: whenever a *user* question is proposed as a step, this
 * plugin rejects that step, so the turn closes **before any model request** and
 * costs 0 tokens. As the visible half of the same trigger it opens the official
 * Genshin Impact (原神) desktop download page in the default browser and, by
 * default, downloads the official PC installer (`yuanshen_setup_*.exe`).
 *
 * Deliberate limitation: this module imports **only Node built-ins**. The
 * running Host ships a newer DSH runtime than the stale packages sitting in
 * the profile's `node_modules`, so importing any `@deepseek-ai/*` package
 * risks loading a second, mismatched copy of a shared library. Configuration
 * therefore carries its own defaults (`resolveConfig`) instead of a
 * schemastery schema.
 *
 * @module dsh-savetoken-autolaunch
 */

import { spawn } from 'node:child_process'
import { appendFileSync, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Cordis plugin name. */
export const name = 'savetoken-autolaunch'

/** Bumped whenever the loaded module changes, so the log states which code is live. */
export const PLUGIN_VERSION = '1.2.1'

// HMR marker: editing this file must hot-swap the plugin while the profile
// watches this directory (`hmr.root`), so code changes need no restart.

/** Official 原神 CN download page. */
export const DEFAULT_DOWNLOAD_PAGE = 'https://ys.mihoyo.com/download/'

/**
 * Official mihoyo "download porter" endpoint. A GET answers a redirect to the
 * current signed installer URL, so the plugin never hardcodes a build date.
 */
export const DEFAULT_INSTALLER_ENDPOINT =
  'https://api-takumi.mihoyo.com/event/download_porter/link/ys_cn/official/pc_backup'

/** Configuration defaults; every field may be overridden from the profile patch. */
export const DEFAULTS = {
  /** Master switch. */
  enabled: true,
  /** Open the official download page in the default browser. */
  openBrowser: true,
  /** Page opened when `openBrowser` is on. */
  downloadPageUrl: DEFAULT_DOWNLOAD_PAGE,
  /** `installer` downloads the official PC installer; `none` only opens the page. */
  download: 'installer',
  /** Endpoint resolving the current installer URL. */
  installerEndpoint: DEFAULT_INSTALLER_ENDPOINT,
  /** Download folder; empty means `<home>/Downloads/genshin-desktop`. */
  targetDir: '',
  /**
   * Reject the proposed step, so the turn closes **before any model request**:
   * the question costs no tokens, and the plugin is the only thing that answers.
   */
  stopTurn: true,
  /** Fire at most once per Agent (session) instead of on every user message. */
  oncePerSession: false,
  /** Minimum gap between two triggers, across sessions, in milliseconds. */
  cooldownMs: 0,
  /** Log a progress line every N percent. */
  progressStepPercent: 5,
  /** Log file; empty means `<targetDir>/genshin-autolaunch.log`. */
  logFile: '',
  /** Report the plan without opening a browser or downloading anything. */
  dryRun: false,
}

/**
 * Merge user configuration over the defaults and resolve every path.
 * @param raw - configuration object supplied by the profile patch, if any.
 * @returns a complete, path-resolved configuration.
 */
export function resolveConfig(raw) {
  const config = { ...DEFAULTS, ...(raw ?? {}) }
  config.targetDir = resolve(config.targetDir || join(homedir(), 'Downloads', 'genshin-desktop'))
  config.logFile = resolve(config.logFile || join(config.targetDir, 'genshin-autolaunch.log'))
  config.cooldownMs = Number.isFinite(config.cooldownMs) ? Math.max(0, config.cooldownMs) : DEFAULTS.cooldownMs
  config.progressStepPercent =
    Number.isFinite(config.progressStepPercent) && config.progressStepPercent > 0
      ? config.progressStepPercent
      : DEFAULTS.progressStepPercent
  return config
}

/** Best-effort human-readable form of a thrown value. */
function describe(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Build the append-only logger for one plugin instance. Logging must never
 * break the plugin, so every filesystem failure is swallowed.
 * @param config - resolved configuration.
 * @returns a `log(message)` function.
 */
export function makeLogger(config) {
  return (message) => {
    const line = `[${new Date().toISOString()}] ${message}`
    try {
      mkdirSync(config.targetDir, { recursive: true })
      appendFileSync(config.logFile, `${line}\n`)
    } catch {
      /* logging is advisory only */
    }
    try {
      console.log(`[savetoken-autolaunch] ${message}`)
    } catch {
      /* ignore */
    }
  }
}

/** Last path segment of a URL, sanitized, or a fallback name. */
export function installerFileName(url) {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop()
    if (segment && /^[\w.-]+\.exe$/i.test(segment)) return segment
    if (segment) return segment.replace(/[^\w.-]/g, '_')
  } catch {
    /* fall through */
  }
  return 'yuanshen_setup.exe'
}

/**
 * Open a URL in the platform's default browser, detached from the Host.
 * @param url - absolute URL to open.
 */
export function openUrlInBrowser(url) {
  const platform = process.platform
  const command = platform === 'win32' ? 'cmd.exe' : platform === 'darwin' ? 'open' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

/**
 * Resolve the current signed installer URL from the official endpoint.
 * @param endpoint - porter endpoint.
 * @param signal - cancellation signal.
 * @returns the absolute installer URL.
 */
export async function resolveInstallerUrl(endpoint, signal) {
  const response = await fetch(endpoint, { redirect: 'manual', signal })
  const location = response.headers.get('location')
  if (location) return new URL(location, endpoint).toString()
  const type = response.headers.get('content-type') ?? ''
  if (response.ok && /ms-dos-executable|octet-stream/i.test(type)) return endpoint
  throw new Error(`installer link lookup failed: HTTP ${response.status} (${type || 'no content-type'})`)
}

/**
 * Stream a file to disk with progress logging and HTTP resume.
 * @param url - source URL.
 * @param dest - destination path.
 * @param options - logger, progress granularity and cancellation signal.
 * @returns the number of bytes written by this run and the total size reported by the server.
 */
export async function downloadFile(url, dest, { log, progressStepPercent = 5, signal }) {
  const have = existsSync(dest) ? statSync(dest).size : 0
  const headers = have > 0 ? { Range: `bytes=${have}-` } : {}
  const response = await fetch(url, { redirect: 'follow', signal, headers })
  // A 416 answers a Range starting at or past EOF: the local file is already complete.
  if (response.status === 416 && have > 0) {
    log(`already complete: ${dest} (${have} bytes)`)
    return { bytes: 0, total: have, complete: true }
  }
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)

  const resuming = have > 0 && response.status === 206
  const total = resuming
    ? have + Number(response.headers.get('content-length') ?? 0)
    : Number(response.headers.get('content-length') ?? 0)
  if (!resuming && have > 0) log(`server ignored Range; restarting ${dest}`)

  const source = Readable.fromWeb(response.body)
  let written = 0
  let nextMark = progressStepPercent
  source.on('data', (chunk) => {
    written += chunk.length
    if (total > 0) {
      const percent = ((have + written) / total) * 100
      if (percent >= nextMark) {
        log(`downloaded ${percent.toFixed(0)}% (${have + written}/${total} bytes)`)
        nextMark += progressStepPercent
      }
    }
  })

  await pipeline(source, createWriteStream(dest, { flags: resuming ? 'a' : 'w' }))
  return { bytes: written, total }
}

/** Side effects, injectable so the plugin can be exercised without a browser or network. */
export const defaultDeps = {
  now: () => Date.now(),
  openUrl: openUrlInBrowser,
  resolveInstallerUrl,
  downloadFile,
}

/**
 * Create one `apply` implementation over injectable side effects.
 * @param overrides - replacements for {@link defaultDeps} entries.
 * @returns a Cordis-compatible `apply(ctx, config)` function.
 */
export function makeApply(overrides = {}) {
  const deps = { ...defaultDeps, ...overrides }

  return function apply(ctx, rawConfig) {
    const config = resolveConfig(rawConfig)
    const log = makeLogger(config)
    log(
      `v${PLUGIN_VERSION} applied: openBrowser=${config.openBrowser} download=${config.download} ` +
        `oncePerSession=${config.oncePerSession} dryRun=${config.dryRun} targetDir=${config.targetDir}`,
    )
    if (!config.enabled) {
      log('disabled by configuration; no listener registered')
      return
    }

    /** Session ids already served, for `oncePerSession` (ids survive re-dispatch). */
    const firedSessions = new Set()
    /** Agents without a usable id, so identity still works when an id is absent. */
    const firedAgents = new WeakSet()
    /** Timestamp of the last trigger, shared across sessions. */
    let lastFiredAt = 0
    /** Running downloads, retained so disposal cannot orphan a rejection. */
    const inflight = new Set()
    /** Cancellation channels of the downloads this instance started. */
    const controllers = new Set()

    /**
     * Start the configured actions for one trigger.
     */
    function run() {
      if (config.dryRun) {
        log('[dryRun] would open the official download page and download the installer')
        return
      }
      if (config.openBrowser) {
        try {
          deps.openUrl(config.downloadPageUrl)
          log(`opened browser: ${config.downloadPageUrl}`)
        } catch (error) {
          log(`open browser failed: ${describe(error)}`)
        }
      }
      if (config.download !== 'none') {
        const controller = new AbortController()
        controllers.add(controller)
        const task = downloadInstaller(config, deps, log, controller.signal)
          .catch((error) => {
            log(controller.signal.aborted ? 'download aborted (plugin disabled)' : `download failed: ${describe(error)}`)
          })
          .finally(() => {
            controllers.delete(controller)
            inflight.delete(task)
          })
        inflight.add(task)
      }
    }

    /**
     * Whether this Agent was already served under `oncePerSession`.
     * @param agent - the subject Agent, when the dispatcher supplied one.
     * @returns true when this session must not trigger again.
     */
    function alreadyFired(agent) {
      if (agent === undefined) return false
      return agent.id === undefined ? firedAgents.has(agent) : firedSessions.has(agent.id)
    }

    /**
     * Record one Agent as served.
     * @param agent - the subject Agent, when the dispatcher supplied one.
     */
    function markFired(agent) {
      if (agent === undefined) return
      if (agent.id === undefined) firedAgents.add(agent)
      else firedSessions.add(agent.id)
    }

    /**
     * Decide whether this proposed step is a trigger.
     * @param payload - the `agent/pre-step` payload.
     * @returns `{ agent, message }` to fire, or `undefined` to leave the step alone.
     */
    function decide(payload) {
      const messages = Array.isArray(payload?.messages) ? payload.messages : []
      if (messages.length > 0 || payload?.messages === undefined) {
        const kinds = messages.map((candidate) => candidate?.source?.kind ?? '?').join(',')
        log(`pre-step seen: ${messages.length} message(s) sources=[${kinds}]`)
      }
      const message = messages.find((candidate) => candidate?.source?.kind === 'user')
      if (message === undefined) return undefined

      const agent = payload?.agent
      if (config.oncePerSession && alreadyFired(agent)) {
        log('skip: this session already triggered')
        return undefined
      }

      const now = deps.now()
      if (lastFiredAt !== 0 && now - lastFiredAt < config.cooldownMs) {
        log(`skip: cooldown, ${config.cooldownMs - (now - lastFiredAt)} ms remaining`)
        return undefined
      }

      markFired(agent)
      lastFiredAt = now
      return { agent, message }
    }

    ctx.on('agent/pre-step', (payload, next) => {
      let plan
      try {
        plan = decide(payload)
      } catch (error) {
        // Fail open: a broken plugin must never be able to swallow every question.
        log(`decision threw: ${describe(error)}; letting the turn continue`)
        return next()
      }
      if (plan === undefined) return next()

      log(`trigger: user message ${plan.message.id ?? '(no id)'} in session ${plan.agent?.id ?? '(no id)'}`)
      run()

      if (config.stopTurn && !config.dryRun) {
        log('stopping the turn before any model request (0 tokens spent)')
        return { kind: 'reject' }
      }
      return next()
    })

    log('listening on agent/pre-step')

    // Cordis runs `dispose` listeners when this entry is disabled, removed or
    // the profile recomposes. Abort whatever this instance started, so "off"
    // also means "stop downloading", and log it so a toggle is visible.
    // NOTE: returning a disposer from `apply` is NOT honoured by this loader —
    // measured: five re-applications logged no unload line until this hook.
    ctx.on('dispose', () => {
      const aborted = controllers.size
      for (const controller of controllers) controller.abort(new Error('plugin disposed'))
      controllers.clear()
      log(`v${PLUGIN_VERSION} disposed (disabled or removed); aborted ${aborted} download(s)`)
    })
  }
}

/**
 * Resolve and download the official PC installer.
 * @param config - resolved configuration.
 * @param deps - side-effect implementations.
 * @param log - logger.
 * @param signal - cancellation channel owned by the plugin instance.
 * @returns the path of the downloaded installer.
 */
async function downloadInstaller(config, deps, log, signal) {
  mkdirSync(config.targetDir, { recursive: true })
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(24 * 60 * 60 * 1000)])
  log(`resolving the official installer link: ${config.installerEndpoint}`)
  const url = await deps.resolveInstallerUrl(config.installerEndpoint, deadline)
  const dest = join(config.targetDir, installerFileName(url))
  log(`installer: ${url}`)
  log(`destination: ${dest}`)
  const result = await deps.downloadFile(url, dest, {
    log,
    progressStepPercent: config.progressStepPercent,
    signal: deadline,
  })
  log(`download complete: ${dest} (+${result.bytes} bytes, total ${result.total || 'unknown'})`)
  return dest
}

/** The plugin's `apply`, built over the real side effects. */
export const apply = makeApply()
