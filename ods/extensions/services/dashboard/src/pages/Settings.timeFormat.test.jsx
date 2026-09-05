import { describe, test, expect } from 'vitest'
import { formatUptime, formatInstallDate, formatCheckedAt } from './Settings'

describe('formatUptime', () => {
  test('shows hours and minutes when uptime exceeds an hour', () => {
    expect(formatUptime(3661)).toBe('1h 1m')
  })

  test('shows only minutes when under an hour', () => {
    expect(formatUptime(120)).toBe('2m')
  })

  test('defaults to 0m when called with no argument', () => {
    expect(formatUptime()).toBe('0m')
  })

  test('handles exactly zero', () => {
    expect(formatUptime(0)).toBe('0m')
  })
})

describe('formatInstallDate', () => {
  test('returns "Unknown" for a missing value', () => {
    expect(formatInstallDate(null)).toBe('Unknown')
    expect(formatInstallDate(undefined)).toBe('Unknown')
  })

  test('returns the raw value unchanged for an invalid date', () => {
    expect(formatInstallDate('not-a-date')).toBe('not-a-date')
  })

  test('formats a valid ISO date with date and time', () => {
    const result = formatInstallDate('2026-07-20T14:58:20Z')
    expect(result).toContain('Jul 20, 2026')
    expect(result).toContain('  -  ')
  })
})

describe('formatCheckedAt', () => {
  test('returns null for a missing value', () => {
    expect(formatCheckedAt(null)).toBeNull()
    expect(formatCheckedAt(undefined)).toBeNull()
  })

  test('returns null for an invalid date (unlike formatInstallDate, which echoes it back)', () => {
    expect(formatCheckedAt('not-a-date')).toBeNull()
  })

  test('formats a valid ISO date to a locale string', () => {
    const result = formatCheckedAt('2026-07-20T14:58:20Z')
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})
