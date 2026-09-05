import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router-dom'
import { render } from '../../test/test-utils'
import CommandPalette from '../CommandPalette' // eslint-disable-line no-unused-vars

const routes = [
  { id: 'dashboard', path: '/', label: 'Dashboard' },
  { id: 'models', path: '/models', label: 'Models' },
  { id: 'settings', path: '/settings', label: 'Settings' },
]

function Location() { // eslint-disable-line no-unused-vars
  return <output aria-label="Current route">{useLocation().pathname}</output>
}

function renderPalette() {
  return render(
    <>
      <CommandPalette routes={routes} />
      <Location />
    </>,
  )
}

describe('CommandPalette', () => {
  test('opens with the platform shortcut and filters registry routes', async () => {
    const user = userEvent.setup()
    renderPalette()

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const search = screen.getByRole('textbox', { name: 'Search dashboard pages' })
    expect(search).toHaveFocus()

    await user.type(search, 'model')
    expect(screen.getByRole('option', { name: /Models/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Settings/ })).not.toBeInTheDocument()
  })

  test('navigates the selected result with the keyboard', () => {
    renderPalette()

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const search = screen.getByRole('textbox', { name: 'Search dashboard pages' })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(screen.getByRole('status', { name: 'Current route' })).toHaveTextContent('/models')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('supports pointer navigation and escape dismissal', async () => {
    const user = userEvent.setup()
    renderPalette()

    await user.click(screen.getByRole('button', { name: 'Open command palette' }))
    await user.click(screen.getByRole('option', { name: /Settings/ }))
    expect(screen.getByRole('status', { name: 'Current route' })).toHaveTextContent('/settings')

    await user.click(screen.getByRole('button', { name: 'Open command palette' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
