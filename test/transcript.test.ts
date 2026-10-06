import { describe, expect, it } from 'vitest'
import { samplesFromTranscript } from '../src/core/transcript.js'

const line = (o: unknown) => JSON.stringify(o)

describe('samplesFromTranscript', () => {
  it('reads assistant usage rows and skips everything else', () => {
    const text = [
      line({ type: 'user', timestamp: '2026-10-06T06:00:00.000Z', message: { role: 'user' } }),
      line({
        type: 'assistant',
        timestamp: '2026-10-06T06:00:05.000Z',
        message: { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 800, cache_creation: { ephemeral_1h_input_tokens: 800 } } },
      }),
      '{"type":"assistant", broken',
      line({ type: 'assistant', timestamp: 'nope', message: { usage: {} } }),
      line({ type: 'assistant', isSidechain: true, timestamp: '2026-10-06T06:00:09.000Z', message: { usage: { cache_read_input_tokens: 1 } } }),
    ].join('\n')
    expect(samplesFromTranscript(text)).toEqual([
      { at: Date.parse('2026-10-06T06:00:05.000Z'), cacheRead: 0, cacheWrite: 800, write1h: 800, write5m: undefined },
    ])
  })
})
