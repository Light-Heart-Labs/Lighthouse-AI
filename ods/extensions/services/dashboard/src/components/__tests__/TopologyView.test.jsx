import { render, screen } from '@testing-library/react'
import { TopologyView } from '../TopologyView' // eslint-disable-line no-unused-vars

const twoGpus = [
  { index: 0, name: 'NVIDIA GeForce RTX 4090', memory_gb: 24 },
  { index: 1, name: 'NVIDIA GeForce RTX 4090', memory_gb: 24 },
]

describe('TopologyView', () => {
  test('renders nothing when topology is missing', () => {
    const { container } = render(<TopologyView topology={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  test('single GPU shows the "no interconnect" message instead of a matrix', () => {
    render(
      <TopologyView
        topology={{ gpus: [twoGpus[0]], links: [], gpu_count: 1, vendor: 'nvidia' }}
      />,
    )
    expect(screen.getByText('Single GPU — no interconnect topology.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  test('multiple GPUs with no links shows "No interconnect links detected."', () => {
    render(
      <TopologyView topology={{ gpus: twoGpus, links: [], gpu_count: 2, vendor: 'nvidia' }} />,
    )
    expect(screen.getByText('No interconnect links detected.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  test('strips vendor prefixes from GPU chip names and shows memory', () => {
    render(
      <TopologyView topology={{ gpus: twoGpus, links: [], gpu_count: 2, vendor: 'nvidia' }} />,
    )
    expect(screen.getAllByText('GeForce RTX 4090').length).toBe(2)
    expect(screen.getAllByText('24GB').length).toBe(2)
  })

  test('renders a symmetric matrix: the link appears at both [a][b] and [b][a]', () => {
    render(
      <TopologyView
        topology={{
          gpus: twoGpus,
          links: [{ gpu_a: 0, gpu_b: 1, rank: 100, link_type: 'NVLink' }],
          gpu_count: 2,
          vendor: 'nvidia',
        }}
      />,
    )
    // The 2x2 matrix (minus the diagonal) renders the link cell twice — at
    // row0/col1 and row1/col0, proving buildMatrix() assigns both m[a][b]
    // and m[b][a] — plus once more in the link-type legend below the table.
    expect(screen.getAllByText('NVLink').length).toBe(3)
  })

  test('diagonal cells show an em-dash, missing links show a question mark', () => {
    render(
      <TopologyView
        topology={{
          gpus: [twoGpus[0], twoGpus[1], { index: 2, name: 'NVIDIA GeForce RTX 4090', memory_gb: 24 }],
          links: [{ gpu_a: 0, gpu_b: 1, rank: 100, link_type: 'NVLink' }],
          gpu_count: 3,
          vendor: 'nvidia',
        }}
      />,
    )
    // 3 diagonal cells (GPU0-0, GPU1-1, GPU2-2).
    expect(screen.getAllByText('—').length).toBe(3)
    // GPU0-2 and GPU1-2 (and symmetric) have no link data -> "?".
    expect(screen.getAllByText('?').length).toBeGreaterThan(0)
  })

  test('shows the driver version and MIG badge when present', () => {
    render(
      <TopologyView
        topology={{
          gpus: twoGpus,
          links: [{ gpu_a: 0, gpu_b: 1, rank: 100, link_type: 'NVLink' }],
          gpu_count: 2,
          vendor: 'nvidia',
          driver_version: '560.94',
          mig_enabled: true,
        }}
      />,
    )
    expect(screen.getByText('driver 560.94')).toBeInTheDocument()
    expect(screen.getByText('MIG')).toBeInTheDocument()
  })

  test('renders the link-type legend only when links exist', () => {
    const { rerender } = render(
      <TopologyView topology={{ gpus: twoGpus, links: [], gpu_count: 2, vendor: 'nvidia' }} />,
    )
    expect(screen.queryByText('NVLink')).not.toBeInTheDocument()

    rerender(
      <TopologyView
        topology={{
          gpus: twoGpus,
          links: [{ gpu_a: 0, gpu_b: 1, rank: 100, link_type: 'NVLink' }],
          gpu_count: 2,
          vendor: 'nvidia',
        }}
      />,
    )
    // "NVLink" now appears both as a matrix cell and as a legend entry.
    expect(screen.getAllByText('NVLink').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('PIX')).toBeInTheDocument()
  })
})
