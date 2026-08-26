import { fireEvent, render, screen } from '@testing-library/react'
import { TroubleshootingAssistant } from '../TroubleshootingAssistant' // eslint-disable-line no-unused-vars

describe('TroubleshootingAssistant', () => {
  test('renders all common issues by default, collapsed', () => {
    render(<TroubleshootingAssistant serviceStatus={null} />)

    expect(screen.getByText('Port already in use')).toBeInTheDocument()
    expect(screen.getByText('GPU not detected')).toBeInTheDocument()
    expect(screen.getByText('Docker not running or accessible')).toBeInTheDocument()
    // Collapsed: symptom/solution detail is not rendered until expanded.
    expect(screen.queryByText('Likely cause:')).not.toBeInTheDocument()
  })

  test('search filters issues by title', () => {
    render(<TroubleshootingAssistant serviceStatus={null} />)

    fireEvent.change(screen.getByLabelText('Search troubleshooting issues'), {
      target: { value: 'docker' },
    })

    expect(screen.getByText('Docker not running or accessible')).toBeInTheDocument()
    expect(screen.queryByText('Port already in use')).not.toBeInTheDocument()
  })

  test('search filters issues by symptom text', () => {
    render(<TroubleshootingAssistant serviceStatus={null} />)

    fireEvent.change(screen.getByLabelText('Search troubleshooting issues'), {
      target: { value: 'microphone' },
    })

    expect(screen.getByText('Voice services not ready')).toBeInTheDocument()
    expect(screen.queryByText('Docker not running or accessible')).not.toBeInTheDocument()
  })

  test('a search with no matches renders no issue cards', () => {
    render(<TroubleshootingAssistant serviceStatus={null} />)

    fireEvent.change(screen.getByLabelText('Search troubleshooting issues'), {
      target: { value: 'nonexistent-problem-xyz' },
    })

    expect(screen.queryByText('Port already in use')).not.toBeInTheDocument()
    expect(screen.queryByText('GPU not detected')).not.toBeInTheDocument()
  })

  test('clicking an issue expands it to show symptoms, cause, and solutions', () => {
    render(<TroubleshootingAssistant serviceStatus={null} />)

    fireEvent.click(screen.getByText('Docker not running or accessible'))

    expect(screen.getByText('Likely cause:')).toBeInTheDocument()
    expect(screen.getByText('Docker service stopped or user not in docker group')).toBeInTheDocument()
    expect(screen.getByText('Start Docker service')).toBeInTheDocument()
  })

  test('clicking an expanded issue again collapses it', () => {
    render(<TroubleshootingAssistant serviceStatus={null} />)

    const header = screen.getByText('Docker not running or accessible')
    fireEvent.click(header)
    expect(screen.getByText('Likely cause:')).toBeInTheDocument()

    fireEvent.click(header)
    expect(screen.queryByText('Likely cause:')).not.toBeInTheDocument()
  })

  test('surfaces a "Detected potential issues" banner when llama-server is unhealthy', () => {
    render(
      <TroubleshootingAssistant
        serviceStatus={{ services: [{ name: 'llama-server (LLM Inference)', status: 'unhealthy' }] }}
      />,
    )

    expect(screen.getByText('Detected potential issues:')).toBeInTheDocument()
    // Both gpu-not-detected and model-loading key off llama-server being unhealthy.
    const relevantMarkers = screen.getAllByText('(may be relevant)')
    expect(relevantMarkers.length).toBe(2)
  })

  test('does not surface the relevant-issues banner when all services are healthy', () => {
    render(
      <TroubleshootingAssistant
        serviceStatus={{ services: [{ name: 'llama-server (LLM Inference)', status: 'healthy' }] }}
      />,
    )

    expect(screen.queryByText('Detected potential issues:')).not.toBeInTheDocument()
  })

  test('the relevant-issues banner is hidden while searching', () => {
    render(
      <TroubleshootingAssistant
        serviceStatus={{ services: [{ name: 'llama-server (LLM Inference)', status: 'unhealthy' }] }}
      />,
    )
    expect(screen.getByText('Detected potential issues:')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Search troubleshooting issues'), {
      target: { value: 'docker' },
    })

    expect(screen.queryByText('Detected potential issues:')).not.toBeInTheDocument()
  })

  test('copying a command writes it to the clipboard', () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    render(<TroubleshootingAssistant serviceStatus={null} />)
    fireEvent.click(screen.getByText('Docker not running or accessible'))

    const command = screen.getByText('sudo systemctl start docker')
    const copyButton = command.parentElement.querySelector('button')
    fireEvent.click(copyButton)

    expect(writeText).toHaveBeenCalledWith('sudo systemctl start docker')
  })
})
