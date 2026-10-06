export const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 };
const CHARGING_MS = 5000;
export function sampleFromAnthropicUsage(usage, at) {
    return {
        at,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        write1h: usage.cache_creation?.ephemeral_1h_input_tokens,
        write5m: usage.cache_creation?.ephemeral_5m_input_tokens,
    };
}
export function tierOf(sample) {
    if ((sample.write1h ?? 0) > 0)
        return '1h';
    if ((sample.write5m ?? 0) > 0)
        return '5m';
    return undefined;
}
const usesCache = (s) => s.estimated || s.cacheRead + s.cacheWrite > 0;
/**
 * Anchors on the newest request that used the cache: an aborted or failed request
 * records zero usage but leaves the earlier cache warm. Cache-reading requests record
 * empty write buckets, so the tier comes from the newest request that wrote.
 */
export function fromSamples(samples, fallback) {
    let last = samples.length - 1;
    while (last >= 0 && !usesCache(samples[last]))
        last--;
    if (last < 0)
        return undefined;
    const newest = samples[last];
    if (newest.estimated)
        return { tier: '5m', anchorAt: newest.at, ttlMs: TTL_MS['5m'], estimated: true };
    let tier = fallback;
    for (let i = last; i >= 0; i--) {
        const found = tierOf(samples[i]);
        if (found) {
            tier = found;
            break;
        }
    }
    const state = { tier, anchorAt: newest.at, ttlMs: TTL_MS[tier] };
    if (newest.refresh)
        state.chargingUntil = newest.at + CHARGING_MS;
    return state;
}
export function fromPromptCache(field) {
    if (!field?.caching_observed)
        return undefined;
    const tier = field.ttl === '1h' ? '1h' : '5m';
    const ttlMs = TTL_MS[tier];
    const anchorAt = typeof field.expires_at === 'number' ? field.expires_at * 1000 - ttlMs : 0;
    return { tier, anchorAt, ttlMs };
}
const isTier = (value) => value === '5m' || value === '1h';
const truthy = (value) => /^(1|true|yes|on)$/i.test(value?.trim() ?? '');
/**
 * Mirrors Claude Code's TTL choice in its order: FORCE_PROMPT_CACHING_5M, then
 * CLAUDE_CODE_PROMPT_CACHE_TTL, then 1h on a subscription and 5m on API keys and cloud
 * providers. The promptCacheTtl setting and subscription overage are not visible here.
 */
export function defaultTier(env) {
    if (isTier(env.CACHE_BATTERY_TTL))
        return env.CACHE_BATTERY_TTL;
    if (truthy(env.FORCE_PROMPT_CACHING_5M))
        return '5m';
    if (isTier(env.CLAUDE_CODE_PROMPT_CACHE_TTL))
        return env.CLAUDE_CODE_PROMPT_CACHE_TTL;
    if (truthy(env.ENABLE_PROMPT_CACHING_1H))
        return '1h';
    const metered = env.ANTHROPIC_API_KEY ||
        env.ANTHROPIC_AUTH_TOKEN ||
        truthy(env.CLAUDE_CODE_USE_BEDROCK) ||
        truthy(env.CLAUDE_CODE_USE_VERTEX) ||
        truthy(env.CLAUDE_CODE_USE_FOUNDRY);
    return metered ? '5m' : '1h';
}
export function remainingMs(state, now) {
    return state.anchorAt + state.ttlMs - now;
}
export function fraction(state, now) {
    return Math.min(1, Math.max(0, remainingMs(state, now) / state.ttlMs));
}
