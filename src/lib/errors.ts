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
