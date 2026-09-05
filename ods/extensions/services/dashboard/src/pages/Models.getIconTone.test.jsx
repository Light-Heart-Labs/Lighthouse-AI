import { describe, test, expect } from 'vitest'
import { getIconTone } from './Models'

describe('getIconTone', () => {
  test('returns the orange tone when the model does not fit VRAM, regardless of compatibility', () => {
    const tone = getIconTone({ fitsVram: false }, { tone: 'green', detail: 'Best' })
    expect(tone).toEqual({ border: 'border-orange-400/35', bg: 'bg-orange-500/10', text: 'text-orange-400' })
  })

  test('returns the orange tone when model is missing entirely', () => {
    const tone = getIconTone(null, { tone: 'green', detail: 'Best' })
    expect(tone.text).toBe('text-orange-400')
  })

  test('returns the amber tone when compatibility is amber and the model fits', () => {
    const tone = getIconTone({ fitsVram: true }, { tone: 'amber', detail: 'Good' })
    expect(tone).toEqual({ border: 'border-amber-400/35', bg: 'bg-amber-500/10', text: 'text-amber-300' })
  })

  test('returns the accent tone for the best-fit compatibility detail', () => {
    const tone = getIconTone({ fitsVram: true }, { tone: 'green', detail: 'Best' })
    expect(tone).toEqual({ border: 'border-theme-accent/35', bg: 'bg-theme-accent/10', text: 'text-theme-accent' })
  })

  test('falls back to the emerald tone for a fitting, non-amber, non-best model', () => {
    const tone = getIconTone({ fitsVram: true }, { tone: 'green', detail: 'Good' })
    expect(tone).toEqual({ border: 'border-emerald-400/30', bg: 'bg-emerald-500/10', text: 'text-emerald-400' })
  })
})
