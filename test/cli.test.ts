import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseArgs, readTail, run, stateForStatusLine } from '../src/cli.js'

const NOW = 1_800_000_000_000
const plain = { NO_COLOR: '1' }

describe('parseArgs', () => {
  it('reads the command and flags', () => {
    expect(parseArgs(['statusline', '--wrap', 'echo hi', '--cells', '6', '--numbers', 'always'])).toEqual({
      command: 'statusline',
      wrap: 'echo hi',
      cells: 6,
      numbers: 'always',
    })
    expect(parseArgs(['--help']).command).toBe('help')
    expect(parseArgs(['-h']).command).toBe('help')
  })

  it('takes --flag=value and ignores unknown flags', () => {
    expect(parseArgs(['statusline', '--wrap=echo a=b', '--cells=6', '--numbers=never', '--frob'])).toEqual({
      command: 'statusline',
      wrap: 'echo a=b',
      cells: 6,
      numbers: 'never',
    })
    expect(parseArgs(['segment', '--numbers', '--cells', '4'])).toEqual({ command: 'segment', numbers: undefined, cells: 4 })
  })
})

describe('stateForStatusLine', () => {
  it('prefers the prompt_cache field', () => {
    const s = stateForStatusLine({ prompt_cache: { caching_observed: true, ttl: '1h', expires_at: NOW / 1000 } }, {}, () => {
      throw new Error('must not read the transcript')
    })
    expect(s?.tier).toBe('1h')
  })

  it('falls back to the transcript and survives a read error', () => {
    const row = JSON.stringify({ type: 'assistant', timestamp: new Date(NOW).toISOString(), message: { usage: { cache_read_input_tokens: 9 } } })
    expect(stateForStatusLine({ transcript_path: 'x' }, { ANTHROPIC_API_KEY: 'k' }, () => row)?.tier).toBe('5m')
    expect(
      stateForStatusLine({ transcript_path: 'x' }, {}, () => {
        throw new Error('gone')
      }),
    ).toBeUndefined()
    expect(stateForStatusLine({}, {})).toBeUndefined()
  })
})

describe('readTail', () => {
  it('returns only the last bytes of a file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cb-')), 't.jsonl')
    writeFileSync(file, 'abcdef')
    expect(readTail(file, 3)).toBe('def')
  })
})

describe('run', () => {
  const input = JSON.stringify({ prompt_cache: { caching_observed: true, ttl: '5m', expires_at: (NOW + 150_000) / 1000 } })

  it('prints the battery segment', () => {
    expect(run(['segment'], input, plain, NOW)).toBe('◔ ████░░░░▌')
  })

  it('prints nothing for an unknown cache and tolerates bad JSON', () => {
    expect(run(['segment'], '{}', plain, NOW)).toBe('')
    expect(run(['segment'], 'not json', plain, NOW)).toBe('')
    expect(run(['segment'], 'null', plain, NOW)).toBe('')
    expect(run(['segment'], '[1]', plain, NOW)).toBe('')
    expect(run(['statusline', '--wrap', 'echo mine'], 'null', plain, NOW)).toBe('mine')
  })

  it('never prints usage into the status line for an unknown or = flag', () => {
    expect(run(['segment', '--cells=4'], input, plain, NOW)).toBe('◔ ██░░▌')
    expect(run(['segment', '--frob'], input, plain, NOW)).toBe('◔ ████░░░░▌')
  })

  it('stops a wrapped command that hangs and still draws the battery', () => {
    const started = Date.now()
    expect(run(['statusline', '--wrap', 'echo partial; sleep 10'], input, plain, NOW)).toBe('partial ◔ ████░░░░▌')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('stops a wrapped command that ignores SIGTERM', () => {
    const started = Date.now()
    expect(run(['statusline', '--wrap', 'trap "" TERM; echo hi; sleep 6'], input, plain, NOW)).toBe('hi ◔ ████░░░░▌')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('keeps output over the default 1 MB buffer and still draws the battery', () => {
    const out = run(['statusline', '--wrap', 'head -c 2000000 /dev/zero | tr "\\0" a; echo'], input, plain, NOW)
    expect(out.length).toBe(2_000_000 + ' ◔ ████░░░░▌'.length)
    expect(out.endsWith('a ◔ ████░░░░▌')).toBe(true)
  })

  it('draws the battery when the wrapped command fails or is missing', () => {
    expect(run(['statusline', '--wrap', 'exit 3'], input, plain, NOW)).toBe('◔ ████░░░░▌')
    expect(run(['statusline', '--wrap', 'no-such-command-cb'], input, plain, NOW)).toBe('◔ ████░░░░▌')
  })

  it('appends the battery to a wrapped status line', () => {
    expect(run(['statusline', '--wrap', 'printf "line1\\nline2\\n"'], input, plain, NOW)).toBe('line1\nline2 ◔ ████░░░░▌')
    expect(run(['statusline', '--wrap', 'true'], '{}', plain, NOW)).toBe('')
  })

  it('passes the payload through to the wrapped command', () => {
    expect(run(['statusline', '--wrap', 'cat >/dev/null; echo ok'], input, plain, NOW)).toBe('ok ◔ ████░░░░▌')
  })

  it('reads width and numbers from env and shows usage on unknown commands', () => {
    expect(run(['segment'], input, { ...plain, CACHE_BATTERY_CELLS: '4' }, NOW)).toBe('◔ ██░░▌')
    expect(run(['segment'], input, { ...plain, CACHE_BATTERY_NUMBERS: 'always' }, NOW)).toMatch(/ 3m$/)
    expect(run(['frobnicate'], input, plain, NOW)).toContain('cache-battery segment')
  })
})

describe('built CLI smoke test', () => {
  it('reads status-line JSON from stdin', () => {
    const payload = JSON.stringify({ prompt_cache: { caching_observed: true, ttl: '1h', expires_at: Date.now() / 1000 + 1800 } })
    const out = execFileSync('node', ['dist/cli.js', 'segment'], { input: payload, env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8' })
    expect(out).toMatch(/^● ████[▏▎▍▌▋▊▉]?░{3,4}▌\n$/)
  })
})
