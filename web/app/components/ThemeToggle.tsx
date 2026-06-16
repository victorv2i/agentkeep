'use client'

import { useEffect, useState } from 'react'

/**
 * Dark / light switch for the rail foot. The actual theme is an attribute on
 * <html> (data-theme), set before first paint by the no-flash script in
 * layout.tsx (reads the saved choice, else the OS preference). This toggle just
 * flips that attribute and persists the choice; the knob position is driven by
 * the attribute in CSS, so it stays correct on reload with no flash.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')

  useEffect(() => {
    const current = document.documentElement.dataset.theme
    setTheme(current === 'light' ? 'light' : 'dark')
  }, [])

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem('theme', next)
    } catch {
      // private mode / storage disabled — the choice just won't persist
    }
  }

  return (
    <button
      type="button"
      className="themeswitch"
      onClick={toggle}
      role="switch"
      aria-checked={theme === 'light'}
      aria-label="Toggle light and dark theme"
      title="Toggle light / dark"
    >
      <span className="themeswitch-track">
        <span className="themeswitch-ic moon" aria-hidden="true">
          ☾
        </span>
        <span className="themeswitch-ic sun" aria-hidden="true">
          ☀
        </span>
        <span className="themeswitch-knob" />
      </span>
      <span className="themeswitch-lbl">{theme === 'dark' ? 'Dark' : 'Light'}</span>
    </button>
  )
}
