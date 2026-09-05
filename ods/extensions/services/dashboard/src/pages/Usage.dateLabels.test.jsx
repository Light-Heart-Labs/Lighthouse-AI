import { describe, test, expect } from 'vitest'
import { formatDateLabel, formatRangeLabel } from './Usage'

describe('formatDateLabel', () => {
  test('formats a date key as "Mon D"', () => {
    expect(formatDateLabel('2026-05-16')).toBe('May 16')
  })

  test('does not shift across a month/year boundary (local midnight parsing)', () => {
    expect(formatDateLabel('2026-01-01')).toBe('Jan 1')
    expect(formatDateLabel('2025-12-31')).toBe('Dec 31')
  })
})

describe('formatRangeLabel', () => {
  test('formats a same-month range as "Mon D - Mon D, YYYY"', () => {
    const label = formatRangeLabel({ start: '2026-05-01', end: '2026-05-31' })
    expect(label).toBe('May 1 - May 31, 2026')
  })

  test('formats a cross-month range showing both month names', () => {
    const label = formatRangeLabel({ start: '2026-04-15', end: '2026-05-15' })
    expect(label).toBe('Apr 15 - May 15, 2026')
  })
})
