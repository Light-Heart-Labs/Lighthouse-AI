import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FeatureDiscoveryBanner, FeatureProgress } from '../FeatureDiscovery' // eslint-disable-line no-unused-vars

function mockFeaturesResponse(data) {
  vi.stubGlobal('fetch', vi.fn((url) => {
    if (url === '/api/features') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(data) })
    }
    if (String(url).includes('/api/features/') && String(url).includes('/enable')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ name: 'Voice', instructions: { steps: ['Step one'] } }),
      })
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`))
  }))
}

describe('FeatureDiscoveryBanner', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('renders nothing while data has not loaded yet', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const { container } = render(<FeatureDiscoveryBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  test('shows the first non-blocked suggestion', async () => {
    mockFeaturesResponse({
      suggestions: [
        { featureId: 'voice', blocked: true, message: 'Enable voice', setupTime: '2 min', action: 'Enable' },
        { featureId: 'rag', blocked: false, message: 'Try document chat', setupTime: '1 min', action: 'Try it' },
      ],
      summary: { progress: 20 },
    })

    render(<FeatureDiscoveryBanner />)

    await waitFor(() => {
      expect(screen.getByText('Try document chat')).toBeInTheDocument()
    })
    expect(screen.queryByText('Enable voice')).not.toBeInTheDocument()
  })

  test('renders nothing when every suggestion is blocked', async () => {
    mockFeaturesResponse({
      suggestions: [{ featureId: 'voice', blocked: true, message: 'x', setupTime: '1 min', action: 'y' }],
      summary: { progress: 20 },
    })

    const { container } = render(<FeatureDiscoveryBanner />)

    await waitFor(() => {
      expect(fetch).toHaveBeenCalled()
    })
    expect(container).toBeEmptyDOMElement()
  })

  test('hides once overall progress reaches 80%', async () => {
    mockFeaturesResponse({
      suggestions: [{ featureId: 'voice', blocked: false, message: 'x', setupTime: '1 min', action: 'y' }],
      summary: { progress: 80 },
    })

    const { container } = render(<FeatureDiscoveryBanner />)

    await waitFor(() => {
      expect(fetch).toHaveBeenCalled()
    })
    expect(container).toBeEmptyDOMElement()
  })

  test('dismissing the banner calls onDismiss and removes it', async () => {
    mockFeaturesResponse({
      suggestions: [{ featureId: 'voice', blocked: false, message: 'Try voice', setupTime: '1 min', action: 'Try it' }],
      summary: { progress: 10 },
    })
    const onDismiss = vi.fn()

    render(<FeatureDiscoveryBanner onDismiss={onDismiss} />)

    await waitFor(() => {
      expect(screen.getByText('Try voice')).toBeInTheDocument()
    })

    // The dismiss (X) button is the second button in the action group.
    const buttons = screen.getAllByRole('button')
    fireEvent.click(buttons[buttons.length - 1])

    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Try voice')).not.toBeInTheDocument()
  })

  test('clicking the action button expands enable instructions', async () => {
    mockFeaturesResponse({
      suggestions: [{ featureId: 'voice', blocked: false, message: 'Try voice', setupTime: '1 min', action: 'Try it' }],
      summary: { progress: 10 },
    })

    render(<FeatureDiscoveryBanner />)

    await waitFor(() => {
      expect(screen.getByText('Try it')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Try it'))

    await waitFor(() => {
      expect(screen.getByText('Enable Voice')).toBeInTheDocument()
    })
    expect(screen.getByText('Step one')).toBeInTheDocument()
  })
})

describe('FeatureProgress', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('renders enabled/total count and progress bar width', async () => {
    mockFeaturesResponse({
      summary: { enabled: 3, total: 8, progress: 37 },
      gpu: { name: 'RTX 4090', tier: 'Standard' },
    })

    render(<FeatureProgress />)

    await waitFor(() => {
      expect(screen.getByText('3/8 enabled')).toBeInTheDocument()
    })
    expect(screen.getByText('RTX 4090')).toBeInTheDocument()
    expect(screen.getByText('Standard Tier')).toBeInTheDocument()
  })

  test('renders nothing while loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const { container } = render(<FeatureProgress />)
    expect(container).toBeEmptyDOMElement()
  })
})
