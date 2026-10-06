export type Tier = '5m' | '1h'

export const TTL_MS: Record<Tier, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

const CHARGING_MS = 5000

export interface CacheState {
  tier: Tier
  /** When the cached prefix was last written or read; the TTL restarts here. */
  anchorAt: number
  ttlMs: number
  /** A host-sent refresh (pi's cache warmer) shows a charging marker until this time. */
  chargingUntil?: number
  /** Timed from a request that carried no cache numbers, so warm/cold is a guess. */
  estimated?: boolean
}

export interface UsageSample {
  at: number
  cacheRead: number
  cacheWrite: number
  write1h?: number
  write5m?: number
  refresh?: boolean
  /** The host saw a request but its provider reports no per-request cache numbers. */
  estimated?: boolean
}

export interface AnthropicUsage {
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }
}

export interface PromptCacheField {
  caching_observed?: boolean
  warm?: boolean
  ttl?: string
  expires_at?: number | null
}

export type Env = Record<string, string | undefined>

export function sampleFromAnthropicUsage(usage: AnthropicUsage, at: number): UsageSample {
  return {
    at,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    write1h: usage.cache_creation?.ephemeral_1h_input_tokens,
    write5m: usage.cache_creation?.ephemeral_5m_input_tokens,
  }
}

export function tierOf(sample: UsageSample): Tier | undefined {
  if ((sample.write1h ?? 0) > 0) return '1h'
  if ((sample.write5m ?? 0) > 0) return '5m'
  return undefined
}

/**
 * Cache-reading requests record empty write buckets, so the tier comes from the
 * newest request that wrote, not from the newest request.
 */
export function fromSamples(samples: readonly UsageSample[], fallback: Tier): CacheState | undefined {
  const newest = samples.at(-1)
  if (newest?.estimated) return { tier: '5m', anchorAt: newest.at, ttlMs: TTL_MS['5m'], estimated: true }
  if (!newest || newest.cacheRead + newest.cacheWrite <= 0) return undefined
  let tier = fallback
  for (let i = samples.length - 1; i >= 0; i--) {
    const found = tierOf(samples[i])
    if (found) {
      tier = found
      break
    }
  }
  const state: CacheState = { tier, anchorAt: newest.at, ttlMs: TTL_MS[tier] }
  if (newest.refresh) state.chargingUntil = newest.at + CHARGING_MS
  return state
}

export function fromPromptCache(field: PromptCacheField | undefined): CacheState | undefined {
  if (!field?.caching_observed) return undefined
  const tier: Tier = field.ttl === '1h' ? '1h' : '5m'
  const ttlMs = TTL_MS[tier]
  const anchorAt = typeof field.expires_at === 'number' ? field.expires_at * 1000 - ttlMs : 0
  return { tier, anchorAt, ttlMs }
}

/** Mirrors Claude Code's TTL choice: 1h on a subscription, 5m on API keys and cloud providers. */
export function defaultTier(env: Env): Tier {
  if (env.CACHE_BATTERY_TTL === '5m' || env.CACHE_BATTERY_TTL === '1h') return env.CACHE_BATTERY_TTL
  if (env.FORCE_PROMPT_CACHING_5M) return '5m'
  if (env.ENABLE_PROMPT_CACHING_1H) return '1h'
  const metered = env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX || env.CLAUDE_CODE_USE_FOUNDRY
  return metered ? '5m' : '1h'
}

export function remainingMs(state: CacheState, now: number): number {
  return state.anchorAt + state.ttlMs - now
}

export function fraction(state: CacheState, now: number): number {
  return Math.min(1, Math.max(0, remainingMs(state, now) / state.ttlMs))
}
