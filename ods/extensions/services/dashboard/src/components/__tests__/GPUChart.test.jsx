import { render, screen } from '@testing-library/react'
import { GPUChart } from '../GPUChart' // eslint-disable-line no-unused-vars

describe('GPUChart', () => {
  test('shows a placeholder when there is no history for this GPU index', () => {
    render(<GPUChart history={{ timestamps: [], gpus: {} }} gpuIndex={0} />)
    expect(screen.getByText('No history yet — collecting samples...')).toBeInTheDocument()
  })

  test('shows a placeholder when timestamps is empty even if gpu data exists', () => {
    render(
      <GPUChart
        history={{ timestamps: [], gpus: { 0: { utilization: [10, 20] } } }}
        gpuIndex={0}
      />,
    )
    expect(screen.getByText('No history yet — collecting samples...')).toBeInTheDocument()
  })

  test('shows a placeholder when this GPU index has no entry', () => {
    render(
      <GPUChart
        history={{ timestamps: [1000, 2000], gpus: { 1: { utilization: [10, 20] } } }}
        gpuIndex={0}
      />,
    )
    expect(screen.getByText('No history yet — collecting samples...')).toBeInTheDocument()
  })

  test('renders the GPU index and time range header', () => {
    render(
      <GPUChart
        history={{
          timestamps: [1700000000000, 1700000060000],
          gpus: { 0: { utilization: [10, 42] } },
        }}
        gpuIndex={0}
      />,
    )
    expect(screen.getByText('GPU 0 History')).toBeInTheDocument()
  })

  test('formats an integer latest value without decimals', () => {
    render(
      <GPUChart
        history={{ timestamps: [1, 2], gpus: { 0: { utilization: [10, 42] } } }}
        gpuIndex={0}
      />,
    )
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  test('formats a non-integer latest value to one decimal place', () => {
    render(
      <GPUChart
        history={{ timestamps: [1, 2], gpus: { 0: { temperature: [55.2, 61.789] } } }}
        gpuIndex={0}
      />,
    )
    expect(screen.getByText('61.8')).toBeInTheDocument()
  })

  test('shows an em-dash for a metric with no data yet', () => {
    render(
      <GPUChart
        history={{ timestamps: [1, 2], gpus: { 0: { utilization: [10, 42] } } }}
        gpuIndex={0}
      />,
    )
    // power_w has no data for this GPU -> latest is undefined -> em-dash.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  test('a metric with fewer than 2 points renders the sparkline fallback block, not a chart line', () => {
    const { container } = render(
      <GPUChart
        history={{ timestamps: [1, 2], gpus: { 0: { utilization: [42] } } }}
        gpuIndex={0}
      />,
    )
    // With only 1 sample, Sparkline renders a plain placeholder div instead of an <svg>.
    // utilization is the first metric in METRICS, so its sparkline is the first chart slot.
    const svgs = container.querySelectorAll('svg')
    // memory_percent/temperature/power_w also have <2 points (no data), so all 4 fall back.
    expect(svgs.length).toBe(0)
  })

  test('renders an SVG sparkline once a metric has 2+ points', () => {
    const { container } = render(
      <GPUChart
        history={{ timestamps: [1, 2, 3], gpus: { 0: { utilization: [10, 20, 30] } } }}
        gpuIndex={0}
      />,
    )
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(1)
  })
})
