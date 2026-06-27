'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A copy-able code block: monospace content with a
 * Copy button that writes the exact text to the clipboard. Used for the agent
 * config snippets on the Connect page — what's shown is what gets copied, so the
 * `code` prop is the single source of truth (no drift between display and copy).
 */
export function CopyBlock({ code, label }: { code: string; label?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setStatus('copied')
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setStatus('idle'), 1400)
    } catch {
      // Clipboard blocked (insecure context / permissions) — leave the block as
      // is; the text is still selectable by hand.
      if (timer.current) clearTimeout(timer.current)
      setStatus('error')
    }
  }, [code])

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const statusText =
    status === 'copied'
      ? 'Copied to clipboard.'
      : status === 'error'
        ? 'Copy failed. Select the text manually.'
        : ''

  return (
    <div className="codeblock">
      {label ? <span className="codeblock-lbl lbl">{label}</span> : null}
      <button type="button" className="codeblock-copy" onClick={() => void onCopy()}>
        {status === 'copied' ? 'Copied' : status === 'error' ? 'Retry copy' : 'Copy'}
      </button>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {statusText}
      </span>
      <pre className="codeblock-pre">
        <code>{code}</code>
      </pre>
    </div>
  )
}
