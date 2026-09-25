export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly code: string = "APP_ERROR",
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string) { super(message, 422, "VALIDATION_ERROR"); }
}
/**
 * Update #22 — the Weekly Availability prerequisite for Suguan generation.
 * A well-formed generation request that violates the business rule (weekly
 * availability not encoded for the selected ISO week) answers 422 with a CODE
 * the UI keys on to render the "Weekly Availability Required" notice (with the
 * Go to Weekly Availability action) instead of a generic error message.
 */
export class AvailabilityRequiredError extends AppError {
  constructor(message: string) { super(message, 422, "AVAILABILITY_REQUIRED"); }
}
/**
 * Caller error for a missing or malformed request parameter (query or path).
 *
 * Distinct from ValidationError (422), which is used for a well-formed request
 * that violates a business rule. A parameter the caller got wrong — or did not
 * send — is a 400: the request itself is not a valid question.
 */
export class BadRequestError extends AppError {
  constructor(message: string) { super(message, 400, "BAD_REQUEST"); }
}
export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") { super(message, 401, "UNAUTHORIZED"); }
}
export class ForbiddenError extends AppError {
  constructor(message = "Permission denied") { super(message, 403, "FORBIDDEN"); }
}
export class NotFoundError extends AppError {
  constructor(message = "Not found") { super(message, 404, "NOT_FOUND"); }
}
export class ConflictError extends AppError {
  constructor(message: string) { super(message, 409, "CONFLICT"); }
}
