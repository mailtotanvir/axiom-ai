/**
 * Axiom AI error taxonomy. Every service throws AxiomError (or maps upstream
 * failures into one) so clients receive a stable machine-readable contract.
 */

export type AxiomErrorCode =
  | "AXIOM_UNAUTHENTICATED"
  | "AXIOM_FORBIDDEN_TENANT"
  | "AXIOM_QUOTA_EXCEEDED"
  | "AXIOM_RATE_LIMITED"
  | "AXIOM_VALIDATION_FAILED"
  | "AXIOM_MODEL_NOT_ALLOWED"
  | "AXIOM_UPSTREAM_TIMEOUT"
  | "AXIOM_UPSTREAM_UNAVAILABLE"
  | "AXIOM_ALL_UPSTREAMS_FAILED"
  | "AXIOM_SANDBOX_VIOLATION"
  | "AXIOM_WEBHOOK_SIGNATURE_INVALID"
  | "AXIOM_NOT_FOUND"
  | "AXIOM_CONFLICT"
  | "AXIOM_INTERNAL";

const HTTP_STATUS: Readonly<Record<AxiomErrorCode, number>> = {
  AXIOM_UNAUTHENTICATED: 401,
  AXIOM_FORBIDDEN_TENANT: 403,
  AXIOM_QUOTA_EXCEEDED: 402,
  AXIOM_RATE_LIMITED: 429,
  AXIOM_VALIDATION_FAILED: 400,
  AXIOM_MODEL_NOT_ALLOWED: 403,
  AXIOM_UPSTREAM_TIMEOUT: 504,
  AXIOM_UPSTREAM_UNAVAILABLE: 502,
  AXIOM_ALL_UPSTREAMS_FAILED: 502,
  AXIOM_SANDBOX_VIOLATION: 400,
  AXIOM_WEBHOOK_SIGNATURE_INVALID: 401,
  AXIOM_NOT_FOUND: 404,
  AXIOM_CONFLICT: 409,
  AXIOM_INTERNAL: 500,
};

export interface AxiomErrorBody {
  error: {
    code: AxiomErrorCode;
    message: string;
    details?: unknown;
    retryable: boolean;
  };
}

export interface UpstreamFailureDetail {
  provider: string;
  status?: number;
  reason?: string;
  message?: string;
}

export class AxiomError extends Error {
  readonly code: AxiomErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: AxiomErrorCode,
    message: string,
    options?: { retryable?: boolean; details?: unknown; cause?: unknown },
  ) {
    super(message);
    this.name = "AxiomError";
    this.code = code;
    this.statusCode = HTTP_STATUS[code];
    this.retryable = options?.retryable ?? false;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  toJSON(): AxiomErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }

  static from(error: unknown): AxiomError {
    if (error instanceof AxiomError) {
      return error;
    }
    return new AxiomError("AXIOM_INTERNAL", toMessage(error), {
      cause: error,
      retryable: true,
    });
  }
}

function toMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/* ------------------------------ Factories --------------------------------- */

export const errors = {
  unauthenticated: (message = "Missing or invalid API key.") =>
    new AxiomError("AXIOM_UNAUTHENTICATED", message),

  forbiddenTenant: (message = "Resource is outside the caller's tenant scope.") =>
    new AxiomError("AXIOM_FORBIDDEN_TENANT", message),

  quotaExceeded: (details?: unknown) =>
    new AxiomError("AXIOM_QUOTA_EXCEEDED", "Token or spend quota exhausted for this period.", {
      details,
      retryable: true,
    }),

  rateLimited: (retryAfterSeconds: number) =>
    new AxiomError("AXIOM_RATE_LIMITED", "Too many requests.", {
      details: { retryAfterSeconds },
      retryable: true,
    }),

  validationFailed: (details?: unknown) =>
    new AxiomError("AXIOM_VALIDATION_FAILED", "Request failed schema validation.", { details }),

  modelNotAllowed: (model: string) =>
    new AxiomError("AXIOM_MODEL_NOT_ALLOWED", `Model '${model}' is not enabled for this tenant.`),

  upstreamTimeout: (provider: string) =>
    new AxiomError("AXIOM_UPSTREAM_TIMEOUT", `Upstream provider '${provider}' timed out.`, {
      retryable: true,
      details: { provider },
    }),

  upstreamUnavailable: (provider: string) =>
    new AxiomError("AXIOM_UPSTREAM_UNAVAILABLE", `Upstream provider '${provider}' is unavailable.`, {
      retryable: true,
      details: { provider },
    }),

  allUpstreamsFailed: (attempts: readonly (string | UpstreamFailureDetail)[]) =>
    new AxiomError("AXIOM_ALL_UPSTREAMS_FAILED", "All routed providers failed.", {
      retryable: true,
      details: { attempts },
    }),

  sandboxViolation: (reason: string) =>
    new AxiomError("AXIOM_SANDBOX_VIOLATION", `Tool execution blocked: ${reason}`),

  webhookSignatureInvalid: () =>
    new AxiomError("AXIOM_WEBHOOK_SIGNATURE_INVALID", "Webhook signature verification failed."),

  notFound: (resource: string) =>
    new AxiomError("AXIOM_NOT_FOUND", `${resource} not found.`),

  conflict: (message: string) => new AxiomError("AXIOM_CONFLICT", message),

  internal: (cause?: unknown) =>
    new AxiomError("AXIOM_INTERNAL", "Internal server error.", { cause, retryable: true }),
} as const;
