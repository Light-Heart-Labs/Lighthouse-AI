import { describe, test, expect } from 'vitest'
import {
  buildSignalPath,
  reduceSamples,
  formatClockLabel,
  buildTimeLabels,
  buildChartPoints,
} from './Dashboard'

describe('buildSignalPath', () => {
  test('returns an empty string for no points', () => {
    expect(buildSignalPath([])).toBe('')
  })

  test('returns a single moveto for one point', () => {
    expect(buildSignalPath([{ x: 5, y: 10 }])).toBe('M 5 10')
  })

  test('starts with M and contains a Q curve segment for multiple points', () => {
    const path = buildSignalPath([{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 0 }])
    expect(path.startsWith('M 0 0')).toBe(true)
    expect(path).toContain('Q')
  })
})

describe('reduceSamples', () => {
  test('returns samples unchanged when already within maxPoints', () => {
    const samples = [1, 2, 3]
    expect(reduceSamples(samples, 16)).toEqual(samples)
  })

  test('downsamples to exactly maxPoints, keeping first and last', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i)
    const reduced = reduceSamples(samples, 10)
    expect(reduced).toHaveLength(10)
    expect(reduced[0]).toBe(0)
    expect(reduced[reduced.length - 1]).toBe(99)
  })
})

describe('formatClockLabel', () => {
  test('formats as HH:MM for non-7D ranges', () => {
    const ts = new Date('2026-05-16T09:05:00').getTime()
    expect(formatClockLabel(ts, '1H')).toBe('09:05')
  })

  test('formats as a weekday name for the 7D range', () => {
    const ts = new Date('2026-05-16T09:05:00').getTime() // a Saturday
    const label = formatClockLabel(ts, '7D')
    expect(typeof label).toBe('string')
    expect(label.length).toBeGreaterThan(0)
    expect(label).not.toMatch(/^\d{2}:\d{2}$/)
  })
})

describe('buildTimeLabels', () => {
  test('returns an empty array for no timestamps', () => {
    expect(buildTimeLabels([], '1H')).toEqual([])
  })

  test('samples 5 evenly-spaced labels across the timestamp range', () => {
    const timestamps = Array.from({ length: 100 }, (_, i) => Date.now() + i * 1000)
    const labels = buildTimeLabels(timestamps, '1H')
    expect(labels).toHaveLength(5)
  })

  test('does not crash with a single timestamp (all 5 indexes collapse to 0)', () => {
    const labels = buildTimeLabels([Date.now()], '1H')
    expect(labels).toHaveLength(5)
  })
})

describe('buildChartPoints', () => {
  test('maps values to x/y coordinates spanning the chart width', () => {
    const points = buildChartPoints([0, 50, 100], 100)
    expect(points).toHaveLength(3)
    expect(points[0].x).toBeCloseTo(38, 0) // paddingLeft
    expect(points[points.length - 1].x).toBeCloseTo(448, 0) // width - paddingRight
  })

  test('clamps the y ratio so a value of 0 does not touch the axis', () => {
    const points = buildChartPoints([0], 100)
    // ratio is clamped to a minimum of 0.08, so y must be less than the
    // full-height baseline (height - paddingBottom = 160).
    expect(points[0].y).toBeLessThan(160)
  })

  test('handles a zero maxValue without dividing by zero', () => {
    const points = buildChartPoints([5, 10], 0)
    expect(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
  })
})
