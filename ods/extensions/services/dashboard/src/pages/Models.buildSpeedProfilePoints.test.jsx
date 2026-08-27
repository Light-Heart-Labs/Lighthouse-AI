import { describe, test, expect } from 'vitest'
import { buildSpeedProfilePoints } from './Models'

describe('buildSpeedProfilePoints', () => {
  test('returns an empty array when speed is falsy', () => {
    expect(buildSpeedProfilePoints({ id: 'llama-3.1-8b' }, 0)).toEqual([])
    expect(buildSpeedProfilePoints({ id: 'llama-3.1-8b' }, null)).toEqual([])
  })

  test('returns 14 points spanning x from 0 to 100', () => {
    const points = buildSpeedProfilePoints({ id: 'llama-3.1-8b', contextLength: 8192 }, 42)
    expect(points).toHaveLength(14)
    expect(points[0].x).toBe(0)
    expect(points[points.length - 1].x).toBeCloseTo(100)
  })

  test('keeps every y coordinate within the clamped drawing range', () => {
    const points = buildSpeedProfilePoints({ id: 'mistral-7b', contextLength: 32768 }, 90)
    for (const point of points) {
      expect(point.y).toBeGreaterThanOrEqual(6.6)
      expect(point.y).toBeLessThanOrEqual(22.6)
    }
  })

  test('is deterministic for the same model and speed', () => {
    const model = { id: 'llama-3.1-8b', contextLength: 8192 }
    expect(buildSpeedProfilePoints(model, 55)).toEqual(buildSpeedProfilePoints(model, 55))
  })

  test('falls back to model.name and then a fixed seed when id is missing', () => {
    const byName = buildSpeedProfilePoints({ name: 'phi-3-mini' }, 30)
    const byNameAgain = buildSpeedProfilePoints({ name: 'phi-3-mini' }, 30)
    const anonymous = buildSpeedProfilePoints({}, 30)
    expect(byName).toEqual(byNameAgain)
    expect(anonymous).toHaveLength(14)
  })

  test('produces a different profile for a different model id', () => {
    const a = buildSpeedProfilePoints({ id: 'model-a', contextLength: 4096 }, 60)
    const b = buildSpeedProfilePoints({ id: 'model-b', contextLength: 4096 }, 60)
    expect(a).not.toEqual(b)
  })
})
