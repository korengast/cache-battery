import { renderBattery, toAnsi } from '../dist/core/render.js'
import { TTL_MS } from '../dist/core/state.js'

const T0 = 0
const five = { tier: '5m', anchorAt: T0, ttlMs: TTL_MS['5m'] }
const hour = { tier: '1h', anchorAt: T0, ttlMs: TTL_MS['1h'] }
const rows = [
  ['5m · just written', five, 0],
  ['5m · half left', five, 150_000],
  ['5m · last minute', five, 258_000],
  ['5m · cold', five, 301_000],
  ['1h · plenty left', hour, 600_000],
  ['1h · last 5 minutes', hour, 3_360_000],
  ['pi warmer refresh', { ...five, chargingUntil: 5_000 }, 1_000],
  ['estimated (Cursor in pi)', { ...five, estimated: true }, 90_000],
]
// A blank line between rows: block glyphs on adjacent lines merge into one shape.
const lines = rows.map(([label, state, at]) => `  ${label.padEnd(26)}${toAnsi(renderBattery(state, at), true)}`)
console.log('\n' + lines.join('\n\n') + '\n')
