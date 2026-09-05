import { describe, test, expect } from 'vitest'
import { formatCompact, formatInteger } from './Usage'

describe('formatCompact', () => {
  test('formats billions/millions/thousands with a unit suffix', () => {
    expect(formatCompact(2_500_000_000)).toBe('2.5B')
    expect(formatCompact(1_500_000)).toBe('1.5M')
    expect(formatCompact(3_400)).toBe('3.4k')
  })

  test('rounds small values to a whole number with no suffix', () => {
    expect(formatCompact(42.6)).toBe('43')
  })

  test('treats missing/falsy values as 0', () => {
    expect(formatCompact(undefined)).toBe('0')
    expect(formatCompact(null)).toBe('0')
  })
})

describe('formatInteger', () => {
  test('formats with thousands separators', () => {
    expect(formatInteger(1234567)).toBe('1,234,567')
  })

  test('rounds a fractional value', () => {
    expect(formatInteger(42.6)).toBe('43')
  })

  test('treats missing/falsy values as 0', () => {
    expect(formatInteger(undefined)).toBe('0')
    expect(formatInteger(null)).toBe('0')
  })
})
