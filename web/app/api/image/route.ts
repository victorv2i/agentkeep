import { readVaultImage } from '@/lib/vault'

// Vault images can change out of band (the agent or a file-only tool drops a new
// asset). Don't statically cache the route itself; let the browser cache the
// bytes for a short window via the response header below.
export const dynamic = 'force-dynamic'

/**
 * Serve a vault-local image for the editor's live-preview:
 * `GET /api/image?path=<vault-relative path | bare basename>`.
 *
 * The ENTIRE security story lives in `readVaultImage`, which runs every
 * candidate path through the core `Vault.resolveSafe` guard (lexical `..` /
 * absolute rejection PLUS a symlink-aware realpath check against the vault
 * root). This route reads ONLY what that guard returns — it can never serve a
 * file outside the vault, and a rejected/missing/non-image path is a flat 404
 * that leaks no reason. Remote `http(s)` images are loaded by the browser
 * directly and never touch this route.
 */
export async function GET(request: Request): Promise<Response> {
  const raw = new URL(request.url).searchParams.get('path')
  if (raw === null || raw.trim() === '') {
    return new Response('Not found', { status: 404 })
  }
  const img = await readVaultImage(raw)
  if (img === null) return new Response('Not found', { status: 404 })
  return new Response(new Uint8Array(img.bytes), {
    status: 200,
    headers: {
      'Content-Type': img.contentType,
      // Private (single-user self-host) short cache so re-renders don't refetch.
      'Cache-Control': 'private, max-age=60',
      // A vault SVG opened by DIRECT navigation would otherwise render as a
      // document in the app origin and could run embedded <script>. Sandbox it
      // and forbid every sub-resource so this route can never be a stored-XSS
      // vector. As an <img> sub-resource (the editor live-preview) these are
      // inert, so legitimate rendering is unaffected.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
