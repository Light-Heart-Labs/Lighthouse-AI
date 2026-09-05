import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { formatRelative } from './Invites'

const NOW = new Date('2026-01-01T12:00:00Z')

describe('formatRelative', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('returns null for a missing timestamp', () => {
    expect(formatRelative(null)).toBeNull()
    expect(formatRelative(undefined)).toBeNull()
    expect(formatRelative('')).toBeNull()
  })

  test('returns null for an unparseable timestamp', () => {
    expect(formatRelative('not-a-date')).toBeNull()
  })

  test('collapses sub-minute differences to "just now" / "in seconds"', () => {
    expect(formatRelative(new Date(NOW.getTime() - 10_000).toISOString())).toBe('just now')
    expect(formatRelative(new Date(NOW.getTime() + 10_000).toISOString())).toBe('in seconds')
  })

  test('formats minute-scale differences', () => {
    expect(formatRelative(new Date(NOW.getTime() - 5 * 60_000).toISOString())).toBe('5m ago')
    expect(formatRelative(new Date(NOW.getTime() + 5 * 60_000).toISOString())).toBe('in 5m')
  })

  test('formats hour-scale differences', () => {
    expect(formatRelative(new Date(NOW.getTime() - 2 * 3_600_000).toISOString())).toBe('2h ago')
    expect(formatRelative(new Date(NOW.getTime() + 2 * 3_600_000).toISOString())).toBe('in 2h')
  })

  test('formats day-scale differences', () => {
    expect(formatRelative(new Date(NOW.getTime() - 3 * 86_400_000).toISOString())).toBe('3d ago')
    expect(formatRelative(new Date(NOW.getTime() + 3 * 86_400_000).toISOString())).toBe('in 3d')
  })
})
