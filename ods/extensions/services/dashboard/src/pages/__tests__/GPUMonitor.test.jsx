import { fireEvent, render, screen } from '@testing-library/react'
import GPUMonitor from '../GPUMonitor' // eslint-disable-line no-unused-vars
import { useGPUDetailed } from '../../hooks/useGPUDetailed'

vi.mock('../../hooks/useGPUDetailed', () => ({
  useGPUDetailed: vi.fn(),
}))

// GPUMonitor renders GPUCard/GPUChart/TopologyView/AssignmentTable as
// children; stub them so this suite tests GPUMonitor's own logic (loading/
// error gates, the aggregate strip, tab switching) in isolation.
vi.mock('../../components/GPUCard', () => ({
  GPUCard: ({ gpu }) => <div data-testid={`gpu-card-${gpu.uuid}`}>{gpu.name}</div>,
}))
vi.mock('../../components/GPUChart', () => ({
  GPUChart: ({ gpuIndex }) => <div data-testid={`gpu-chart-${gpuIndex}`} />,
}))
vi.mock('../../components/TopologyView', () => ({
  TopologyView: () => <div data-testid="topology-view" />,
}))
vi.mock('../../components/AssignmentTable', () => ({
  AssignmentTable: () => <div data-testid="assignment-table" />,
}))

function baseDetailed(overrides = {}) {
  return {
    gpus: [
      { uuid: 'gpu-0', index: 0, name: 'RTX 4090' },
      { uuid: 'gpu-1', index: 1, name: 'RTX 4090' },
    ],
    backend: 'nvidia',
    gpu_count: 2,
    aggregate: null,
    assignment: null,
    split_mode: null,
    tensor_split: null,
    ...overrides,
  }
}

describe('GPUMonitor', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('renders a loading skeleton while data is loading', () => {
    useGPUDetailed.mockReturnValue({ detailed: null, history: null, topology: null, loading: true, error: null })
    render(<GPUMonitor />)
    expect(screen.queryByText('GPU Monitor')).not.toBeInTheDocument()
  })

  test('renders an error state when the hook reports an error', () => {
    useGPUDetailed.mockReturnValue({
      detailed: null, history: null, topology: null, loading: false, error: 'network down',
    })
    render(<GPUMonitor />)
    expect(screen.getByText('GPU data unavailable')).toBeInTheDocument()
    expect(screen.getByText('network down')).toBeInTheDocument()
  })

  test('renders a generic error message when detailed is missing but no explicit error', () => {
    useGPUDetailed.mockReturnValue({
      detailed: null, history: null, topology: null, loading: false, error: null,
    })
    render(<GPUMonitor />)
    expect(screen.getByText('No GPU data returned from API.')).toBeInTheDocument()
  })

  test('renders per-GPU cards and the header once data loads', () => {
    useGPUDetailed.mockReturnValue({
      detailed: baseDetailed(), history: {}, topology: null, loading: false, error: null,
    })
    render(<GPUMonitor />)
    expect(screen.getByText('GPU Monitor')).toBeInTheDocument()
    expect(screen.getByText((_, node) => node?.textContent === '2 GPUs · nvidia')).toBeInTheDocument()
    expect(screen.getByTestId('gpu-card-gpu-0')).toBeInTheDocument()
    expect(screen.getByTestId('gpu-card-gpu-1')).toBeInTheDocument()
  })

  test('singular GPU count text for a single GPU', () => {
    useGPUDetailed.mockReturnValue({
      detailed: baseDetailed({ gpus: [{ uuid: 'gpu-0', index: 0, name: 'RTX 4090' }], gpu_count: 1 }),
      history: {},
      topology: null,
      loading: false,
      error: null,
    })
    render(<GPUMonitor />)
    expect(screen.getByText((_, node) => node?.textContent === '1 GPU · nvidia')).toBeInTheDocument()
  })

  test('does not show the aggregate strip for a single GPU even if aggregate data exists', () => {
    useGPUDetailed.mockReturnValue({
      detailed: baseDetailed({
        gpus: [{ uuid: 'gpu-0', index: 0, name: 'RTX 4090' }],
        gpu_count: 1,
        aggregate: { name: 'RTX 4090', utilization_percent: 50 },
      }),
      history: {},
      topology: null,
      loading: false,
      error: null,
    })
    render(<GPUMonitor />)
    expect(screen.queryByText('Aggregate')).not.toBeInTheDocument()
  })

  test('shows the aggregate strip with formatted VRAM for multi-GPU systems', () => {
    useGPUDetailed.mockReturnValue({
      detailed: baseDetailed({
        aggregate: {
          name: '2x RTX 4090',
          utilization_percent: 55,
          memory_used_mb: 10240,
          memory_total_mb: 49152,
          memory_percent: 20,
          temperature_c: 72,
          power_w: 640,
        },
      }),
      history: {},
      topology: null,
      loading: false,
      error: null,
    })
    render(<GPUMonitor />)
    expect(screen.getByText('Aggregate')).toBeInTheDocument()
    expect(screen.getByText('55%')).toBeInTheDocument()
    expect(screen.getByText('10.0/48 GB')).toBeInTheDocument()
    expect(screen.getByText('72°C')).toBeInTheDocument()
    expect(screen.getByText('640W')).toBeInTheDocument()
  })

  test('shows an em-dash for aggregate metrics explicitly marked unavailable', () => {
    useGPUDetailed.mockReturnValue({
      detailed: baseDetailed({
        aggregate: {
          name: '2x GPU',
          utilization_available: false,
          memory_usage_available: false,
          temperature_available: false,
          power_w: null,
        },
      }),
      history: {},
      topology: null,
      loading: false,
      error: null,
    })
    render(<GPUMonitor />)
    expect(screen.getAllByText('—').length).toBe(4)
  })

  test('shows split_mode/tensor_split only when at least one is present', () => {
    useGPUDetailed.mockReturnValue({
      detailed: baseDetailed({
        aggregate: { name: 'x', utilization_percent: 1, memory_used_mb: 1, memory_total_mb: 2, memory_percent: 1, temperature_c: 1, power_w: 1 },
        split_mode: 'layer',
        tensor_split: '0.5,0.5',
      }),
      history: {},
      topology: null,
      loading: false,
      error: null,
    })
    render(<GPUMonitor />)
    expect(screen.getByText('layer')).toBeInTheDocument()
    expect(screen.getByText('0.5,0.5')).toBeInTheDocument()
  })

  test('switching to the History tab renders GPUChart per GPU instead of GPUCard', () => {
    useGPUDetailed.mockReturnValue({
      detailed: baseDetailed(), history: {}, topology: null, loading: false, error: null,
    })
    render(<GPUMonitor />)

    expect(screen.getByTestId('gpu-card-gpu-0')).toBeInTheDocument()
    fireEvent.click(screen.getByText('History'))

    expect(screen.queryByTestId('gpu-card-gpu-0')).not.toBeInTheDocument()
    expect(screen.getByTestId('gpu-chart-0')).toBeInTheDocument()
    expect(screen.getByTestId('gpu-chart-1')).toBeInTheDocument()
  })

  test('renders TopologyView and AssignmentTable when present on the overview tab', () => {
    useGPUDetailed.mockReturnValue({
      detailed: baseDetailed({ assignment: { strategy: 'auto', services: {} }, }),
      history: {},
      topology: { gpus: [], links: [] },
      loading: false,
      error: null,
    })
    render(<GPUMonitor />)
    expect(screen.getByTestId('topology-view')).toBeInTheDocument()
    expect(screen.getByTestId('assignment-table')).toBeInTheDocument()
  })
})
