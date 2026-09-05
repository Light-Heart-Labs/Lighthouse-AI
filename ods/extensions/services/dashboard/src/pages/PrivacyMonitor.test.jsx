import { fireEvent, screen, waitFor } from '@testing-library/react'
import { render } from '../test/test-utils'
import { coreRoutes } from '../plugins/core'
import PrivacyMonitor from './PrivacyMonitor' // eslint-disable-line no-unused-vars

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

const enabledStatus = {
  enabled: true,
  container_running: true,
  port: 8085,
  target_api: 'http://llama-server:8080/v1',
  pii_cache_enabled: true,
  message: 'Privacy Shield is active',
}

const stats = {
  cache_enabled: true,
  cache_size: 1000,
  active_sessions: 4,
  total_pii_scrubbed: 13,
}

describe('PrivacyMonitor', () => {
  afterEach(() => vi.restoreAllMocks())

  test('renders status and stats without displaying captured PII values', async () => {
    const fetchMock = vi.fn(async (url) => (
      url === '/api/privacy-shield/status' ? response(enabledStatus) : response(stats)
    ))
    vi.stubGlobal('fetch', fetchMock)
    render(<PrivacyMonitor />)

    expect(await screen.findByRole('heading', { name: 'Privacy Shield' })).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText('13')).toBeInTheDocument()
    expect(screen.getByText('Current mappings, not a lifetime counter')).toBeInTheDocument()
    expect(screen.getByText('http://llama-server:8080/v1')).toBeInTheDocument()
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/privacy-shield/status',
      '/api/privacy-shield/stats',
    ])
  })

  test('does not request protected stats while the shield is disabled', async () => {
    const fetchMock = vi.fn(async () => response({
      enabled: false,
      container_running: false,
      port: 8085,
      pii_cache_enabled: true,
      message: 'Privacy Shield is not running',
    }))
    vi.stubGlobal('fetch', fetchMock)
    render(<PrivacyMonitor />)

    expect(await screen.findByText('Inactive')).toBeInTheDocument()
    expect(screen.getByText(/Enable Privacy Shield from Extensions/)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/privacy-shield/status', expect.objectContaining({ signal: expect.anything() }))
  })

  test('reports stats errors independently and can refresh', async () => {
    const fetchMock = vi.fn(async (url) => (
      url === '/api/privacy-shield/status'
        ? response(enabledStatus)
        : response({ error: 'SHIELD_API_KEY not configured', enabled: false })
    ))
    vi.stubGlobal('fetch', fetchMock)
    render(<PrivacyMonitor />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Statistics unavailable: SHIELD_API_KEY not configured')
    expect(screen.getByText('Active')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
  })

  test('is registered as a sidebar route', () => {
    expect(coreRoutes.find(route => route.id === 'privacy')).toMatchObject({
      path: '/privacy',
      label: 'Privacy',
      sidebar: true,
    })
  })
})
