import { describe, test, expect } from 'vitest'
import { computeDelta } from './Usage'

describe('computeDelta', () => {
  test('computes a positive percentage change', () => {
    expect(computeDelta(150, 100)).toBe(50)
  })

  test('computes a negative percentage change', () => {
    expect(computeDelta(75, 100)).toBe(-25)
  })

  test('returns null when the previous value is zero (division by zero guard)', () => {
    expect(computeDelta(100, 0)).toBeNull()
  })

  test('returns null when the previous value is negative', () => {
    expect(computeDelta(100, -10)).toBeNull()
  })

  test('returns null when the previous value is missing', () => {
    expect(computeDelta(100, null)).toBeNull()
    expect(computeDelta(100, undefined)).toBeNull()
  })

  test('treats a missing current value as 0', () => {
    expect(computeDelta(undefined, 100)).toBe(-100)
  })

  test('returns 0 when current equals previous', () => {
    expect(computeDelta(100, 100)).toBe(0)
  })
})
