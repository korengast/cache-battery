// Claude Code scans this file before loading it: every hook must be a function
// literal here and every host call spelled $.noun.event(...), so the host API
// stays in this file and ./lib holds only pure helpers.
import { modOptions, toInk } from './lib/cc-mod.mjs'
import { renderBattery } from './lib/core/render.mjs'
import { defaultTier, fromSamples, sampleFromAnthropicUsage, tierOf } from './lib/core/state.mjs'

export function register(on) {
  let state
  let tier = '1h'
  let now = 0
  let lastKey = ''
  let options = modOptions({})
  let ticking = false
  // A main-conversation request in flight keeps its cached prefix alive.
  let inFlight = false

  const shown = () => (inFlight && state ? { ...state, anchorAt: now, chargingUntil: undefined } : state)

  on('session.start', async ($, e, next) => {
    // Claude Code does not pass the 5m/1h write split to mods, so the tier follows its own
    // settings. ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are only tested for presence.
    const env = {
      CACHE_BATTERY_TTL: await $.env.get('CACHE_BATTERY_TTL'),
      CACHE_BATTERY_NUMBERS: await $.env.get('CACHE_BATTERY_NUMBERS'),
      CACHE_BATTERY_CELLS: await $.env.get('CACHE_BATTERY_CELLS'),
      FORCE_PROMPT_CACHING_5M: await $.env.get('FORCE_PROMPT_CACHING_5M'),
      CLAUDE_CODE_PROMPT_CACHE_TTL: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
      ENABLE_PROMPT_CACHING_1H: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
      ANTHROPIC_API_KEY: await $.env.get('ANTHROPIC_API_KEY'),
      ANTHROPIC_AUTH_TOKEN: await $.env.get('ANTHROPIC_AUTH_TOKEN'),
      CLAUDE_CODE_USE_BEDROCK: await $.env.get('CLAUDE_CODE_USE_BEDROCK'),
      CLAUDE_CODE_USE_VERTEX: await $.env.get('CLAUDE_CODE_USE_VERTEX'),
      CLAUDE_CODE_USE_FOUNDRY: await $.env.get('CLAUDE_CODE_USE_FOUNDRY'),
    }
    tier = defaultTier(env)
    options = modOptions(env)
    now = await $.clock.now()
    if (!ticking) {
      ticking = true
      $.clock.every(1000, async () => {
        now = await $.clock.now()
        const key = JSON.stringify(renderBattery(shown(), now, options))
        if (key === lastKey) return
        lastKey = key
        $.ui.invalidate('ui.render')
      })
    }
    return next(e)
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    state = undefined
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    if (!e.agentId) {
      inFlight = true
      $.ui.invalidate('ui.render')
    }
    let result
    try {
      result = yield* next(e)
    } finally {
      if (!e.agentId) inFlight = false
    }
    if (e.agentId || !result || !result.usage) return result
    const sample = sampleFromAnthropicUsage(result.usage, startedAt)
    tier = tierOf(sample) ?? tier
    // A step with no cache use (aborted, failed) leaves the earlier cache warm.
    state = fromSamples([sample], tier) ?? state
    $.ui.invalidate('ui.render')
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props && e.props.hasSurvey) return below
    now = await $.clock.now()
    const segments = renderBattery(shown(), now, options)
    if (!segments.length) return below
    const { Box, Text } = $.ui.resolve(e)
    const battery = Box({ flexDirection: 'row', flexGrow: 0, flexShrink: 0, children: segments.map((s) => toInk(s, Text)) })
    const row = Box({ flexDirection: 'row', children: [battery, Box({ flexGrow: 1 })] })
    return Box({ flexDirection: 'column', children: below ? [row, below] : [row] })
  })
}
