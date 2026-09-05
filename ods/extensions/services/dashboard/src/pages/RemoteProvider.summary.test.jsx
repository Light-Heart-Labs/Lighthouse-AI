import { describe, test, expect } from 'vitest'
import { routeSummary, writesSummary } from './RemoteProvider'

describe('writesSummary', () => {
  test('lists each true flag by its label, comma-joined', () => {
    expect(
      writesSummary({ routingState: true, providerSecret: true }),
    ).toBe('routing state, provider secret')
  })

  test('includes ssh identity/known-hosts and removal flags', () => {
    expect(
      writesSummary({
        sshIdentity: true,
        sshKnownHosts: true,
        removesRoutingState: true,
        removesSecrets: true,
      }),
    ).toBe('ssh identity, ssh known hosts, routing state removal, stored secret removal')
  })

  test('returns "None" when every flag is falsy', () => {
    expect(writesSummary({})).toBe('None')
    expect(writesSummary({ routingState: false })).toBe('None')
  })

  test('returns "None" for a non-object input instead of throwing', () => {
    expect(writesSummary(null)).toBe('None')
    expect(writesSummary(undefined)).toBe('None')
  })
})

describe('routeSummary', () => {
  test('shows the model and transport when a route is configured', () => {
    expect(
      routeSummary({ route: { provider: { model: 'qwen-remote', transport: 'ssh' } } }),
    ).toBe('qwen-remote via ssh')
  })

  test('defaults the transport label to "direct" when not specified', () => {
    expect(
      routeSummary({ route: { provider: { model: 'qwen-remote' } } }),
    ).toBe('qwen-remote via direct')
  })

  test('shows "Disabled route" when the route is explicitly disabled', () => {
    expect(routeSummary({ route: { enabled: false, provider: {} } })).toBe('Disabled route')
  })

  test('returns "None" when there is no model and the route is not explicitly disabled', () => {
    expect(routeSummary({ route: {} })).toBe('None')
    expect(routeSummary({})).toBe('None')
    expect(routeSummary(null)).toBe('None')
  })
})
