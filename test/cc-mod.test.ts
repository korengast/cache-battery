import { describe, expect, it } from 'vitest'
import { modOptions, toInk } from '../src/cc-mod.js'
import { register } from '../hooks/register.mjs'

interface ModContext {
  clock: { now(): Promise<number>; every(ms: number, fn: () => unknown): unknown }
  env: { get(name: string): Promise<string | undefined> }
  ui: { invalidate(name: string): void; resolve(event: unknown): { Box: (p: any) => unknown; Text: (p: any) => unknown } }
}

type Handler = (...args: any[]) => any

function harness(env: Record<string, string> = {}) {
  const handlers = new Map<string, Handler>()
  const ticks: Array<() => unknown> = []
  let clock = 1_800_000_000_000
  let invalidations = 0
  const $: ModContext = {
    clock: { now: async () => clock, every: (_ms, fn) => ticks.push(fn) },
    env: { get: async (k) => env[k] },
    ui: {
      invalidate: () => invalidations++,
      resolve: () => ({ Box: (p) => ({ Box: p }), Text: (p) => ({ Text: p }) }),
    },
  }
  register((event: string, a: unknown, b?: Handler) => {
    const key = b ? `${event}:${JSON.stringify(a)}` : event
    handlers.set(key, (b ?? a) as Handler)
  })
  const next = async (e: unknown) => e
  return {
    $,
    handlers,
    advance: (ms: number) => (clock += ms),
    invalidations: () => invalidations,
    tick: () => Promise.all(ticks.map((t) => t())),
    start: () => handlers.get('session.start')!($, {}, next),
    async step(usage: unknown, agentId?: string) {
      async function* inner() {
        return { usage }
      }
      const gen = handlers.get('turn.step')!($, { agentId }, inner)
      let r = await gen.next()
      while (!r.done) r = await gen.next()
      return r.value
    },
    render: () => handlers.get('ui.render:{"component":"AbovePrompt"}')!($, { props: {} }, async () => null),
  }
}

const texts = (tree: any): string =>
  tree.Box.children[0].Box.children[0].Box.children.map((c: any) => c.Text.children.join('')).join('')

describe('cc mod', () => {
  it('draws nothing before the first request', async () => {
    const h = harness()
    await h.start()
    expect(await h.render()).toBeNull()
  })

  it('draws a battery above the prompt after a request and learns the tier from the write bucket', async () => {
    const h = harness()
    await h.start()
    await h.step({ cache_read_input_tokens: 0, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 500 } })
    expect(texts(await h.render())).toBe('◔ ████████▌')
    await h.step({ cache_read_input_tokens: 500 })
    h.advance(150_000)
    expect(texts(await h.render())).toBe('◔ ████████▌')
  })

  it('ignores subagent requests', async () => {
    const h = harness()
    await h.start()
    await h.step({ cache_read_input_tokens: 5 }, 'agent-1')
    expect(await h.render()).toBeNull()
  })

  it('uses the env default tier and only re-renders when the battery changes', async () => {
    const h = harness({ ANTHROPIC_API_KEY: 'k' })
    await h.start()
    await h.step({ cache_read_input_tokens: 5 })
    const before = h.invalidations()
    await h.tick()
    await h.tick()
    expect(h.invalidations()).toBe(before + 1)
    h.advance(60_000)
    await h.tick()
    expect(h.invalidations()).toBe(before + 2)
    expect(texts(await h.render())).toMatch(/^◔ /)
  })

  it('forgets the cache on /clear and keeps a survey prompt untouched', async () => {
    const h = harness()
    await h.start()
    await h.step({ cache_read_input_tokens: 5 })
    const survey = await h.handlers.get('ui.render:{"component":"AbovePrompt"}')!(h.$, { props: { hasSurvey: true } }, async () => 'survey')
    expect(survey).toBe('survey')
    await h.handlers.get('classic.SessionStart:{"source":["clear","resume","fork"]}')!(h.$, {}, async (e: unknown) => e)
    expect(await h.render()).toBeNull()
  })
})

describe('modOptions', () => {
  it('reads width and numbers, falling back on bad values', () => {
    expect(modOptions({})).toEqual({ cells: 8, numbers: 'end' })
    expect(modOptions({ CACHE_BATTERY_CELLS: '5', CACHE_BATTERY_NUMBERS: 'never' })).toEqual({ cells: 5, numbers: 'never' })
    expect(modOptions({ CACHE_BATTERY_CELLS: '-1' }).cells).toBe(8)
  })
})

describe('toInk', () => {
  const Text = (p: Record<string, unknown>) => p
  it('maps tones and the track to Ink props', () => {
    expect(toInk({ kind: 'empty', count: 2 }, Text)).toEqual({ color: '#5c5c5c', children: ['██'] })
    expect(toInk({ kind: 'fill', text: '█', tone: 'red' }, Text)).toEqual({ color: 'red', children: ['█'] })
    expect(toInk({ kind: 'text', text: '◔ ', tone: 'dim' }, Text)).toEqual({ dimColor: true, bold: undefined, children: ['◔ '] })
    expect(toInk({ kind: 'text', text: 'x' }, Text)).toEqual({ bold: undefined, children: ['x'] })
  })
})
