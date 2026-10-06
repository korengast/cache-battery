import { parseNumbers } from './core/render.js';
const TRACK = '#5c5c5c';
const TRACK_GLYPH = '█';
const INK_COLOR = { green: 'green', yellow: 'yellow', red: 'red', cyan: 'cyan' };
export function modOptions(env) {
    const cells = Number(env.CACHE_BATTERY_CELLS ?? 8);
    return { cells: Number.isInteger(cells) && cells > 0 ? cells : 8, numbers: parseNumbers(env.CACHE_BATTERY_NUMBERS) };
}
/** No backgroundColor: in the band a background fills the cell's whole flex area, so empty cells are a track glyph instead. */
export function toInk(segment, Text) {
    if (segment.kind === 'empty')
        return Text({ color: TRACK, children: [TRACK_GLYPH.repeat(segment.count)] });
    const tone = segment.tone;
    const style = tone === 'dim' ? { dimColor: true } : tone ? { color: INK_COLOR[tone] } : {};
    if (segment.kind === 'fill')
        return Text({ ...style, children: [segment.text] });
    return Text({ ...style, bold: segment.bold, children: [segment.text] });
}
