import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import './globals.css'

// Fraunces — display: page headers + the brand wordmark. A variable serif with
// optical sizing (the larger it's set, the more expressive), so headings read as
// warm + editorial against the mono labels — a "vault you can read".
const display = localFont({
  variable: '--font-display',
  display: 'swap',
  src: [{ path: './fonts/fraunces-vf.woff2', weight: '300 700', style: 'normal' }],
})

// Space Grotesk — structural headings INSIDE the editor (note H1/H2…), kept a
// clean geometric sans so notes stay structured, not magazine-y.
const grotesk = localFont({
  variable: '--font-grotesk',
  display: 'swap',
  src: [
    { path: './fonts/spacegrotesk-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/spacegrotesk-700.woff2', weight: '700', style: 'normal' },
  ],
})

// Space Mono — labels / chrome
const mono = localFont({
  variable: '--font-mono',
  display: 'swap',
  src: [{ path: './fonts/spacemono-400.woff2', weight: '400', style: 'normal' }],
})

// Geist — body
const geist = localFont({
  variable: '--font-geist',
  display: 'swap',
  src: [
    { path: './fonts/geist-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/geist-500.woff2', weight: '500', style: 'normal' },
  ],
})

export const metadata: Metadata = {
  title: 'Agentkeep · Vault',
  description: 'Obsidian for agent users: a markdown vault your agent keeps.',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Agentkeep' },
  icons: { apple: '/apple-touch-icon.png' },
}

export const viewport: Viewport = { themeColor: '#3B6B53' }

// Set the theme on <html> BEFORE first paint (saved choice, else the OS
// preference) so there is no dark/light flash. The rail's ThemeToggle flips it.
const THEME_INIT = `(function(){try{var p=new URLSearchParams(location.search).get('theme');var t=(p==='light'||p==='dark')?p:localStorage.getItem('theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${grotesk.variable} ${mono.variable} ${geist.variable}`}
      suppressHydrationWarning
    >
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        {children}
      </body>
    </html>
  )
}
