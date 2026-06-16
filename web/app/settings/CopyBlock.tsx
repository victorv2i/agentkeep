'use client'

import { useCallback, useRef, useState } from 'react'

/**
 * A copy-able code block: monospace content with a
 * Copy button that writes the exact text to the clipboard. Used for the agent
 * config snippets on the Connect page — what's shown is what gets copied, so the
 * `code` prop is the single source of truth (no drift between display and copy).
 */
export function CopyBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1400)
    } catch {
      // Clipboard blocked (insecure context / permissions) — leave the block as
      // is; the text is still selectable by hand.
    }
  }, [code])

  return (
    <div className="codeblock">
      {label ? <span className="codeblock-lbl lbl">{label}</span> : null}
      <button type="button" className="codeblock-copy" onClick={() => void onCopy()}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className="codeblock-pre">
        <code>{code}</code>
      </pre>
    </div>
  )
}
