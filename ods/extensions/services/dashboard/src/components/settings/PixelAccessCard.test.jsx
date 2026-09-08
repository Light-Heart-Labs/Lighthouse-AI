import {fireEvent, render, screen, waitFor} from '@testing-library/react'
import {afterEach, describe, expect, it, vi} from 'vitest'
import PixelAccessCard from './PixelAccessCard'

const safe = {available: true, surface: 'linux-systemd', configured_mode: 'sandboxed', effective_mode: 'unknown',
  runtime_verified: false, revision: 'a'.repeat(64), busy: false, pending: false, reason: 'runtime-proof-required'}
afterEach(() => vi.unstubAllGlobals())

describe('Pixel access confirmation and effective status', () => {
  it('does not present configured mode as effective or POST before explicit confirmation', async () => {
    const fetch = vi.fn(async (_url, options) => ({ok: true, json: async () => options ? {...safe, pending: true} : safe}))
    vi.stubGlobal('fetch', fetch)
    render(<PixelAccessCard />)
    await screen.findByText('Not verified')
    fireEvent.click(screen.getByRole('button', {name: 'Enable Full Access'}))
    expect(screen.getByRole('button', {name: 'Confirm and enable'})).toBeDisabled()
    expect(fetch.mock.calls.every(call => !call[1])).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', {name: 'Confirm and enable'}))
    await waitFor(() => expect(fetch.mock.calls.some(call => call[1]?.method === 'POST')).toBe(true))
    const options = fetch.mock.calls.find(call => call[1]?.method === 'POST')[1]
    expect(JSON.parse(options.body)).toEqual({mode: 'full-access', confirmed: true, revision: safe.revision})
    expect(screen.queryByText('Effective Full Access')).not.toBeInTheDocument()
  })

  it('blocks changes while work is active and displays a recovery path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ok: true, json: async () => ({...safe, busy: true, pending: true})})))
    render(<PixelAccessCard />)
    await screen.findByText(/transition is unfinished/i)
    expect(screen.getByRole('button', {name: 'Enable Full Access'})).toBeDisabled()
    expect(screen.getByRole('button', {name: 'Restore safer mode'})).toBeDisabled()
  })
})
