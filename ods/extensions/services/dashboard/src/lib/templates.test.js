import { describe, test, expect } from 'vitest'
import { getTemplateStatus, BASE_COMPOSE_SERVICES } from './templates'

describe('getTemplateStatus', () => {
  test('returns available when the template has no services', () => {
    expect(getTemplateStatus({ services: [] }, [])).toBe('available')
    expect(getTemplateStatus({}, [])).toBe('available')
  })

  test('treats base compose services as always enabled', () => {
    const template = { services: ['llama-server', 'open-webui'] }
    expect(getTemplateStatus(template, [])).toBe('applied')
  })

  test('returns applied when every service is enabled', () => {
    const template = { services: ['svc-a', 'svc-b'] }
    const extensions = [
      { id: 'svc-a', status: 'enabled' },
      { id: 'svc-b', status: 'enabled' },
    ]
    expect(getTemplateStatus(template, extensions)).toBe('applied')
  })

  test('returns available when at least one service is not enabled', () => {
    const template = { services: ['svc-a', 'svc-b'] }
    const extensions = [
      { id: 'svc-a', status: 'enabled' },
      { id: 'svc-b', status: 'disabled' },
    ]
    expect(getTemplateStatus(template, extensions)).toBe('available')
  })

  test('returns in_progress when any service is installing or setting_up', () => {
    const installing = { services: ['svc-a', 'svc-b'] }
    expect(getTemplateStatus(installing, [
      { id: 'svc-a', status: 'enabled' },
      { id: 'svc-b', status: 'installing' },
    ])).toBe('in_progress')

    const settingUp = { services: ['svc-a', 'svc-b'] }
    expect(getTemplateStatus(settingUp, [
      { id: 'svc-a', status: 'setting_up' },
      { id: 'svc-b', status: 'enabled' },
    ])).toBe('in_progress')
  })

  test('returns has_errors when any service errored, taking precedence over in_progress', () => {
    const template = { services: ['svc-a', 'svc-b'] }
    const extensions = [
      { id: 'svc-a', status: 'error' },
      { id: 'svc-b', status: 'installing' },
    ]
    expect(getTemplateStatus(template, extensions)).toBe('has_errors')
  })

  test('treats a service missing from the catalog as undefined status, not enabled', () => {
    const template = { services: ['svc-a', 'unknown-svc'] }
    const extensions = [{ id: 'svc-a', status: 'enabled' }]
    expect(getTemplateStatus(template, extensions)).toBe('available')
  })

  test('exports the expected base compose service ids', () => {
    expect([...BASE_COMPOSE_SERVICES].sort()).toEqual(
      ['dashboard', 'dashboard-api', 'llama-server', 'open-webui'].sort(),
    )
  })
})
