import { fireEvent, render, screen } from '@testing-library/react'
/* eslint-disable no-unused-vars -- each import is used only in JSX below */
import { DependencyBadges, DependencyConfirmDialog, DisableDependentWarning } from '../DependencyBadges'
/* eslint-enable no-unused-vars */

describe('DependencyBadges', () => {
  test('renders nothing when there are no dependencies', () => {
    const { container } = render(<DependencyBadges dependsOn={[]} dependencyStatus={{}} />)
    expect(container).toBeEmptyDOMElement()
  })

  test('renders nothing when dependsOn is not provided', () => {
    const { container } = render(<DependencyBadges dependencyStatus={{}} />)
    expect(container).toBeEmptyDOMElement()
  })

  test('lists each dependency with its status in the title', () => {
    render(
      <DependencyBadges
        dependsOn={['qdrant', 'embeddings']}
        dependencyStatus={{ qdrant: 'enabled', embeddings: 'incompatible' }}
      />,
    )

    expect(screen.getByText('qdrant')).toBeInTheDocument()
    expect(screen.getByText('qdrant').closest('span')).toHaveAttribute('title', 'qdrant: enabled')
    expect(screen.getByText('embeddings').closest('span')).toHaveAttribute('title', 'embeddings: incompatible')
  })

  test('falls back to "unknown" status for a dependency missing from dependencyStatus', () => {
    render(<DependencyBadges dependsOn={['qdrant']} dependencyStatus={{}} />)
    expect(screen.getByText('qdrant').closest('span')).toHaveAttribute('title', 'qdrant: unknown')
  })
})

describe('DependencyConfirmDialog', () => {
  test('renders nothing when ext is missing', () => {
    const { container } = render(
      <DependencyConfirmDialog ext={null} missingDeps={['qdrant']} onConfirm={() => {}} onCancel={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  test('renders nothing when missingDeps is empty', () => {
    const { container } = render(
      <DependencyConfirmDialog ext={{ name: 'n8n' }} missingDeps={[]} onConfirm={() => {}} onCancel={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  test('lists the extension name and each missing dependency', () => {
    render(
      <DependencyConfirmDialog
        ext={{ name: 'n8n' }}
        missingDeps={['qdrant', 'litellm']}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByText('n8n')).toBeInTheDocument()
    expect(screen.getByText('qdrant')).toBeInTheDocument()
    expect(screen.getByText('litellm')).toBeInTheDocument()
  })

  test('Enable All calls onConfirm, Cancel calls onCancel', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <DependencyConfirmDialog
        ext={{ name: 'n8n' }}
        missingDeps={['qdrant']}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )

    fireEvent.click(screen.getByText('Enable All'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  test('clicking the backdrop calls onCancel, clicking inside the dialog does not', () => {
    const onCancel = vi.fn()
    render(
      <DependencyConfirmDialog
        ext={{ name: 'n8n' }}
        missingDeps={['qdrant']}
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    )

    fireEvent.click(screen.getByRole('dialog'))
    expect(onCancel).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('dialog').parentElement)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('DisableDependentWarning', () => {
  test('renders nothing when there are no dependents', () => {
    const { container } = render(<DisableDependentWarning dependents={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  test('renders nothing when dependents is not provided', () => {
    const { container } = render(<DisableDependentWarning />)
    expect(container).toBeEmptyDOMElement()
  })

  test('warns which services would break, comma-joined', () => {
    render(<DisableDependentWarning dependents={['n8n', 'openclaw']} />)
    expect(screen.getByText('Disabling this may break: n8n, openclaw')).toBeInTheDocument()
  })
})
