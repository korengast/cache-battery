import { describe, expect, it } from 'vitest'
import { defaultTier, fraction, fromPromptCache, fromSamples, remainingMs, sampleFromAnthropicUsage, TTL_MS } from '../src/core/state.js'

const T0 = 1_800_000_000_000

describe('sampleFromAnthropicUsage', () => {
  it('reads the 1h and 5m write buckets', () => {
    const s = sampleFromAnthropicUsage(
      { cache_read_input_tokens: 10, cache_creation_input_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 0 } },
      T0,
    )
    expect(s).toEqual({ at: T0, cacheRead: 10, cacheWrite: 5, write1h: 5, write5m: 0 })
  })

  it('tolerates missing fields', () => {
    expect(sampleFromAnthropicUsage({}, T0)).toEqual({ at: T0, cacheRead: 0, cacheWrite: 0, write1h: undefined, write5m: undefined })
  })
})

describe('fromSamples', () => {
  it('is unknown with no samples', () => {
    expect(fromSamples([], '5m')).toBeUndefined()
  })

  it('is unknown when the newest request reported no cache use (a provider that does not cache)', () => {
    const old = { at: T0, cacheRead: 100, cacheWrite: 0 }
    const off = { at: T0 + 1000, cacheRead: 0, cacheWrite: 0 }
    expect(fromSamples([old, off], '5m')).toBeUndefined()
  })

  it('anchors on the newest request and takes the tier from the newest non-zero write bucket', () => {
    const write = { at: T0, cacheRead: 0, cacheWrite: 900, write1h: 900, write5m: 0 }
    const readOnly = { at: T0 + 60_000, cacheRead: 900, cacheWrite: 0, write1h: 0, write5m: 0 }
    expect(fromSamples([write, readOnly], '5m')).toEqual({ tier: '1h', anchorAt: T0 + 60_000, ttlMs: TTL_MS['1h'] })
  })

  it('falls back to the default tier when no bucket says which', () => {
    expect(fromSamples([{ at: T0, cacheRead: 5, cacheWrite: 0 }], '5m')?.tier).toBe('5m')
  })

  it('marks a host-sent refresh as charging', () => {
    const s = fromSamples([{ at: T0, cacheRead: 5, cacheWrite: 0, refresh: true }], '5m')
    expect(s?.chargingUntil).toBe(T0 + 5000)
  })
})

describe('fromPromptCache', () => {
  it('is unknown when caching was never observed', () => {
    expect(fromPromptCache(undefined)).toBeUndefined()
    expect(fromPromptCache({ caching_observed: false })).toBeUndefined()
  })

  it('anchors from expires_at in epoch seconds', () => {
    const s = fromPromptCache({ caching_observed: true, warm: true, ttl: '1h', expires_at: (T0 + 600_000) / 1000 })
    expect(s).toEqual({ tier: '1h', anchorAt: T0 + 600_000 - TTL_MS['1h'], ttlMs: TTL_MS['1h'] })
  })

  it('is cold when expires_at is null', () => {
    const s = fromPromptCache({ caching_observed: true, warm: false, ttl: '5m', expires_at: null })!
    expect(remainingMs(s, T0)).toBeLessThanOrEqual(0)
  })
})

describe('remaining time', () => {
  const s = { tier: '5m' as const, anchorAt: T0, ttlMs: TTL_MS['5m'] }
  it('counts down and clamps the fraction', () => {
    expect(remainingMs(s, T0 + 60_000)).toBe(240_000)
    expect(fraction(s, T0 + 150_000)).toBe(0.5)
    expect(fraction(s, T0 + 999_999)).toBe(0)
    expect(fraction(s, T0 - 1)).toBe(1)
  })
})

describe('defaultTier', () => {
  it('follows Claude Code rules: subscription 1h, API key 5m, env overrides', () => {
    expect(defaultTier({})).toBe('1h')
    expect(defaultTier({ ANTHROPIC_API_KEY: 'x' })).toBe('5m')
    expect(defaultTier({ ANTHROPIC_API_KEY: 'x', ENABLE_PROMPT_CACHING_1H: '1' })).toBe('1h')
    expect(defaultTier({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('5m')
    expect(defaultTier({ FORCE_PROMPT_CACHING_5M: '1', ENABLE_PROMPT_CACHING_1H: '1' })).toBe('5m')
    expect(defaultTier({ CACHE_BATTERY_TTL: '5m' })).toBe('5m')
  })

  it('reads CLAUDE_CODE_PROMPT_CACHE_TTL after FORCE_PROMPT_CACHING_5M, as Claude Code does', () => {
    expect(defaultTier({ CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })).toBe('5m')
    expect(defaultTier({ ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })).toBe('1h')
    expect(defaultTier({ FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })).toBe('5m')
    expect(defaultTier({ CLAUDE_CODE_PROMPT_CACHE_TTL: 'soon' })).toBe('1h')
  })

  it('reads boolean env values as Claude Code does and counts an auth token as metered', () => {
    expect(defaultTier({ FORCE_PROMPT_CACHING_5M: '0' })).toBe('1h')
    expect(defaultTier({ FORCE_PROMPT_CACHING_5M: 'true' })).toBe('5m')
    expect(defaultTier({ CLAUDE_CODE_USE_BEDROCK: 'false' })).toBe('1h')
    expect(defaultTier({ ANTHROPIC_AUTH_TOKEN: 't' })).toBe('5m')
  })
})

describe('estimated samples', () => {
  it('treat a request without cache numbers as a 5m refresh and mark the state as estimated', () => {
    const state = fromSamples([{ at: T0, cacheRead: 0, cacheWrite: 0, estimated: true }], '1h')
    expect(state).toEqual({ tier: '5m', anchorAt: T0, ttlMs: TTL_MS['5m'], estimated: true })
  })

  it('give way to real numbers on a newer sample', () => {
    const state = fromSamples([{ at: T0, cacheRead: 0, cacheWrite: 0, estimated: true }, { at: T0 + 5, cacheRead: 10, cacheWrite: 0 }], '5m')
    expect(state).toEqual({ tier: '5m', anchorAt: T0 + 5, ttlMs: TTL_MS['5m'] })
  })
})
