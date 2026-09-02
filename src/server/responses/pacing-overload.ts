import { formatErrorResponse } from "../../bridge";
import { RequestPacingProviderRemovedError, RequestPacingQueueOverloadError } from "../../providers/request-pacing";

/** Convert local request-pacing admission failures into a retryable HTTP response. */
export function requestPacingOverloadResponse(error: unknown): Response | undefined {
  if (error instanceof RequestPacingQueueOverloadError) {
    return formatErrorResponse(
      429,
      "rate_limit_error",
      error.message,
      { retryAfter: String(error.retryAfterSeconds) },
    );
  }
  if (error instanceof RequestPacingProviderRemovedError) {
    return formatErrorResponse(
      503,
      "server_error",
      "request pacing provider became unavailable during dispatch",
      { code: "provider_unavailable" },
    );
  }
  return undefined;
}
