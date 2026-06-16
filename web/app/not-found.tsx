import Link from 'next/link'

/**
 * Themed 404 (Reading Room). Renders inside the root layout but outside the app
 * shell: warm paper background, a fleuron, one line of copy, a way home.
 */
export default function NotFound() {
  return (
    <main className="nf">
      <span className="nf-star" aria-hidden="true">
        <svg width="46" height="12" viewBox="0 0 46 12" fill="none">
          <path d="M2 6H18" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          <path d="M28 6H44" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          <path d="M23 2.5 26 6 23 9.5 20 6Z" fill="currentColor" />
        </svg>
      </span>
      <span className="lbl">404</span>
      <h1 className="nf-title">This note does not exist yet.</h1>
      <p className="nf-sub">Nothing lives at this address. Your vault is still where you left it.</p>
      <Link className="nf-home" href="/">
        Back to your vault
      </Link>
    </main>
  )
}
