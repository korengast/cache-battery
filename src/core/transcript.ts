import { sampleFromAnthropicUsage, type AnthropicUsage, type UsageSample } from './state.js'

interface TranscriptRow {
  type?: string
  isSidechain?: boolean
  isApiErrorMessage?: boolean
  timestamp?: string
  message?: { model?: string; usage?: AnthropicUsage }
}

/** Claude Code transcript JSONL to main-conversation usage samples, oldest first. */
export function samplesFromTranscript(text: string): UsageSample[] {
  const samples: UsageSample[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    let row: TranscriptRow
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.type !== 'assistant' || row.isSidechain || !row.message?.usage) continue
    // Claude Code writes an all-zero row for an API error or a cancelled reply; the cache before it is still warm.
    if (row.isApiErrorMessage || row.message.model === '<synthetic>') continue
    const at = Date.parse(row.timestamp ?? '')
    if (Number.isNaN(at)) continue
    samples.push(sampleFromAnthropicUsage(row.message.usage, at))
  }
  return samples
}
