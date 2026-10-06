import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { colorEnabled, parseNumbers, renderBattery, toAnsi } from './core/render.js'
import { fromSamples, type CacheState, type Env, type Tier, type UsageSample } from './core/state.js'

interface PiUsage {
  cacheRead: number
  cacheWrite: number
  cacheWrite1h?: number
}

export interface PiEntry {
  type: string
  timestamp: string
  kind?: string
  usage?: PiUsage
  message?: { role?: string; provider?: string; usage?: PiUsage }
}

/** Cursor's SDK reports usage once per agent run, so most of its replies carry no cache numbers. */
const ESTIMATED_PROVIDERS = new Set(['cursor'])

interface PiModel {
  promptCache?: { short?: number; long?: number }
}

export interface PiContext {
  hasUI: boolean
  model?: PiModel
  sessionManager: { getBranch(): PiEntry[]; getLeafId(): string | null | undefined }
  ui: {
    setStatus(key: string, text: string | undefined): void
    setWidget(key: string, content: string[] | undefined): void
    notify(message: string, type?: 'info' | 'warning' | 'error'): void
  }
}

export interface PiApi {
  on(event: string, handler: (event: unknown, ctx: PiContext) => unknown): void
  registerCommand(name: string, options: { description: string; handler: (args: string, ctx: PiContext) => Promise<void> }): void
}

export type Places = 'above' | 'footer' | 'off'
const PLACES: readonly Places[] = ['above', 'footer', 'off']
const DEFAULT_PLACE: Places = 'above'
const KEY = 'cache-battery'
const CONFIG_PATH = join(homedir(), '.pi', 'agent', 'cache-battery.json')

function sampleOf(usage: PiUsage, at: number, refresh: boolean): UsageSample {
  const write1h = usage.cacheWrite1h
  return {
    at,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    write1h,
    write5m: write1h === undefined ? undefined : (usage.cacheWrite ?? 0) - write1h,
    refresh,
  }
}

/** Assistant replies and pi cache-warmer refreshes on the current branch, oldest first. */
export function samplesFromPiEntries(entries: readonly PiEntry[]): UsageSample[] {
  const samples: UsageSample[] = []
  for (const entry of entries) {
    const at = Date.parse(entry.timestamp)
    if (Number.isNaN(at)) continue
    if (entry.type === 'message' && entry.message?.role === 'assistant' && entry.message.usage) {
      const sample = sampleOf(entry.message.usage, at, false)
      const noNumbers = sample.cacheRead + sample.cacheWrite <= 0
      samples.push(noNumbers && ESTIMATED_PROVIDERS.has(entry.message.provider ?? '') ? { ...sample, estimated: true } : sample)
    }
    else if (entry.type === 'usage' && entry.kind === 'cache_warm' && entry.usage) samples.push(sampleOf(entry.usage, at, true))
  }
  return samples
}

/** Pi's own retention choice: `PI_CACHE_RETENTION=long` picks the model's long lifetime when it declares one. */
export function piFallbackTier(model: PiModel | undefined, env: Env): Tier {
  if (env.CACHE_BATTERY_TTL === '5m' || env.CACHE_BATTERY_TTL === '1h') return env.CACHE_BATTERY_TTL
  const long = env.PI_CACHE_RETENTION === 'long' ? model?.promptCache?.long : undefined
  return long !== undefined && long >= 3600 ? '1h' : '5m'
}

export function parsePlaces(value: string | undefined): Places | undefined {
  const wanted = value?.trim().toLowerCase()
  return PLACES.find((p) => p === (wanted === 'below' ? 'footer' : wanted))
}

function loadPlaces(env: Env, path: string): Places {
  const fromEnv = parsePlaces(env.CACHE_BATTERY_PLACES)
  if (fromEnv) return fromEnv
  try {
    return parsePlaces(JSON.parse(readFileSync(path, 'utf8')).places) ?? DEFAULT_PLACE
  } catch {
    return DEFAULT_PLACE
  }
}

function savePlaces(places: Places, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ places }) + '\n')
}

export interface PiOptions {
  env?: Env
  configPath?: string
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => { unref?(): void }
  clearInterval?: (handle: unknown) => void
}

export function createExtension(options: PiOptions = {}) {
  const env = options.env ?? process.env
  const configPath = options.configPath ?? CONFIG_PATH
  const now = options.now ?? Date.now
  const startTimer = options.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const stopTimer = options.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout))

  return function extension(pi: PiApi): void {
    let ctx: PiContext | undefined
    let timer: unknown
    let leafId: string | null | undefined
    let state: CacheState | undefined
    let lastLine: string | undefined
    let places = loadPlaces(env, configPath)
    const renderOptions = { numbers: parseNumbers(env.CACHE_BATTERY_NUMBERS) }
    const color = colorEnabled(env)

    const paint = (line: string | undefined) => {
      if (!ctx) return
      ctx.ui.setStatus(KEY, places === 'footer' ? line : undefined)
      ctx.ui.setWidget(KEY, places === 'above' && line ? [line] : undefined)
    }

    const tick = (force = false) => {
      if (!ctx?.hasUI) return
      const leaf = ctx.sessionManager.getLeafId()
      if (force || leaf !== leafId) {
        leafId = leaf
        state = fromSamples(samplesFromPiEntries(ctx.sessionManager.getBranch()), piFallbackTier(ctx.model, env))
      }
      const segments = renderBattery(state, now(), renderOptions)
      const line = segments.length ? toAnsi(segments, color) : undefined
      if (!force && line === lastLine) return
      lastLine = line
      paint(line)
    }

    const attach = (next: PiContext) => {
      ctx = next
      if (timer === undefined) {
        const handle = startTimer(() => tick(), 1000)
        handle.unref?.()
        timer = handle
      }
      tick(true)
    }

    pi.on('session_start', (_event, next) => attach(next))
    pi.on('message_end', (_event, next) => attach(next))
    pi.on('model_select', (_event, next) => attach(next))
    pi.on('session_shutdown', () => {
      if (timer !== undefined) stopTimer(timer)
      timer = undefined
      paint(undefined)
      ctx = undefined
    })

    pi.registerCommand(KEY, {
      description: 'Where the cache battery shows: above (the editor, default), footer (below), or off',
      handler: async (args, next) => {
        ctx = next
        const wanted = parsePlaces(args)
        if (!args.trim()) return next.ui.notify(`cache-battery shows: ${places}. Use /cache-battery above|footer|off.`, 'info')
        if (!wanted) return next.ui.notify(`Unknown place "${args.trim()}". Use above, footer (or below), or off.`, 'warning')
        places = wanted
        try {
          savePlaces(places, configPath)
        } catch (error) {
          next.ui.notify(`cache-battery could not save the setting: ${String(error)}`, 'warning')
        }
        tick(true)
        next.ui.notify(`cache-battery now shows: ${places}.`, 'info')
      },
    })
  }
}

export default createExtension()
