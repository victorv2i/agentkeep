import { describe, expect, it, vi } from 'vitest'
import { SaveBadge } from './NotesClient'

function flatten(node: unknown, out: unknown[] = []): unknown[] {
  if (node == null || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  out.push(node)
  if (typeof node === 'object' && node !== null && 'props' in node) {
    const props = (node as { props: { children?: unknown } }).props
    if (props && props.children !== undefined) flatten(props.children, out)
  }
  return out
}

describe('SaveBadge conflict actions', () => {
  it('keeps conflict status separate from explicit discard and copy actions', () => {
    const onLoadDisk = vi.fn()
    const onCopyDraft = vi.fn()
    const tree = flatten(
      SaveBadge({
        state: 'conflict',
        onLoadDisk,
        onCopyDraft,
        onRetry: vi.fn(),
      }),
    )

    expect(tree).toContain('Changed elsewhere')
    expect(tree).toContain('Copy my draft')
    expect(tree).toContain('Load disk')

    const buttons = tree.filter(
      (n): n is { props: { type?: string; onClick?: () => void; children?: unknown } } =>
        typeof n === 'object' &&
        n !== null &&
        (n as { props?: { type?: unknown } }).props?.type === 'button',
    )
    expect(buttons).toHaveLength(2)

    buttons.find((b) => b.props.children === 'Copy my draft')?.props.onClick?.()
    expect(onCopyDraft).toHaveBeenCalledTimes(1)
    expect(onLoadDisk).not.toHaveBeenCalled()

    buttons.find((b) => b.props.children === 'Load disk')?.props.onClick?.()
    expect(onLoadDisk).toHaveBeenCalledTimes(1)
  })
})
