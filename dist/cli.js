#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { colorEnabled, parseNumbers, renderBattery, toAnsi } from './core/render.js';
import { defaultTier, fromPromptCache, fromSamples } from './core/state.js';
import { samplesFromTranscript } from './core/transcript.js';
const TAIL_BYTES = 512 * 1024;
const USAGE = `cache-battery: prompt-cache battery for the Claude Code status line

  cache-battery segment                 print only the battery (call it from your own script)
  cache-battery statusline --wrap CMD   run your status line command and append the battery

Options: --cells N (default 8), --numbers end|always|never (default end)
Env: CACHE_BATTERY_CELLS, CACHE_BATTERY_NUMBERS, CACHE_BATTERY_TTL=5m|1h, NO_COLOR`;
export function readTail(path, bytes = TAIL_BYTES) {
    const fd = openSync(path, 'r');
    try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, bytes);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);
        return buffer.toString('utf8');
    }
    finally {
        closeSync(fd);
    }
}
/** The built-in `prompt_cache` field when present (Claude Code 2.1.251+), else the transcript tail. */
export function stateForStatusLine(input, env, tail = readTail) {
    const fromField = fromPromptCache(input.prompt_cache);
    if (fromField)
        return fromField;
    if (!input.transcript_path)
        return undefined;
    try {
        return fromSamples(samplesFromTranscript(tail(input.transcript_path)), defaultTier(env));
    }
    catch {
        return undefined;
    }
}
export function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--wrap')
            args.wrap = argv[++i];
        else if (arg === '--cells')
            args.cells = Number(argv[++i]);
        else if (arg === '--numbers')
            args.numbers = argv[++i];
        else if (!arg.startsWith('-'))
            args.command ??= arg;
        else
            args.command = 'help';
    }
    return args;
}
function appendToLastLine(output, battery) {
    const text = output.replace(/\s+$/, '');
    if (!text)
        return battery;
    return battery ? `${text} ${battery}` : text;
}
export function run(argv, stdin, env, now) {
    const args = parseArgs(argv);
    if (args.command === 'help' || (args.command && !['segment', 'statusline'].includes(args.command)))
        return USAGE;
    let input = {};
    try {
        input = JSON.parse(stdin || '{}');
    }
    catch {
        // a malformed payload still lets a wrapped status line print
    }
    const cells = args.cells ?? Number(env.CACHE_BATTERY_CELLS ?? 8);
    const segments = renderBattery(stateForStatusLine(input, env), now, {
        cells: Number.isInteger(cells) && cells > 0 ? cells : 8,
        numbers: parseNumbers(args.numbers ?? env.CACHE_BATTERY_NUMBERS),
    });
    const battery = toAnsi(segments, colorEnabled(env));
    if (!args.wrap)
        return battery;
    const wrapped = spawnSync(args.wrap, { shell: true, input: stdin, encoding: 'utf8', env });
    return appendToLastLine(wrapped.stdout ?? '', battery);
}
function isEntryPoint() {
    try {
        return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
    }
    catch {
        return false;
    }
}
if (isEntryPoint()) {
    const stdin = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
    process.stdout.write(run(process.argv.slice(2), stdin, process.env, Date.now()) + '\n');
}
