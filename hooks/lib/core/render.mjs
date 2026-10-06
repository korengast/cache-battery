import { fraction, remainingMs } from './state.mjs';
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const BADGE = { '5m': '◔', '1h': '●' };
const ESTIMATED_BADGE = '○';
const CAP = '▌';
const EMPTY_GLYPH = '░';
const MINUTE = 60_000;
export function renderBattery(state, now, options = {}) {
    if (!state)
        return [];
    const cells = options.cells ?? 8;
    const left = remainingMs(state, now);
    const cap = { kind: 'text', text: CAP, tone: 'dim' };
    if (left <= 0) {
        return [{ kind: 'text', text: '❄ ', tone: 'cyan' }, { kind: 'empty', count: cells }, cap];
    }
    const level = fraction(state, now);
    const tone = level > 0.5 ? 'green' : level > 0.2 ? 'yellow' : 'red';
    const eighths = Math.min(cells * 8, Math.ceil(level * cells * 8));
    const full = Math.floor(eighths / 8);
    const partial = EIGHTHS[eighths % 8];
    const used = full + (partial ? 1 : 0);
    const segments = [
        { kind: 'text', text: `${state.estimated ? ESTIMATED_BADGE : BADGE[state.tier]} `, tone: 'dim' },
        { kind: 'fill', text: '█'.repeat(full) + partial, tone },
    ];
    if (used < cells)
        segments.push({ kind: 'empty', count: cells - used });
    segments.push(cap);
    const label = countdownLabel(left, state.ttlMs, options.numbers ?? 'end');
    if (label)
        segments.push({ kind: 'text', text: ` ${label}`, tone, bold: left <= MINUTE });
    if (state.chargingUntil !== undefined && now < state.chargingUntil)
        segments.push({ kind: 'text', text: ' ⚡', tone: 'yellow' });
    return segments;
}
function countdownLabel(left, ttlMs, mode) {
    if (mode === 'never')
        return undefined;
    if (left <= MINUTE)
        return `${Math.ceil(left / 1000)}s`;
    const nearEnd = ttlMs > 5 * MINUTE && left <= 5 * MINUTE;
    if (mode === 'always' || nearEnd)
        return `${Math.ceil(left / MINUTE)}m`;
    return undefined;
}
export function toPlain(segments) {
    return segments.map((s) => (s.kind === 'empty' ? EMPTY_GLYPH.repeat(s.count) : s.text)).join('');
}
/** `dim` is an explicit grey: SGR 2 is nearly invisible in some hosts' footers. */
const FG = { green: '32', yellow: '33', red: '31', dim: '38;5;245', cyan: '36' };
const TRACK_BG = '48;5;239';
const TRACK_FG = '38;5;239';
/** Empty cells are solid blocks in the track colour, not spaces: pi's footer collapses runs of spaces. */
export function toAnsi(segments, color) {
    if (!color)
        return toPlain(segments);
    const out = segments.map((s) => {
        if (s.kind === 'empty')
            return `\x1b[${TRACK_FG}m${'█'.repeat(s.count)}\x1b[0m`;
        if (s.kind === 'fill')
            return `\x1b[${FG[s.tone]};${TRACK_BG}m${s.text}\x1b[0m`;
        const codes = [s.tone ? FG[s.tone] : '', s.bold ? '1' : ''].filter(Boolean).join(';');
        return codes ? `\x1b[${codes}m${s.text}\x1b[0m` : s.text;
    });
    return out.join('');
}
export function colorEnabled(env) {
    return !env.NO_COLOR && env.FORCE_COLOR !== '0';
}
export function parseNumbers(value) {
    return value === 'always' || value === 'never' ? value : 'end';
}
