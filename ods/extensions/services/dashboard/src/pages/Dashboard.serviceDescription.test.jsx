import { describe, test, expect } from 'vitest'
import { normalizeServiceKey, getServiceDescription } from './Dashboard'

describe('normalizeServiceKey', () => {
  test('lowercases, strips parenthetical suffixes, and hyphenates', () => {
    expect(normalizeServiceKey('llama-server (LLM Inference)')).toBe('llama-server')
  })

  test('collapses runs of non-alphanumeric characters into a single hyphen', () => {
    expect(normalizeServiceKey('Open   WebUI!!')).toBe('open-webui')
  })

  test('trims leading/trailing hyphens', () => {
    expect(normalizeServiceKey('  --n8n--  ')).toBe('n8n')
  })

  test('returns an empty string for a missing value', () => {
    expect(normalizeServiceKey(null)).toBe('')
    expect(normalizeServiceKey(undefined)).toBe('')
  })
})

describe('getServiceDescription', () => {
  test('matches by the exact id first', () => {
    expect(getServiceDescription('llama-server', 'Anything')).toBe('Local model inference runtime')
  })

  test('falls back to a normalized-key match when the raw id has no entry', () => {
    expect(getServiceDescription('llama-server (LLM Inference)', null)).toBe('Local model inference runtime')
  })

  test('falls back to normalizing the name when no id is given', () => {
    expect(getServiceDescription(null, 'Open WebUI (Chat)')).toBe('Chat interface for local models')
  })

  test('returns the generic fallback for an unrecognized service', () => {
    expect(getServiceDescription('some-future-service', 'Future Service')).toBe('ODS service')
  })
})
