import { describe, expect, it } from 'vitest'
import { gpuHistoryToCsv } from './gpuHistoryCsv'

describe('gpuHistoryToCsv', () => {
  it('exports aligned long-form rows in timestamp and numeric GPU order', () => {
    const csv = gpuHistoryToCsv({
      timestamps: ['2026-09-04T00:00:00Z', '2026-09-04T00:00:05Z'],
      gpus: {
        10: {
          utilization: [90, 91],
          memory_percent: [80, 81],
          temperature: [70, 71],
          power_w: [null, 301],
        },
        2: {
          utilization: [20, 21],
          memory_percent: [30, 31],
          temperature: [40, 41],
          power_w: [50, 51],
        },
      },
    })

    expect(csv).toBe([
      'timestamp,gpu_index,utilization_percent,memory_percent,temperature_c,power_w',
      '2026-09-04T00:00:00Z,2,20,30,40,50',
      '2026-09-04T00:00:00Z,10,90,80,70,',
      '2026-09-04T00:00:05Z,2,21,31,41,51',
      '2026-09-04T00:00:05Z,10,91,81,71,301',
      '',
    ].join('\r\n'))
  })

  it('keeps unavailable metrics blank and neutralizes spreadsheet formulas', () => {
    const csv = gpuHistoryToCsv({
      timestamps: ['=unsafe'],
      gpus: {
        '@gpu,0': { utilization: [null] },
      },
    })

    expect(csv).toContain("'=unsafe,\"'@gpu,0\",,,,")
  })
})
