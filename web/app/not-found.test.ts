import { describe, expect, it } from 'vitest'
import NotFound from './not-found'

/** Flatten a React element tree into a list of elements + text nodes. */
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

describe('not-found page', () => {
  const tree = flatten(NotFound())

  it('renders the missing-note copy', () => {
    expect(tree).toContain('This note does not exist yet.')
  })

  it('links back to the vault home', () => {
    const home = tree.find(
      (n): n is { props: { href: string } } =>
        typeof n === 'object' && n !== null && (n as { props?: { href?: unknown } }).props?.href === '/',
    )
    expect(home).toBeTruthy()
  })

  it('shows the section-break ornament', () => {
    const orn = tree.find(
      (n): n is { props: { className: string } } =>
        typeof n === 'object' && n !== null && (n as { props?: { className?: unknown } }).props?.className === 'nf-star',
    )
    expect(orn).toBeTruthy()
  })
})
