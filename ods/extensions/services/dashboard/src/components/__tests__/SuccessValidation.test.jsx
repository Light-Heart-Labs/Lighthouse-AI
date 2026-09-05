import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SuccessValidation } from '../SuccessValidation' // eslint-disable-line no-unused-vars

function statusWith(overrides = {}) {
  const services = [
    { name: 'llama-server (LLM Inference)', status: 'pending' },
    { name: 'Whisper (STT)', status: 'pending' },
    { name: 'Kokoro (TTS)', status: 'pending' },
    { name: 'Qdrant (Vector DB)', status: 'pending' },
    { name: 'n8n (Workflows)', status: 'pending' },
    ...(overrides.services || []),
  ]
  // overrides.services entries win over the pending defaults above by name.
  const byName = new Map(services.map(s => [s.name, s]))
  for (const s of overrides.services || []) byName.set(s.name, s)
  return { services: Array.from(byName.values()) }
}

describe('SuccessValidation: initial status derivation', () => {
  test('renders 0/4 ready when nothing is healthy yet', () => {
    render(<SuccessValidation status={statusWith()} />)
    expect(screen.getByText('0/4 features ready')).toBeInTheDocument()
  })

  test('marks a feature "passed" from initial status when its service is healthy', () => {
    render(
      <SuccessValidation
        status={statusWith({ services: [{ name: 'llama-server (LLM Inference)', status: 'healthy' }] })}
      />,
    )
    expect(screen.getByText('1/4 features ready')).toBeInTheDocument()
    expect(screen.getByText('llama-server (LLM Inference) is healthy')).toBeInTheDocument()
  })

  test('Voice I/O requires BOTH Whisper and Kokoro healthy, not just one', () => {
    render(
      <SuccessValidation
        status={statusWith({ services: [{ name: 'Whisper (STT)', status: 'healthy' }] })}
      />,
    )
    // Whisper alone healthy must not flip Voice I/O to passed.
    expect(screen.getByText('0/4 features ready')).toBeInTheDocument()
  })

  test('all four features healthy shows "All features working!" with no progress fraction', () => {
    render(
      <SuccessValidation
        status={statusWith({
          services: [
            { name: 'llama-server (LLM Inference)', status: 'healthy' },
            { name: 'Whisper (STT)', status: 'healthy' },
            { name: 'Kokoro (TTS)', status: 'healthy' },
            { name: 'Qdrant (Vector DB)', status: 'healthy' },
            { name: 'n8n (Workflows)', status: 'healthy' },
          ],
        })}
      />,
    )
    expect(screen.getByText('All features working!')).toBeInTheDocument()
  })

  test('renders nothing status-derived when status has no services', () => {
    render(<SuccessValidation status={{}} />)
    expect(screen.queryByText(/features ready/)).not.toBeInTheDocument()
  })
})

describe('SuccessValidation: Run Tests', () => {
  test('a passing live test result flips status to passed and shows the healthy line', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true }),
    }))

    render(<SuccessValidation status={statusWith()} />)
    fireEvent.click(screen.getByText('Run Tests'))

    await waitFor(
      () => {
        expect(screen.getByText('llama-server (LLM Inference) is healthy')).toBeInTheDocument()
      },
      { timeout: 6000 },
    )

    vi.unstubAllGlobals()
  }, 10000)

  test('a failing live test shows the returned error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: false, error: 'connection refused' }),
    }))

    render(<SuccessValidation status={statusWith()} />)
    fireEvent.click(screen.getByText('Run Tests'))

    await waitFor(
      () => {
        expect(screen.getByText('Error: connection refused')).toBeInTheDocument()
      },
      { timeout: 6000 },
    )

    vi.unstubAllGlobals()
  }, 10000)

  test('a network error during a live test falls back to a generic message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    render(<SuccessValidation status={statusWith()} />)
    fireEvent.click(screen.getByText('Run Tests'))

    await waitFor(
      () => {
        expect(screen.getByText('Error: Test endpoint not available')).toBeInTheDocument()
      },
      { timeout: 6000 },
    )

    vi.unstubAllGlobals()
  }, 10000)

  test('calls onAllPassed only once everything passes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true }),
    }))
    const onAllPassed = vi.fn()

    render(<SuccessValidation status={statusWith()} onAllPassed={onAllPassed} />)
    fireEvent.click(screen.getByText('Run Tests'))

    await waitFor(
      () => {
        expect(screen.getByText('All features working!')).toBeInTheDocument()
      },
      { timeout: 6000 },
    )
    expect(onAllPassed).toHaveBeenCalledTimes(1)

    vi.unstubAllGlobals()
  }, 10000)

  test('already-passed tests are not re-run', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true }) })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <SuccessValidation
        status={statusWith({ services: [{ name: 'llama-server (LLM Inference)', status: 'healthy' }] })}
      />,
    )
    fireEvent.click(screen.getByText('Run Tests'))

    await waitFor(
      () => {
        expect(screen.getByText('All features working!')).toBeInTheDocument()
      },
      { timeout: 6000 },
    )
    // llama was already passed from initial status, so its testUrl is never hit —
    // only the other 3 pending tests should have called fetch.
    expect(fetchMock).toHaveBeenCalledTimes(3)

    vi.unstubAllGlobals()
  }, 10000)
})
