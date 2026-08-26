import { fireEvent, render, screen } from '@testing-library/react'
import InstallPromptBanner from '../InstallPromptBanner' // eslint-disable-line no-unused-vars
import { usePwaInstallPrompt } from '../../hooks/usePwaInstallPrompt'

vi.mock('../../hooks/usePwaInstallPrompt', () => ({
  usePwaInstallPrompt: vi.fn(),
}))

describe('InstallPromptBanner', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('renders nothing when shouldShow is false', () => {
    usePwaInstallPrompt.mockReturnValue({
      shouldShow: false,
      isIos: false,
      promptInstall: vi.fn(),
      dismiss: vi.fn(),
    })

    const { container } = render(<InstallPromptBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  test('non-iOS: shows the programmatic install button and generic copy', () => {
    usePwaInstallPrompt.mockReturnValue({
      shouldShow: true,
      isIos: false,
      promptInstall: vi.fn(),
      dismiss: vi.fn(),
    })

    render(<InstallPromptBanner />)

    expect(screen.getByText('Add to home screen')).toBeInTheDocument()
    expect(screen.getByText('Not now')).toBeInTheDocument()
    expect(screen.getByText('Install ODS as an app on this device for one-tap access — no browser tabs, no typing the address.')).toBeInTheDocument()
    expect(screen.queryByText('Share')).not.toBeInTheDocument()
  })

  test('iOS: hides the programmatic install button, shows Share instructions instead', () => {
    usePwaInstallPrompt.mockReturnValue({
      shouldShow: true,
      isIos: true,
      promptInstall: vi.fn(),
      dismiss: vi.fn(),
    })

    render(<InstallPromptBanner />)

    expect(screen.queryByText('Add to home screen')).not.toBeInTheDocument()
    expect(screen.queryByText('Not now')).not.toBeInTheDocument()
    expect(screen.getByText('Share')).toBeInTheDocument()
    expect(screen.getByText('Add to Home Screen')).toBeInTheDocument()
  })

  test('non-iOS: clicking "Add to home screen" calls promptInstall', () => {
    const promptInstall = vi.fn()
    usePwaInstallPrompt.mockReturnValue({
      shouldShow: true,
      isIos: false,
      promptInstall,
      dismiss: vi.fn(),
    })

    render(<InstallPromptBanner />)
    fireEvent.click(screen.getByText('Add to home screen'))

    expect(promptInstall).toHaveBeenCalledTimes(1)
  })

  test('the X button and "Not now" both call dismiss', () => {
    const dismiss = vi.fn()
    usePwaInstallPrompt.mockReturnValue({
      shouldShow: true,
      isIos: false,
      promptInstall: vi.fn(),
      dismiss,
    })

    render(<InstallPromptBanner />)

    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(dismiss).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('Not now'))
    expect(dismiss).toHaveBeenCalledTimes(2)
  })

  test('iOS: the X button still calls dismiss even without the "Not now" button', () => {
    const dismiss = vi.fn()
    usePwaInstallPrompt.mockReturnValue({
      shouldShow: true,
      isIos: true,
      promptInstall: vi.fn(),
      dismiss,
    })

    render(<InstallPromptBanner />)
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(dismiss).toHaveBeenCalledTimes(1)
  })
})
