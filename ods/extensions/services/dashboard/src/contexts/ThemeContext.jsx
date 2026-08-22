import { createContext, useContext, useState, useEffect, useCallback } from 'react'

const STORAGE_KEY = 'ods-theme'
const THEMES = ['ods', 'lemonade', 'light', 'arctic']
const THEME_LABELS = {
  ods: 'ODS',
  lemonade: 'Lemonade',
  light: 'Light',
  arctic: 'Arctic'
}
const DEFAULT_THEME = 'ods'

const ThemeContext = createContext(null)

function readStoredTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return THEMES.includes(stored) ? stored : DEFAULT_THEME
  } catch {
    // Storage access itself throws when site data is blocked (strict
    // cookie settings, kiosk profiles): fall back to the default theme
    // instead of crashing the whole provider tree.
    return DEFAULT_THEME
  }
}

function persistTheme(nextTheme) {
  try {
    localStorage.setItem(STORAGE_KEY, nextTheme)
  } catch {
    // Same blocked-storage case on write; session-only theme is fine.
  }
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readStoredTheme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    persistTheme(theme)
  }, [theme])

  const setTheme = useCallback((t) => {
    if (THEMES.includes(t)) setThemeState(t)
  }, [])

  const cycleTheme = useCallback(() => {
    setThemeState(prev => {
      const idx = THEMES.indexOf(prev)
      return THEMES[(idx + 1) % THEMES.length]
    })
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, setTheme, cycleTheme, themes: THEMES, labels: THEME_LABELS }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
