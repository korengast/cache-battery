import { describe, expect, it } from 'vitest'
import { renderBattery, toAnsi, toPlain } from '../src/core/render.js'
import { TTL_MS, type CacheState } from '../src/core/state.js'

const T0 = 1_800_000_000_000
const five: CacheState = { tier: '5m', anchorAt: T0, ttlMs: TTL_MS['5m'] }
const hour: CacheState = { tier: '1h', anchorAt: T0, ttlMs: TTL_MS['1h'] }

describe('renderBattery', () => {
  it('renders nothing when the cache state is unknown', () => {
    expect(renderBattery(undefined, T0)).toEqual([])
  })

  it('is a full green battery right after a request, with the 5m badge and no numbers', () => {
    expect(toPlain(renderBattery(five, T0))).toBe('◔ ████████▌')
    expect(renderBattery(five, T0).find((s) => s.kind === 'fill')?.tone).toBe('green')
  })

  it('drains in eighth-cell steps', () => {
    expect(toPlain(renderBattery(five, T0 + 150_000))).toBe('◔ ████░░░░▌')
    expect(toPlain(renderBattery(five, T0 + 147_000))).toBe('◔ ████▏░░░▌')
  })

  it('turns yellow under 50% and red under 20%', () => {
    const tone = (t: number) => renderBattery(five, t).find((s) => s.kind === 'fill')?.tone
    expect(tone(T0 + 200_000)).toBe('yellow')
    expect(tone(T0 + 260_000)).toBe('red')
  })

  it('shows seconds in the last minute', () => {
    expect(toPlain(renderBattery(five, T0 + 258_000))).toBe('◔ █▏░░░░░░▌ 42s')
  })

  it('shows minutes in the last five minutes of the 1h tier', () => {
    expect(toPlain(renderBattery(hour, T0 + 3_600_000 - 4 * 60_000 + 1))).toMatch(/^● .+▌ 4m$/)
    expect(toPlain(renderBattery(hour, T0 + 60_000))).toMatch(/^● [█▉]+▌$/)
  })

  it('honours numbers: always and never', () => {
    expect(toPlain(renderBattery(five, T0 + 60_000, { numbers: 'always' }))).toMatch(/ 4m$/)
    expect(toPlain(renderBattery(five, T0 + 290_000, { numbers: 'never' }))).not.toMatch(/s$/)
  })

  it('is an empty battery with a snowflake when cold', () => {
    expect(toPlain(renderBattery(five, T0 + 300_000))).toBe('❄ ░░░░░░░░▌')
  })

  it('shows a lightning bolt while a host refresh is charging it', () => {
    expect(toPlain(renderBattery({ ...five, chargingUntil: T0 + 5000 }, T0 + 1000))).toBe('◔ ████████▌ ⚡')
    expect(toPlain(renderBattery({ ...five, chargingUntil: T0 + 5000 }, T0 + 6000))).not.toContain('⚡')
  })

  it('supports a custom width', () => {
    expect(toPlain(renderBattery(five, T0, { cells: 4 }))).toBe('◔ ████▌')
  })
})

describe('toAnsi', () => {
  it('draws empty cells as a coloured track and resets colours', () => {
    const out = toAnsi(renderBattery(five, T0 + 150_000), true)
    expect(out).toContain('\x1b[33;48;5;239m████')
    expect(out).toContain('\x1b[38;5;239m████')
    expect(out.endsWith('\x1b[0m')).toBe(true)
  })

  it('falls back to plain glyphs without colour', () => {
    expect(toAnsi(renderBattery(five, T0 + 150_000), false)).toBe('◔ ████░░░░▌')
  })
})

describe('estimated state', () => {
  it('shows a hollow badge so the battery reads as a guess', () => {
    expect(toPlain(renderBattery({ ...five, estimated: true }, T0))).toBe('○ ████████▌')
  })
})
