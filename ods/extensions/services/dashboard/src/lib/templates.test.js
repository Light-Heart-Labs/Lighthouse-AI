import { describe, test, expect } from 'vitest'
import { getTemplateStatus, BASE_COMPOSE_SERVICES } from './templates'

describe('getTemplateStatus', () => {
  test('returns "available" when the template has no services', () => {
    expect(getTemplateStatus({ services: [] }, [])).toBe('available')
    expect(getTemplateStatus({}, [])).toBe('available')
  })

  test('treats base-compose services as always enabled', () => {
    const template = { services: ['llama-server', 'open-webui'] }
    expect(getTemplateStatus(template, [])).toBe('applied')
  })

  test('returns "available" when a service is not installed', () => {
    const template = { services: ['n8n'] }
    expect(getTemplateStatus(template, [])).toBe('available')
  })

  test('returns "applied" only when every service is enabled', () => {
    const template = { services: ['n8n', 'qdrant'] }
    const extensions = [
      { id: 'n8n', status: 'enabled' },
      { id: 'qdrant', status: 'enabled' },
    ]
    expect(getTemplateStatus(template, extensions)).toBe('applied')
  })

  test('returns "in_progress" when a service is installing', () => {
    const template = { services: ['n8n', 'qdrant'] }
    const extensions = [
      { id: 'n8n', status: 'enabled' },
      { id: 'qdrant', status: 'installing' },
    ]
    expect(getTemplateStatus(template, extensions)).toBe('in_progress')
  })

  test('returns "in_progress" for a service that is setting_up', () => {
    const template = { services: ['n8n'] }
    const extensions = [{ id: 'n8n', status: 'setting_up' }]
    expect(getTemplateStatus(template, extensions)).toBe('in_progress')
  })

  test('returns "has_errors" when any service errored, even if others are enabled', () => {
    const template = { services: ['n8n', 'qdrant'] }
    const extensions = [
      { id: 'n8n', status: 'enabled' },
      { id: 'qdrant', status: 'error' },
    ]
    expect(getTemplateStatus(template, extensions)).toBe('has_errors')
  })

  test('precedence: has_errors beats in_progress when both are present', () => {
    const template = { services: ['a', 'b'] }
    const extensions = [
      { id: 'a', status: 'error' },
      { id: 'b', status: 'installing' },
    ]
    expect(getTemplateStatus(template, extensions)).toBe('has_errors')
  })

  test('precedence: in_progress beats applied when one service is still installing', () => {
    const template = { services: ['a', 'b'] }
    const extensions = [
      { id: 'a', status: 'enabled' },
      { id: 'b', status: 'installing' },
    ]
    expect(getTemplateStatus(template, extensions)).toBe('in_progress')
  })

  test('a mix of base-compose and catalog services can be "applied"', () => {
    const template = { services: ['llama-server', 'n8n'] }
    const extensions = [{ id: 'n8n', status: 'enabled' }]
    expect(getTemplateStatus(template, extensions)).toBe('applied')
  })
})

describe('BASE_COMPOSE_SERVICES', () => {
  test('contains the core always-on services', () => {
    expect(BASE_COMPOSE_SERVICES.has('llama-server')).toBe(true)
    expect(BASE_COMPOSE_SERVICES.has('open-webui')).toBe(true)
    expect(BASE_COMPOSE_SERVICES.has('dashboard')).toBe(true)
    expect(BASE_COMPOSE_SERVICES.has('dashboard-api')).toBe(true)
  })

  test('does not include a togglable extension like n8n', () => {
    expect(BASE_COMPOSE_SERVICES.has('n8n')).toBe(false)
  })
})
