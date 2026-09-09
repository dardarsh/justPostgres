import type { ZodError } from "zod";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Errors the API is willing to describe to a client. Anything else becomes a
 * generic 500 with the detail confined to the logs — a control plane that
 * holds every project's superuser credentials should not narrate its internals
 * to whoever is asking.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }

  toBody(): ApiErrorBody {
    return {
      error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) },
    };
  }

  static badRequest(error: ZodError | string, message = "Invalid request"): HttpError {
    if (typeof error === "string") return new HttpError(400, "bad_request", error);
    const details = error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    return new HttpError(400, "bad_request", message, details);
  }

  static notFound(resource: string): HttpError {
    return new HttpError(404, "not_found", `No such ${resource}`);
  }

  static conflict(message: string): HttpError {
    return new HttpError(409, "conflict", message);
  }

  static notImplemented(message: string): HttpError {
    return new HttpError(501, "not_implemented", message);
  }
}
