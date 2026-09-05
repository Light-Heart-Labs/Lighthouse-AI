import { describe, test, expect } from 'vitest'
import { formatTokenCount, formatUptime, clamp } from './Dashboard'

describe('formatTokenCount', () => {
  test('formats billions/millions/thousands with a unit suffix', () => {
    expect(formatTokenCount(1_500_000_000)).toBe('1.5B')
    expect(formatTokenCount(1_500_000)).toBe('1.5M')
    expect(formatTokenCount(1_234)).toBe('1.2k')
  })

  test('renders small values as-is with no suffix', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(999)).toBe('999')
  })
})

describe('formatUptime', () => {
  test('renders days, hours, and minutes when uptime spans a day or more', () => {
    expect(formatUptime(90061)).toBe('1d 1h 1m')
  })

  test('renders hours and minutes for a sub-day uptime', () => {
    expect(formatUptime(3661)).toBe('1h 1m')
  })

  test('renders only minutes for a sub-hour uptime', () => {
    expect(formatUptime(120)).toBe('2m')
  })

  test('renders an em-dash for zero/falsy uptime (unlike Settings.jsx\'s formatUptime, which renders "0m")', () => {
    expect(formatUptime(0)).toBe('—')
    expect(formatUptime(null)).toBe('—')
    expect(formatUptime(undefined)).toBe('—')
  })
})

describe('clamp', () => {
  test('returns the value unchanged when within range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })

  test('clamps to the minimum', () => {
    expect(clamp(-5, 0, 10)).toBe(0)
  })

  test('clamps to the maximum', () => {
    expect(clamp(15, 0, 10)).toBe(10)
  })

  test('handles min === max', () => {
    expect(clamp(5, 3, 3)).toBe(3)
  })
})
