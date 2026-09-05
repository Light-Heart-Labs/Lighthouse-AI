import { describe, test, expect } from 'vitest'
import { buildSparkShape } from './Usage'

describe('buildSparkShape', () => {
  test('returns empty line/area for no values', () => {
    expect(buildSparkShape([])).toEqual({ line: '', area: '' })
  })

  test('builds an SVG path starting with M for a single value', () => {
    const { line, area } = buildSparkShape([5])
    expect(line.startsWith('M')).toBe(true)
    expect(area).toContain('Z')
  })

  test('spans the full width for multiple values, first point at x=0', () => {
    const { line } = buildSparkShape([1, 2, 3], 100, 50)
    const firstPoint = line.split(' ').slice(0, 3).join(' ')
    expect(firstPoint).toBe('M 0.00 44.00')
  })

  test('does not divide by zero when all values are identical', () => {
    const { line } = buildSparkShape([7, 7, 7], 100, 50)
    expect(line).not.toContain('NaN')
    expect(line).not.toContain('Infinity')
  })

  test('does not divide by zero when all values are identically zero', () => {
    const { line } = buildSparkShape([0, 0, 0], 100, 50)
    expect(line).not.toContain('NaN')
  })

  test('treats missing/non-numeric entries as 0', () => {
    const { line } = buildSparkShape([null, undefined, 'x'], 100, 50)
    expect(line).not.toContain('NaN')
  })

  test('the area path closes back to the baseline forming a filled region', () => {
    const { line, area } = buildSparkShape([1, 5, 2], 100, 50)
    expect(area.startsWith(line)).toBe(true)
    expect(area).toMatch(/L 100\.00 46\.00 L 0 46\.00 Z$/)
  })
})
