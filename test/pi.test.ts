import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createExtension, parsePlaces, piFallbackTier, samplesFromPiEntries, type PiContext, type PiEntry } from '../src/pi.js'

const T0 = 1_800_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()
const reply = (at: number, usage: Record<string, number>, provider?: string): PiEntry => ({ type: 'message', timestamp: iso(at), message: { role: 'assistant', provider, usage: usage as any } })

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

describe('cursor replies', () => {
  it('count as estimated refreshes when Cursor reports no cache numbers', () => {
    expect(samplesFromPiEntries([reply(T0, { cacheRead: 0, cacheWrite: 0 }, 'cursor')])).toEqual([
      { at: T0, cacheRead: 0, cacheWrite: 0, write1h: undefined, write5m: undefined, refresh: false, estimated: true },
    ])
  })

  it('keep real numbers when Cursor reports them', () => {
    expect(samplesFromPiEntries([reply(T0, { cacheRead: 5, cacheWrite: 9 }, 'cursor')])[0].estimated).toBeUndefined()
  })

  it('stay unestimated on other providers', () => {
    expect(samplesFromPiEntries([reply(T0, { cacheRead: 0, cacheWrite: 0 }, 'openai')])[0].estimated).toBeUndefined()
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
    expect(parsePlaces('below')).toBe('footer')
    expect(parsePlaces('both')).toBeUndefined()
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
    emit: (e: string, event: unknown = {}) => handlers.get(e)!(event, ctx),
    command: (args: string) => commands.get('cache-battery')!(args, ctx),
    advance: (ms: number) => (clock += ms),
    setLeaf: (id: string) => (leaf = id),
    tick: () => timerFn?.(),
    cleared: () => cleared,
  }
}

describe('pi extension while a request runs', () => {
  it('stays full while a model request streams, then drains from its end', () => {
    const h = harness([reply(T0, { cacheRead: 50, cacheWrite: 0 })])
    h.emit('session_start')
    h.advance(150_000)
    h.emit('turn_start')
    h.advance(120_000)
    h.tick()
    expect(h.widgets.at(-1)).toEqual(['◔ ████████▌'])
    h.emit('message_end', { message: { role: 'assistant' } })
    h.advance(150_000)
    h.tick()
    expect(h.widgets.at(-1)).toEqual(['◔ ████░░░░▌'])
  })

  it('stays full for the whole Cursor run, because pi cannot see the model calls inside it', () => {
    const h = harness([reply(T0, { cacheRead: 0, cacheWrite: 0 }, 'cursor')])
    ;(h.ctx.model as any).provider = 'cursor'
    h.emit('session_start')
    h.emit('agent_start')
    h.emit('message_end', { message: { role: 'assistant' } })
    h.advance(400_000)
    h.tick()
    expect(h.widgets.at(-1)).toEqual(['○ ████████▌'])
    h.emit('agent_end')
    h.advance(150_000)
    h.tick()
    expect(h.widgets.at(-1)).toEqual(['○ ████░░░░▌'])
  })

  it('shows an estimated battery during the first Cursor run of a session', () => {
    const h = harness([])
    ;(h.ctx.model as any).provider = 'cursor'
    h.emit('session_start')
    h.emit('agent_start')
    h.tick()
    expect(h.widgets.at(-1)).toEqual(['○ ████████▌'])
  })
})

describe('pi extension', () => {
  it('shows the battery only above the editor by default', () => {
    const h = harness([reply(T0, { cacheRead: 50, cacheWrite: 0 })])
    h.emit('session_start')
    expect(h.widgets.at(-1)).toEqual(['◔ ████████▌'])
    expect(h.status.at(-1)).toBeUndefined()
  })

  it('drains on the timer and only repaints when the line changes', () => {
    const h = harness([reply(T0, { cacheRead: 50, cacheWrite: 0 })])
    h.emit('session_start')
    const paints = h.widgets.length
    h.tick()
    expect(h.widgets.length).toBe(paints)
    h.advance(150_000)
    h.tick()
    expect(h.widgets.at(-1)).toEqual(['◔ ████░░░░▌'])
  })

  it('re-reads the branch when the leaf changes, so a warmer refresh shows charging', () => {
    const entries = [reply(T0, { cacheRead: 50, cacheWrite: 0 })]
    const h = harness(entries)
    h.emit('session_start')
    h.advance(270_000)
    entries.push({ type: 'usage', kind: 'cache_warm', timestamp: iso(T0 + 270_000), usage: { cacheRead: 50, cacheWrite: 0 } })
    h.setLeaf('b')
    h.tick()
    expect(h.widgets.at(-1)).toEqual(['◔ ████████▌ ⚡'])
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
    expect(h.widgets).toEqual([])
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

  it('lets env override the place and clears on shutdown', () => {
    const h = harness([reply(T0, { cacheRead: 5, cacheWrite: 0 })], { CACHE_BATTERY_PLACES: 'below' })
    h.emit('session_start')
    expect(h.status.at(-1)).toBe('◔ ████████▌')
    expect(h.widgets.at(-1)).toBeUndefined()
    h.emit('session_shutdown')
    expect(h.cleared()).toBe(true)
    expect(h.status.at(-1)).toBeUndefined()
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

  it('treats a saved "both" from an older version as the default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-old-'))
    const configPath = join(dir, 'c.json')
    writeFileSync(configPath, JSON.stringify({ places: 'both' }))
    const widgets: unknown[] = []
    const handlers = new Map<string, any>()
    createExtension({ env: { NO_COLOR: '1' }, configPath, now: () => T0, setInterval: () => ({}) })({
      on: (e, h) => handlers.set(e, h),
      registerCommand: () => {},
    })
    handlers.get('session_start')({}, {
      hasUI: true,
      sessionManager: { getBranch: () => [reply(T0, { cacheRead: 5, cacheWrite: 0 })], getLeafId: () => 'a' },
      ui: { setStatus: () => {}, setWidget: (_k: string, w: unknown) => widgets.push(w), notify: () => {} },
    })
    expect(widgets).toEqual([['◔ ████████▌']])
  })
})
