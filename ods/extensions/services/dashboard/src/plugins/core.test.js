import { describe, test, expect } from 'vitest'
import { coreRoutes, coreExternalLinks } from './core'

function routeById(id) {
  const route = coreRoutes.find(r => r.id === id)
  if (!route) throw new Error(`no core route with id ${id}`)
  return route
}

describe('coreRoutes: GPU Monitor sidebar visibility', () => {
  const gpuMonitor = routeById('gpu-monitor')

  test('is hidden from the sidebar with a single GPU', () => {
    expect(gpuMonitor.sidebar({ status: { gpu: { gpu_count: 1 } } })).toBe(false)
  })

  test('is hidden from the sidebar when gpu_count is missing (defaults to 1)', () => {
    expect(gpuMonitor.sidebar({ status: {} })).toBe(false)
    expect(gpuMonitor.sidebar({ status: null })).toBe(false)
  })

  test('is shown in the sidebar on multi-GPU systems', () => {
    expect(gpuMonitor.sidebar({ status: { gpu: { gpu_count: 2 } } })).toBe(true)
  })

  test('the route itself is always registered regardless of GPU count', () => {
    expect(gpuMonitor.path).toBe('/gpu')
    expect(coreRoutes.some(r => r.id === 'gpu-monitor')).toBe(true)
  })
})

describe('coreRoutes: getProps wiring', () => {
  test('dashboard forwards status and loading', () => {
    const props = routeById('dashboard').getProps({ status: { ok: true }, loading: true })
    expect(props).toEqual({ status: { ok: true }, loading: true })
  })

  test('usage forwards status only', () => {
    const props = routeById('usage').getProps({ status: { ok: true }, loading: true })
    expect(props).toEqual({ status: { ok: true } })
  })

  test('routes with no dependencies return an empty props object', () => {
    expect(routeById('extensions').getProps({ status: {}, loading: false })).toEqual({})
    expect(routeById('settings').getProps({})).toEqual({})
  })
})

describe('coreRoutes: sidebar entries not gated by hardware', () => {
  test('usage and invites are intentionally off the top-level sidebar', () => {
    expect(routeById('usage').sidebar).toBe(false)
    expect(routeById('invites').sidebar).toBe(false)
  })

  test('dashboard, extensions, models, settings are always in the sidebar', () => {
    for (const id of ['dashboard', 'extensions', 'models', 'settings']) {
      expect(routeById(id).sidebar).toBe(true)
    }
  })
})

describe('coreExternalLinks', () => {
  test('OpenCode is always visible regardless of health status', () => {
    const opencode = coreExternalLinks.find(l => l.id === 'opencode')
    expect(opencode).toBeTruthy()
    expect(opencode.alwaysVisible).toBe(true)
    expect(opencode.port).toBe(3003)
  })
})
