import { describe, test, expect } from 'vitest'
import { statusMeta, normalizeStatus, computeLayout, edgePath } from './ServiceMap'

describe('statusMeta', () => {
  test('returns the meta for a known status', () => {
    expect(statusMeta('healthy').text).toBe('text-green-400')
    expect(statusMeta('degraded').text).toBe('text-yellow-400')
  })

  test('falls back to the unknown meta for an unrecognized status', () => {
    expect(statusMeta('some-future-status')).toEqual(statusMeta('unknown'))
    expect(statusMeta(undefined)).toEqual(statusMeta('unknown'))
  })
})

describe('normalizeStatus', () => {
  test('passes a real status through unchanged', () => {
    expect(normalizeStatus('healthy')).toBe('healthy')
  })

  test('defaults to "unknown" for a missing status', () => {
    expect(normalizeStatus(null)).toBe('unknown')
    expect(normalizeStatus(undefined)).toBe('unknown')
    expect(normalizeStatus('')).toBe('unknown')
  })
})

describe('computeLayout', () => {
  test('places nodes into rows by category and sizes the canvas to fit', () => {
    const nodes = [
      { id: 'a', name: 'Alpha', category: 'core' },
      { id: 'b', name: 'Beta', category: 'core' },
      { id: 'c', name: 'Gamma', category: 'middleware' },
    ]
    const layout = computeLayout(nodes)
    expect(Object.keys(layout.positions)).toEqual(['a', 'b', 'c'])
    // core row has 2 nodes -> a's row starts before b's (sorted alphabetically).
    expect(layout.positions.a.x).toBeLessThan(layout.positions.b.x)
    expect(layout.positions.a.y).toBe(layout.positions.b.y)
    // middleware is a separate row, below core.
    expect(layout.layerY.middleware).toBeGreaterThan(layout.layerY.core)
  })

  test('sorts nodes within a row alphabetically by name', () => {
    const nodes = [
      { id: 'z', name: 'Zebra', category: 'core' },
      { id: 'a', name: 'Alpha', category: 'core' },
    ]
    const layout = computeLayout(nodes)
    expect(layout.positions.a.x).toBeLessThan(layout.positions.z.x)
  })

  test('a missing category falls back to "other"', () => {
    const nodes = [{ id: 'x', name: 'X' }]
    const layout = computeLayout(nodes)
    expect(layout.positions.x).toBeDefined()
  })

  test('an explicit category not in LAYERS is silently dropped from the layout (rows[cat]?.push is a no-op)', () => {
    // Only a falsy category falls back to "other" (node.category || 'other').
    // An explicit unrecognized string looks up a row that doesn't exist in
    // `rows`, and the optional-chained push silently does nothing -- the
    // node never gets a position. In the real app this can't happen because
    // buildTopology() always assigns category via `CATEGORY_MAP[id] || 'other'`,
    // but computeLayout() itself has no such guard for a directly-passed node.
    const nodes = [{ id: 'x', name: 'X', category: 'nonexistent-category' }]
    const layout = computeLayout(nodes)
    expect(layout.positions.x).toBeUndefined()
  })

  test('enforces a minimum canvas size for a small graph', () => {
    const layout = computeLayout([{ id: 'a', name: 'Alpha', category: 'core' }])
    expect(layout.svgWidth).toBeGreaterThanOrEqual(1080)
    expect(layout.svgHeight).toBeGreaterThanOrEqual(720)
  })

  test('handles an empty node list without crashing', () => {
    const layout = computeLayout([])
    expect(layout.positions).toEqual({})
  })
})

describe('edgePath', () => {
  test('draws downward when the target is below the source', () => {
    const source = { x: 0, y: 0 }
    const target = { x: 100, y: 200 }
    const path = edgePath(source, target)
    expect(path.startsWith('M')).toBe(true)
    expect(path).toContain('L')
  })

  test('draws upward when the target is above the source', () => {
    const source = { x: 0, y: 200 }
    const target = { x: 100, y: 0 }
    const downPath = edgePath({ x: 0, y: 0 }, { x: 100, y: 200 })
    const upPath = edgePath(source, target)
    // The two orientations should produce different path data (the
    // source/target connection points swap sides based on relative y).
    expect(upPath).not.toBe(downPath)
  })
})
