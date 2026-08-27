import { describe, test, expect } from 'vitest'
import { emptyReport } from './Usage'

describe('emptyReport', () => {
  test('builds a zeroed-out summary and period', () => {
    const report = emptyReport('2026-05-01', '2026-05-03')
    expect(report.period).toEqual({ start: '2026-05-01', end: '2026-05-03' })
    expect(report.summary.spend_usd).toBe(0)
    expect(report.summary.total_tokens).toBe(0)
    expect(report.models).toEqual([])
    expect(report.services).toEqual([])
    expect(report.sources).toEqual([])
  })

  test('generates one zeroed daily entry per day in the range, inclusive', () => {
    const report = emptyReport('2026-05-01', '2026-05-03')
    expect(report.daily).toHaveLength(3)
    expect(report.daily.map(d => d.date)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03'])
    expect(report.daily.every(d => d.spend_usd === 0 && d.requests === 0)).toBe(true)
  })

  test('produces a single-day list when start equals end', () => {
    const report = emptyReport('2026-05-01', '2026-05-01')
    expect(report.daily).toHaveLength(1)
  })

  test('marks the source as unavailable with the given detail message', () => {
    const report = emptyReport('2026-05-01', '2026-05-01', 'Token Spy is not installed')
    expect(report.source).toEqual({
      name: 'token-spy',
      status: 'unavailable',
      detail: 'Token Spy is not installed',
    })
  })

  test('defaults detail to null when not provided', () => {
    const report = emptyReport('2026-05-01', '2026-05-01')
    expect(report.source.detail).toBeNull()
  })
})
