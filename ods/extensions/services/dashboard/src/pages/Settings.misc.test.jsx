import { describe, test, expect } from 'vitest'
import { formatCompact, matchesEnvSearch, getServiceDescription } from './Settings'

describe('formatCompact', () => {
  test('formats billions/millions/thousands with a unit suffix', () => {
    expect(formatCompact(2_500_000_000)).toBe('2.5B')
    // Millions use toFixed(2), so a value like 1.2M renders as "1.20M" --
    // the trailing-zero trim only strips an exact ".00", not ".X0".
    expect(formatCompact(1_200_000)).toBe('1.20M')
    expect(formatCompact(3_400)).toBe('3.4k')
  })

  test('trims a trailing .00/.0 for whole-unit values', () => {
    expect(formatCompact(2_000_000)).toBe('2M')
    expect(formatCompact(5_000)).toBe('5k')
  })

  test('rounds small values to a whole number with no suffix', () => {
    expect(formatCompact(42.6)).toBe('43')
  })

  test('treats missing/falsy values as 0', () => {
    expect(formatCompact(undefined)).toBe('0')
    expect(formatCompact(null)).toBe('0')
  })
})

describe('matchesEnvSearch', () => {
  test('matches everything when the query is empty', () => {
    expect(matchesEnvSearch('WEBUI_SECRET', {}, '')).toBe(true)
  })

  test('matches against the key', () => {
    expect(matchesEnvSearch('WEBUI_SECRET', {}, 'webui')).toBe(true)
  })

  test('matches against the field label and description', () => {
    expect(matchesEnvSearch('X', { label: 'Chat Secret' }, 'chat')).toBe(true)
    expect(matchesEnvSearch('X', { description: 'Used by Open WebUI' }, 'open webui')).toBe(true)
  })

  test('lowercases the haystack, but expects the caller to have already lowercased the query', () => {
    // The real call site (Settings.jsx) does envSearch.trim().toLowerCase()
    // before passing query in -- matchesEnvSearch itself does not lowercase it.
    expect(matchesEnvSearch('WEBUI_SECRET', {}, 'webui')).toBe(true)
    expect(matchesEnvSearch('WEBUI_SECRET', {}, 'WEBUI')).toBe(false)
  })

  test('returns false when nothing matches', () => {
    expect(matchesEnvSearch('WEBUI_SECRET', { label: 'Chat' }, 'unrelated-term')).toBe(false)
  })
})

describe('getServiceDescription', () => {
  test('prefers an explicit service.description', () => {
    expect(getServiceDescription({ id: 'n8n', description: 'Custom text' })).toBe('Custom text')
  })

  test('falls back to a known route description by id', () => {
    expect(getServiceDescription({ id: 'searxng' })).toBe('Private metasearch backend')
  })

  test('falls back to a known route description by name when id does not match', () => {
    expect(getServiceDescription({ id: 'unknown-id', name: 'whisper' })).toBe('Speech-to-text service')
  })

  test('falls back to a titleized category when no route description matches', () => {
    expect(getServiceDescription({ id: 'custom-thing', category: 'image_gen' })).toBe('Image Gen service')
  })

  test('falls back to a generic message when nothing else is available', () => {
    expect(getServiceDescription({ id: 'custom-thing' })).toBe('Service registered in the current ODS stack')
    expect(getServiceDescription(null)).toBe('Service registered in the current ODS stack')
  })
})
