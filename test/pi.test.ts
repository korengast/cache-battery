import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createExtension, parsePlaces, piFallbackTier, samplesFromPiEntries, type PiContext, type PiEntry } from '../src/pi.js'

const T0 = 1_800_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()
const reply = (at: number, usage: Record<string, number>): PiEntry => ({ type: 'message', timestamp: iso(at), message: { role: 'assistant', usage: usage as any } })

describe('samplesFromPiEntries', () => {
  it('reads assistant replies and cache-warmer refreshes', () => {
    const entries: PiEntry[] = [
      { type: 'message', timestamp: iso(T0), message: { role: 'user' } },
      reply(T0 + 1, { cacheRead: 0, cacheWrite: 100, cacheWrite1h: 0 }),
      { type: 'usage', kind: 'cache_warm', timestamp: iso(T0 + 2), usage: { cacheRead: 100, cacheWrite: 0 } },
      { type: 'usage', kind: 'other', timestamp: iso(T0 + 3), usage: { cacheRead: 1, cacheWrite: 0 } },
      { type: 'message', timestamp: 'bad', message: { role: 'assistant', usage: { cacheRead: 1, cacheWrite: 0 } } },
    ]
    expect(samplesFromPiEntries(entries)).toEqual([
      { at: T0 + 1, cacheRead: 0, cacheWrite: 100, write1h: 0, write5m: 100, refresh: false },
      { at: T0 + 2, cacheRead: 100, cacheWrite: 0, write1h: undefined, write5m: undefined, refresh: true },
    ])
  })
})

describe('piFallbackTier', () => {
  it('uses the long lifetime only with PI_CACHE_RETENTION=long', () => {
    const model = { promptCache: { short: 300, long: 3600 } }
    expect(piFallbackTier(model, {})).toBe('5m')
    expect(piFallbackTier(model, { PI_CACHE_RETENTION: 'long' })).toBe('1h')
    expect(piFallbackTier(undefined, { PI_CACHE_RETENTION: 'long' })).toBe('5m')
    expect(piFallbackTier(model, { CACHE_BATTERY_TTL: '1h' })).toBe('1h')
  })
})

describe('parsePlaces', () => {
  it('accepts the four places', () => {
    expect(parsePlaces(' Above ')).toBe('above')
    expect(parsePlaces('nope')).toBeUndefined()
  })
})

function harness(entries: PiEntry[], env: Record<string, string> = {}) {
  const handlers = new Map<string, (e: unknown, ctx: PiContext) => unknown>()
  const commands = new Map<string, (args: string, ctx: PiContext) => Promise<void>>()
  const configPath = join(mkdtempSync(join(tmpdir(), 'cb-pi-')), 'cache-battery.json')
  let clock = T0
  let timerFn: (() => void) | undefined
  let cleared = false
  const status: Array<string | undefined> = []
  const widgets: Array<string[] | undefined> = []
  const notes: string[] = []
  let leaf = 'a'
  const ctx: PiContext = {
    hasUI: true,
    model: { promptCache: { short: 300, long: 3600 } },
    sessionManager: { getBranch: () => entries, getLeafId: () => leaf },
    ui: {
      setStatus: (_k, t) => status.push(t),
      setWidget: (_k, w) => widgets.push(w),
      notify: (m) => notes.push(m),
    },
  }
  createExtension({
    env: { NO_COLOR: '1', ...env },
    configPath,
    now: () => clock,
    setInterval: (fn) => {
      timerFn = fn
      return {}
    },
    clearInterval: () => (cleared = true),
  })({ on: (e, h) => handlers.set(e, h), registerCommand: (n, o) => commands.set(n, o.handler) })
  return {
    ctx,
    configPath,
    status,
    widgets,
    notes,
    emit: (e: string) => handlers.get(e)!({}, ctx),
    command: (args: string) => commands.get('cache-battery')!(args, ctx),
    advance: (ms: number) => (clock += ms),
    setLeaf: (id: string) => (leaf = id),
    tick: () => timerFn?.(),
    cleared: () => cleared,
  }
}

describe('pi extension', () => {
  it('shows the battery in the footer and above the editor by default', () => {
    const h = harness([reply(T0, { cacheRead: 50, cacheWrite: 0 })])
    h.emit('session_start')
    expect(h.status.at(-1)).toBe('◔ ████████▌')
    expect(h.widgets.at(-1)).toEqual(['◔ ████████▌'])
  })

  it('drains on the timer and only repaints when the line changes', () => {
    const h = harness([reply(T0, { cacheRead: 50, cacheWrite: 0 })])
    h.emit('session_start')
    const paints = h.status.length
    h.tick()
    expect(h.status.length).toBe(paints)
    h.advance(150_000)
    h.tick()
    expect(h.status.at(-1)).toBe('◔ ████░░░░▌')
  })

  it('re-reads the branch when the leaf changes, so a warmer refresh shows charging', () => {
    const entries = [reply(T0, { cacheRead: 50, cacheWrite: 0 })]
    const h = harness(entries)
    h.emit('session_start')
    h.advance(270_000)
    entries.push({ type: 'usage', kind: 'cache_warm', timestamp: iso(T0 + 270_000), usage: { cacheRead: 50, cacheWrite: 0 } })
    h.setLeaf('b')
    h.tick()
    expect(h.status.at(-1)).toBe('◔ ████████▌ ⚡')
  })

  it('clears both places when the provider reports no cache use', () => {
    const h = harness([reply(T0, { cacheRead: 0, cacheWrite: 0 })])
    h.emit('session_start')
    expect(h.status.at(-1)).toBeUndefined()
    expect(h.widgets.at(-1)).toBeUndefined()
  })

  it('does nothing without a UI', () => {
    const h = harness([reply(T0, { cacheRead: 5, cacheWrite: 0 })])
    h.ctx.hasUI = false
    h.emit('session_start')
    expect(h.status).toEqual([])
  })

  it('switches places with /cache-battery and saves the choice', async () => {
    const h = harness([reply(T0, { cacheRead: 5, cacheWrite: 0 })])
    h.emit('session_start')
    await h.command('footer')
    expect(h.widgets.at(-1)).toBeUndefined()
    expect(h.status.at(-1)).toBe('◔ ████████▌')
    expect(JSON.parse(readFileSync(h.configPath, 'utf8'))).toEqual({ places: 'footer' })
    await h.command('')
    expect(h.notes.at(-1)).toContain('shows: footer')
    await h.command('sideways')
    expect(h.notes.at(-1)).toContain('Unknown place')
  })

  it('reads the saved place, lets env override it, and clears on shutdown', () => {
    const h = harness([reply(T0, { cacheRead: 5, cacheWrite: 0 })], { CACHE_BATTERY_PLACES: 'above' })
    h.emit('session_start')
    expect(h.status.at(-1)).toBeUndefined()
    expect(h.widgets.at(-1)).toEqual(['◔ ████████▌'])
    h.emit('session_shutdown')
    expect(h.cleared()).toBe(true)
    expect(h.widgets.at(-1)).toBeUndefined()
  })

  it('loads a saved place from the config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-cfg-'))
    const configPath = join(dir, 'c.json')
    writeFileSync(configPath, JSON.stringify({ places: 'off' }))
    const status: Array<string | undefined> = []
    const handlers = new Map<string, any>()
    createExtension({ env: { NO_COLOR: '1' }, configPath, now: () => T0, setInterval: () => ({}) })({
      on: (e, h) => handlers.set(e, h),
      registerCommand: () => {},
    })
    handlers.get('session_start')({}, {
      hasUI: true,
      sessionManager: { getBranch: () => [reply(T0, { cacheRead: 5, cacheWrite: 0 })], getLeafId: () => 'a' },
      ui: { setStatus: (_k: string, t: string) => status.push(t), setWidget: () => {}, notify: () => {} },
    })
    expect(status).toEqual([undefined])
  })
})
