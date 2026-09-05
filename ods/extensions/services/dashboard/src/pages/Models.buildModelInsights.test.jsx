import { describe, test, expect } from 'vitest'
import { buildModelInsights } from './Models'

describe('buildModelInsights', () => {
  test('returns all-zero insights for an empty model list', () => {
    expect(buildModelInsights([])).toEqual([
      { label: 'Models That Fit Your GPU', value: 0 },
      { label: 'Installed Models', value: 0 },
      { label: 'Available Models', value: 0 },
      { label: 'Installed Storage', value: '0 GB' },
      { label: 'Catalog Size', value: '0 GB' },
    ])
  })

  test('counts fit/installed/available and sums storage across a mixed model list', () => {
    const models = [
      { status: 'downloaded', sizeGb: 4.5, fitsVram: true },
      { status: 'loaded', sizeGb: 8, fitsVram: true },
      { status: 'available', sizeGb: 2, fitsVram: false },
      { status: 'incompatible', sizeGb: 1, fitsVram: false },
    ]
    expect(buildModelInsights(models)).toEqual([
      { label: 'Models That Fit Your GPU', value: 2 },
      { label: 'Installed Models', value: 2 },
      { label: 'Available Models', value: 1 },
      { label: 'Installed Storage', value: '12.5 GB' },
      { label: 'Catalog Size', value: '15.5 GB' },
    ])
  })

  test('strips a trailing .0 from whole-number storage totals', () => {
    const models = [{ status: 'downloaded', sizeGb: 20, fitsVram: true }]
    const insights = buildModelInsights(models)
    expect(insights.find(item => item.label === 'Installed Storage').value).toBe('20 GB')
  })

  test('treats a missing sizeGb as 0 without breaking the sum', () => {
    const models = [
      { status: 'downloaded', fitsVram: true },
      { status: 'downloaded', sizeGb: 3, fitsVram: true },
    ]
    const insights = buildModelInsights(models)
    // formatNumber only strips a trailing .0 for totals >= 10; below that it keeps one decimal.
    expect(insights.find(item => item.label === 'Installed Storage').value).toBe('3.0 GB')
  })
})
