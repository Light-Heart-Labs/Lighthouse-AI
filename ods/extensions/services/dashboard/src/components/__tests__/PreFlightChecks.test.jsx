import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PreFlightChecks } from '../PreFlightChecks' // eslint-disable-line no-unused-vars

const DEFAULT_PORTS = [{ port: 3000, service: 'open-webui' }, { port: 11434, service: 'llama-server' }]

function mockRoutes({
  ports = DEFAULT_PORTS,
  docker = { available: true, version: '27.0.0' },
  gpu = { available: true, name: 'RTX 4090', vram: 24, memory_type: 'discrete' },
  portsCheck = { conflicts: [] },
  disk = { free: 100e9 },
  dockerOk = true,
  gpuOk = true,
  portsOk = true,
  diskOk = true,
} = {}) {
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    if (url === '/api/preflight/required-ports') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ports }) })
    }
    if (url === '/api/preflight/docker') {
      return Promise.resolve({ ok: dockerOk, status: dockerOk ? 200 : 500, json: () => Promise.resolve(docker) })
    }
    if (url === '/api/preflight/gpu') {
      return Promise.resolve({ ok: gpuOk, status: gpuOk ? 200 : 500, json: () => Promise.resolve(gpu) })
    }
    if (url === '/api/preflight/ports' && options?.method === 'POST') {
      return Promise.resolve({ ok: portsOk, status: portsOk ? 200 : 500, json: () => Promise.resolve(portsCheck) })
    }
    if (url === '/api/preflight/disk') {
      return Promise.resolve({ ok: diskOk, status: diskOk ? 200 : 500, json: () => Promise.resolve(disk) })
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`))
  }))
}

describe('PreFlightChecks', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('all checks passing calls onComplete, not onIssuesFound', async () => {
    mockRoutes()
    const onComplete = vi.fn()
    const onIssuesFound = vi.fn()

    render(<PreFlightChecks onComplete={onComplete} onIssuesFound={onIssuesFound} />)

    await waitFor(
      () => expect(screen.getByText('System checks complete')).toBeInTheDocument(),
      { timeout: 6000 },
    )
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onIssuesFound).not.toHaveBeenCalled()
    expect(screen.getByText('Docker 27.0.0')).toBeInTheDocument()
    expect(screen.getByText('2 ports available')).toBeInTheDocument()
  }, 10000)

  test('low disk space is a hard error and calls onIssuesFound instead of onComplete', async () => {
    mockRoutes({ disk: { free: 10e9 } })
    const onComplete = vi.fn()
    const onIssuesFound = vi.fn()

    render(<PreFlightChecks onComplete={onComplete} onIssuesFound={onIssuesFound} />)

    await waitFor(
      () => expect(screen.getByText('10GB free')).toBeInTheDocument(),
      { timeout: 6000 },
    )
    expect(screen.getByText('Need at least 20GB for models')).toBeInTheDocument()
    expect(onIssuesFound).toHaveBeenCalledTimes(1)
    expect(onComplete).not.toHaveBeenCalled()
    expect(screen.getByText('Issues found that may prevent installation')).toBeInTheDocument()
  }, 10000)

  test('a warning (moderate disk space) does not block onComplete', async () => {
    mockRoutes({ disk: { free: 30e9 } })
    const onComplete = vi.fn()

    render(<PreFlightChecks onComplete={onComplete} />)

    await waitFor(
      () => expect(screen.getByText('30GB free')).toBeInTheDocument(),
      { timeout: 6000 },
    )
    expect(screen.getByText('OK for minimal install')).toBeInTheDocument()
    expect(onComplete).toHaveBeenCalledTimes(1)
  }, 10000)

  test('port conflicts that are all ODS\'s own services count as success', async () => {
    mockRoutes({
      portsCheck: { conflicts: [{ port: 3000, service: 'open-webui' }] },
    })

    render(<PreFlightChecks />)

    await waitFor(
      () => expect(screen.getByText('1 services already running')).toBeInTheDocument(),
      { timeout: 6000 },
    )
  }, 10000)

  test('a real third-party port conflict surfaces as a warning with a fix hint', async () => {
    mockRoutes({
      portsCheck: { conflicts: [{ port: 8080, service: 'some-other-app' }] },
    })

    render(<PreFlightChecks />)

    await waitFor(
      () => expect(screen.getByText('1 port(s) in use')).toBeInTheDocument(),
      { timeout: 6000 },
    )
    expect(screen.getByText('Port 8080 (some-other-app)')).toBeInTheDocument()
  }, 10000)

  test('unified-memory GPUs show the memory_label instead of a VRAM number', async () => {
    mockRoutes({
      gpu: { available: true, name: 'Ryzen AI Max+ 395', memory_type: 'unified', memory_label: '128GB unified' },
    })

    render(<PreFlightChecks />)

    await waitFor(
      () => expect(screen.getByText('Ryzen AI Max+ 395 (128GB unified)')).toBeInTheDocument(),
      { timeout: 6000 },
    )
  }, 10000)

  test('a failed API call (e.g. docker check 500) degrades to a warning, not an error', async () => {
    mockRoutes({ dockerOk: false })
    const onComplete = vi.fn()
    const onIssuesFound = vi.fn()

    render(<PreFlightChecks onComplete={onComplete} onIssuesFound={onIssuesFound} />)

    await waitFor(
      () => expect(screen.getByText('System checks complete')).toBeInTheDocument(),
      { timeout: 6000 },
    )
    expect(screen.getByText('API error (500)')).toBeInTheDocument()
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onIssuesFound).not.toHaveBeenCalled()
  }, 10000)

  test('Retry Checks re-runs the full check sequence', async () => {
    mockRoutes({ disk: { free: 10e9 } })

    render(<PreFlightChecks />)

    await waitFor(
      () => expect(screen.getByText('Retry Checks')).toBeInTheDocument(),
      { timeout: 6000 },
    )
    fetch.mockClear()

    fireEvent.click(screen.getByText('Retry Checks'))

    await waitFor(() => {
      // A fresh run re-fetches docker/gpu/ports/disk (required-ports is not
      // re-fetched by runChecks() called with no args).
      expect(fetch).toHaveBeenCalledWith('/api/preflight/docker')
    })
  }, 10000)
})
