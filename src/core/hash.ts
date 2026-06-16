import { createHash } from 'node:crypto'

/** sha256 hex of UTF-8 content. The conflict signal (never mtime). */
export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}
