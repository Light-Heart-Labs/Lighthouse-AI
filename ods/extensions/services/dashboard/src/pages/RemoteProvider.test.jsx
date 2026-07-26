import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import RemoteProvider from './RemoteProvider'

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

const statusPayload = {
  status: 'ready',
  routeState: {
    exists: true,
    valid: true,
    enabled: true,
    mode: 'cloud',
    provider: {
      capability: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: 'qwen/remote:latest',
      transport: 'ssh',
    },
    projection: {
      publicModel: 'ods/current',
      gateway: 'litellm-cloud',
      egressBaseUrl: 'http://remote-provider-egress:8091/v1',
      consumerRoute: 'gateway',
    },
    status: {
      proven: true,
      reason: 'provider-handshake-ok',
      lastProbe: {
        schema: 'ods.remote-provider-probe-receipt.v1',
        ok: true,
        verifiedAt: '2026-07-26T00:00:00+00:00',
        endpoint: '/v1/models',
        httpStatus: 200,
        modelCount: 1,
        resolution: { ok: true, addressCount: 0 },
      },
    },
    errors: [],
  },
  sshSupervisor: {
    reachable: true,
    valid: true,
    status: 'running',
    ready: true,
    readyToStart: true,
    reason: 'ready',
    missingSecrets: [],
  },
  egress: {
    reachable: true,
    valid: true,
    ready: true,
    status: 'ok',
    reason: 'ready',
    secret: { configured: true, bytes: 24 },
    resolution: { ok: true, addressCount: 0 },
  },
  capabilities: {
    inference: true,
    odsPeerLifecycle: false,
  },
  availableActions: {
    configure: true,
    test: true,
    disable: true,
    remove: true,
  },
}

const probePayload = {
  schema: 'ods.remote-provider-egress-probe.v1',
  ok: true,
  transport: 'ssh',
  probe: {
    schema: 'ods.remote-provider-probe-receipt.v1',
    ok: true,
    verifiedAt: '2026-07-26T00:05:00+00:00',
    endpoint: '/v1/models',
    httpStatus: 200,
    modelCount: 2,
    resolution: { ok: true, addressCount: 0 },
  },
  tunnel: {
    ok: true,
    ready: true,
    status: 'running',
    reason: 'ready',
  },
  routeProof: {
    recorded: true,
    reachable: true,
    schema: 'ods.remote-provider-proof-record.v1',
    status: {
      proven: true,
      reason: 'provider-handshake-ok',
      lastProbe: {
        schema: 'ods.remote-provider-probe-receipt.v1',
        ok: true,
        verifiedAt: '2026-07-26T00:05:00+00:00',
        endpoint: '/v1/models',
        httpStatus: 200,
        modelCount: 2,
        resolution: { ok: true, addressCount: 0 },
      },
    },
  },
}

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('renders remote provider status and proof receipt', async () => {
  globalThis.fetch.mockResolvedValueOnce(response(statusPayload))

  render(createElement(RemoteProvider))

  expect(await screen.findByRole('heading', { name: 'Remote GPU' })).toBeInTheDocument()
  expect(screen.getByText('qwen/remote:latest')).toBeInTheDocument()
  expect(screen.getByText('Provider handshake ok')).toBeInTheDocument()
  expect(screen.getByText('2026-07-26T00:00:00+00:00')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /test route/i })).toBeEnabled()
})

test('runs configured route probe and shows proof recording result', async () => {
  globalThis.fetch
    .mockResolvedValueOnce(response(statusPayload))
    .mockResolvedValueOnce(response(probePayload))
    .mockResolvedValueOnce(response(statusPayload))

  render(createElement(RemoteProvider))

  fireEvent.click(await screen.findByRole('button', { name: /test route/i }))

  await waitFor(() => {
    expect(globalThis.fetch.mock.calls.map(call => call[0])).toEqual([
      '/api/remote-provider/status',
      '/api/remote-provider/probe',
      '/api/remote-provider/status',
    ])
  })
  expect(screen.getByText('Route proof recorded')).toBeInTheDocument()
  expect(screen.getByText('2026-07-26T00:05:00+00:00')).toBeInTheDocument()
})
