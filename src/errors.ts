export type ExecutionPhase =
  | "before-submit"
  | "post-submit-ambiguous"
  | "authentication"
  | "conversation"
  | "invalid-completion"
  | "skip";

export type ErrorCategory =
  | "pre-submit-technical"
  | "authentication"
  | "conversation"
  | "post-submit-ambiguous"
  | "invalid-completion"
  | "skip";

export class WorkerError extends Error {
  constructor(
    message: string,
    readonly phase: ExecutionPhase,
    readonly category: ErrorCategory,
  ) {
    super(message);
    this.name = "WorkerError";
  }
}

export class SkipError extends WorkerError {
  constructor(message: string) {
    super(message, "skip", "skip");
    this.name = "SkipError";
  }
}

export class AuthenticationError extends WorkerError {
  constructor(message: string) {
    super(message, "authentication", "authentication");
    this.name = "AuthenticationError";
  }
}

export class ConversationError extends WorkerError {
  constructor(message: string) {
    super(message, "conversation", "conversation");
    this.name = "ConversationError";
  }
}

export class AmbiguousExecutionError extends WorkerError {
  constructor(message: string) {
    super(message, "post-submit-ambiguous", "post-submit-ambiguous");
    this.name = "AmbiguousExecutionError";
  }
}

export class InvalidCompletionError extends WorkerError {
  constructor(message: string) {
    super(message, "invalid-completion", "invalid-completion");
    this.name = "InvalidCompletionError";
  }
}

/** markRunning wrote to API but read-back did not show Running before submit deadline. */
export class RunningVisibilityError extends WorkerError {
  constructor(message: string) {
    super(message, "before-submit", "pre-submit-technical");
    this.name = "RunningVisibilityError";
  }
}

export function detectExecutionPhase(error: unknown, submitted: boolean): ExecutionPhase {
  if (error instanceof WorkerError) return error.phase;
  if (submitted) return "post-submit-ambiguous";
  return "before-submit";
}

export function errorCategoryFromPhase(phase: ExecutionPhase): ErrorCategory {
  switch (phase) {
    case "authentication":
      return "authentication";
    case "conversation":
      return "conversation";
    case "post-submit-ambiguous":
      return "post-submit-ambiguous";
    case "invalid-completion":
      return "invalid-completion";
    case "skip":
      return "skip";
    default:
      return "pre-submit-technical";
  }
}
