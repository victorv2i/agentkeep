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
