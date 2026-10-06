import { sampleFromAnthropicUsage } from './state.js';
/** Claude Code transcript JSONL to main-conversation usage samples, oldest first. */
export function samplesFromTranscript(text) {
    const samples = [];
    for (const line of text.split('\n')) {
        if (!line.includes('"usage"'))
            continue;
        let row;
        try {
            row = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (row.type !== 'assistant' || row.isSidechain || !row.message?.usage)
            continue;
        // Claude Code writes an all-zero row for an API error or a cancelled reply; the cache before it is still warm.
        if (row.isApiErrorMessage || row.message.model === '<synthetic>')
            continue;
        const at = Date.parse(row.timestamp ?? '');
        if (Number.isNaN(at))
            continue;
        samples.push(sampleFromAnthropicUsage(row.message.usage, at));
    }
    return samples;
}
