export class ConflictError extends Error {
  readonly httpStatus = 409
  constructor(
    readonly path: string,
    readonly expectedHash: string,
    readonly actualHash: string,
  ) {
    super(`Conflict on ${path}: expected ${expectedHash.slice(0, 8)}, found ${actualHash.slice(0, 8)}`)
    this.name = 'ConflictError'
  }
}

export class ValidationError extends Error {
  readonly httpStatus = 400
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export class VaultPathError extends Error {
  readonly httpStatus = 400
  constructor(message: string) {
    super(message)
    this.name = 'VaultPathError'
  }
}

/**
 * The repo is not in a state a mutation can safely commit into: an in-progress
 * merge/rebase/cherry-pick, a detached HEAD, or tracked files OTHER than the one
 * path being intentionally mutated are dirty. Thrown by `VaultGit`'s preflight,
 * checked immediately before every `commitChange`/`removePath` — not just once
 * at `openVault` — so a vault that becomes unsafe AFTER startup is never written
 * into. `code` distinguishes the reason for callers that want to react
 * differently (e.g. the MCP layer surfacing a structured error).
 */
export class GitStateError extends Error {
  readonly httpStatus = 409
  constructor(
    message: string,
    readonly code: 'merge-in-progress' | 'detached-head' | 'dirty-unrelated',
  ) {
    super(message)
    this.name = 'GitStateError'
  }
}
