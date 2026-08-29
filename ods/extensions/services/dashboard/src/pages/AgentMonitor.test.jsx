import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { render } from '../test/test-utils'
import AgentMonitor from './AgentMonitor' // eslint-disable-line no-unused-vars
import { coreRoutes } from '../plugins/core'

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

const metrics = {
  timestamp: '2026-08-29T12:00:00Z',
  agent: { session_count: 7, last_update: '2026-08-29T11:59:59Z' },
  cluster: {
    active_gpus: 2,
    total_gpus: 3,
    failover_ready: true,
    nodes: [
      { id: 'gpu-a', name: 'GPU A', healthy: true, model: 'qwen' },
      { id: 'gpu-b', name: 'GPU B', healthy: false, model: 'llama' },
    ],
  },
  throughput: {
    current: 12.5,
    average: 10,
    peak: 15,
    history: [
      { timestamp: '2026-08-29T11:59:50Z', tokens_per_sec: 10 },
      { timestamp: '2026-08-29T11:59:55Z', tokens_per_sec: 15 },
    ],
  },
}

describe('AgentMonitor', () => {
  afterEach(() => vi.restoreAllMocks())

  test('renders the authenticated agent metrics contract', async () => {
    const fetchMock = vi.fn(async () => response(metrics))
    vi.stubGlobal('fetch', fetchMock)
    render(<AgentMonitor />)

    expect(await screen.findByRole('heading', { name: 'Agent Monitor' })).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(screen.getByText('12.5 tok/s')).toBeInTheDocument()
    expect(screen.getByText('2/3')).toBeInTheDocument()
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByLabelText('Recent token throughput').children).toHaveLength(2)
    const nodes = screen.getByRole('heading', { name: 'Cluster nodes' }).closest('section')
    expect(within(nodes).getByText('GPU A')).toBeInTheDocument()
    expect(within(nodes).getByText('Healthy')).toBeInTheDocument()
    expect(within(nodes).getByText('GPU B')).toBeInTheDocument()
    expect(within(nodes).getByText('Unavailable')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/metrics', expect.objectContaining({ signal: expect.anything() }))
  })

  test('is registered as a sidebar route', () => {
    expect(coreRoutes.find(route => route.id === 'agents')).toMatchObject({
      path: '/agents',
      label: 'Agents',
      sidebar: true,
    })
  })

  test('keeps the latest snapshot visible when a refresh fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(metrics))
      .mockResolvedValueOnce(response({ detail: 'temporarily unavailable' }, 503))
    vi.stubGlobal('fetch', fetchMock)
    render(<AgentMonitor />)

    expect(await screen.findByText('12.5 tok/s')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Agent metrics request failed (503)')
    expect(screen.getByText('12.5 tok/s')).toBeInTheDocument()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })
})
