'use client'

import { useEffect, useState } from 'react'

function ThemeIcon({ kind }: { kind: 'moon' | 'sun' }) {
  const p = {
    width: 12,
    height: 12,
    viewBox: '0 0 12 12',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  if (kind === 'sun') {
    return (
      <svg {...p}>
        <circle cx="6" cy="6" r="2.1" />
        <path d="M6 1.4v1.1M6 9.5v1.1M1.4 6h1.1M9.5 6h1.1M2.7 2.7l0.8 0.8M8.5 8.5l0.8 0.8M9.3 2.7l-0.8 0.8M3.5 8.5l-0.8 0.8" />
      </svg>
    )
  }
  return (
    <svg {...p}>
      <path d="M8.5 9.6A4.2 4.2 0 0 1 5.2 2.1 4.4 4.4 0 1 0 8.5 9.6z" />
    </svg>
  )
}

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
          <ThemeIcon kind="moon" />
        </span>
        <span className="themeswitch-ic sun" aria-hidden="true">
          <ThemeIcon kind="sun" />
        </span>
        <span className="themeswitch-knob" />
      </span>
      <span className="themeswitch-lbl">{theme === 'dark' ? 'Dark' : 'Light'}</span>
    </button>
  )
}
