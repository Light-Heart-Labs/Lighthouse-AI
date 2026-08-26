import { render, screen } from '@testing-library/react'
import { AssignmentTable } from '../AssignmentTable' // eslint-disable-line no-unused-vars

describe('AssignmentTable', () => {
  test('renders nothing when assignment is missing', () => {
    const { container } = render(<AssignmentTable assignment={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  test('renders nothing when there are no services', () => {
    const { container } = render(
      <AssignmentTable assignment={{ strategy: 'auto', services: {} }} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  test('renders the strategy badge and version', () => {
    render(
      <AssignmentTable
        assignment={{
          strategy: 'dedicated',
          version: 3,
          services: { 'llama-server': { gpus: [] } },
        }}
      />,
    )
    expect(screen.getByText('dedicated')).toBeInTheDocument()
    expect(screen.getByText('v3')).toBeInTheDocument()
  })

  test('falls back to the "auto" style for an unrecognized strategy without crashing', () => {
    render(
      <AssignmentTable
        assignment={{ strategy: 'weird-future-strategy', services: { svc: { gpus: [] } } }}
      />,
    )
    expect(screen.getByText('weird-future-strategy')).toBeInTheDocument()
  })

  test('shows "no GPUs" for a service with an empty gpu list', () => {
    render(
      <AssignmentTable assignment={{ strategy: 'auto', services: { 'llama-server': { gpus: [] } } }} />,
    )
    expect(screen.getByText('no GPUs')).toBeInTheDocument()
  })

  test('truncates a GPU-prefixed UUID to its last 8 characters, keeps a plain id intact', () => {
    render(
      <AssignmentTable
        assignment={{
          strategy: 'auto',
          services: {
            'llama-server': { gpus: ['GPU-12345678-abcd-ef00-1111-222233334444', '0'] },
          },
        }}
      />,
    )
    expect(screen.getByText('33334444')).toBeInTheDocument()
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  test('formats parallelism mode label and omits zero/absent optional suffixes', () => {
    render(
      <AssignmentTable
        assignment={{
          strategy: 'auto',
          services: {
            'llama-server': {
              gpus: [],
              parallelism: { mode: 'tensor', tensor_parallel_size: 1, pipeline_parallel_size: 1 },
            },
          },
        }}
      />,
    )
    expect(screen.getByText('Tensor Parallel')).toBeInTheDocument()
  })

  test('appends tp/pp/mem suffixes when parallelism sizes are above 1 and memory util is set', () => {
    render(
      <AssignmentTable
        assignment={{
          strategy: 'auto',
          services: {
            'llama-server': {
              gpus: [],
              parallelism: {
                mode: 'pipeline',
                tensor_parallel_size: 2,
                pipeline_parallel_size: 4,
                gpu_memory_utilization: 0.9,
              },
            },
          },
        }}
      />,
    )
    expect(
      screen.getByText('Pipeline Parallel · tp=2 · pp=4 · mem=90%'),
    ).toBeInTheDocument()
  })

  test('falls back to the raw mode string for an unrecognized parallelism mode', () => {
    render(
      <AssignmentTable
        assignment={{
          strategy: 'auto',
          services: { 'llama-server': { gpus: [], parallelism: { mode: 'custom-mode' } } },
        }}
      />,
    )
    expect(screen.getByText('custom-mode')).toBeInTheDocument()
  })

  test('renders multiple services, each with their own name', () => {
    render(
      <AssignmentTable
        assignment={{
          strategy: 'shared',
          services: {
            'llama-server': { gpus: [] },
            'comfyui': { gpus: [] },
          },
        }}
      />,
    )
    expect(screen.getByText('llama-server')).toBeInTheDocument()
    expect(screen.getByText('comfyui')).toBeInTheDocument()
  })
})
