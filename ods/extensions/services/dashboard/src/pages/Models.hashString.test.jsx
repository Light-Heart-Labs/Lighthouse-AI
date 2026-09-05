import { describe, test, expect } from 'vitest'
import { hashString } from './Models'

describe('hashString', () => {
  test('returns the FNV offset basis for an empty string', () => {
    expect(hashString('')).toBe(2166136261)
  })

  test('is deterministic for the same input', () => {
    expect(hashString('llama-3.1-8b')).toBe(hashString('llama-3.1-8b'))
  })

  test('produces different hashes for different strings', () => {
    expect(hashString('llama-3.1-8b')).not.toBe(hashString('mistral-7b'))
  })

  test('coerces non-string values via String()', () => {
    expect(hashString(123)).toBe(hashString('123'))
  })

  test('always returns a non-negative 32-bit unsigned integer', () => {
    const hash = hashString('some-very-long-model-id:32768')
    expect(Number.isInteger(hash)).toBe(true)
    expect(hash).toBeGreaterThanOrEqual(0)
    expect(hash).toBeLessThanOrEqual(0xffffffff)
  })
})
