/** A business-rule failure with a plain-language message (PRD CT-3: always explain). */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 422,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
export const notFound = (what: string) => new DomainError('not_found', `${what} was not found.`, 404);
export const forbidden = (msg = 'You do not have permission to do this.') => new DomainError('forbidden', msg, 403);
export const conflict = (code: string, msg: string, details?: unknown) => new DomainError(code, msg, 409, details);
export const invalid = (msg: string, details?: unknown) => new DomainError('invalid', msg, 400, details);
