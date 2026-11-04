// Modified from dsh-duet v0.1.10: retain the trace interface without recording audio payloads.
import {mkdirSync, appendFileSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'

// Deliberately preserve only bounded numeric metadata; no raw strings or nested values.
export function redact(value) {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return {bytes: value.byteLength}
  if (typeof value === 'string') return {characters: value.length}
  if (Array.isArray(value)) return {items: value.length}
  if (value && typeof value === 'object') return Object.fromEntries(
    ['bytes', 'generation', 'sample_rate', 'played_samples', 'selected_stop_sample'].filter(k => Number.isFinite(value[k])).map(k => [k, value[k]]))
  return typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' ? value : null
}
export class DuetTrace {
  constructor(metadata, {root, maxBytes = 1024 * 1024} = {}) {
    this.id = randomUUID(); this.bytes = 0; this.closed = false; this.error = null
    this.maxBytes = Math.max(0, Math.min(Number.isFinite(maxBytes) ? maxBytes : 0, 1024 * 1024))
    try { if (root) { this.path = join(root, this.id); mkdirSync(this.path, {recursive:true, mode:0o700}) } }
    catch { this.error = 'open_failed' }
    this.event('trace.started', metadata)
  }
  event(type, data, binary) {
    if (this.closed || this.error) return
    const known = /^(trace\.(started|closed)|input_audio_buffer\.speech_started|output_audio_buffer\.(clear|cleared)|browser\.(receive|send)|upstream\.(receive|send))$/.test(type)
    const row = {type: known ? type : 'metadata', data:redact(data), ...(binary ? {bytes:binary.byteLength} : {})}
    const line = JSON.stringify(row) + '\n', size = Buffer.byteLength(line)
    if (this.bytes + size > this.maxBytes) { this.error = 'quota_exceeded'; return }
    try { if (this.path) appendFileSync(join(this.path, 'events.jsonl'), line, {mode:0o600}); this.bytes += size }
    catch { this.error = 'write_failed' }
  }
  frame(direction, raw, binary = false) {
    if (binary) return this.event(direction, {bytes:raw.byteLength})
    let data
    try { data = JSON.parse(raw.toString()) } catch { data = {bytes:Buffer.byteLength(raw)} }
    this.event(direction, data)
  }
  snapshot() { return {trace_id:this.id, bytes:this.bytes, complete:!this.error, error:this.error} }
  async close(data = {}) { if (!this.closed) this.event('trace.closed', data); this.closed = true }
}
