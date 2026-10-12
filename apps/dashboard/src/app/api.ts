export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type Api = <T>(path: string, options?: RequestInit) => Promise<T>;

export function createApi(): Api {
  return async <T>(path: string, options: RequestInit = {}): Promise<T> => {
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (options.body) headers.set("Content-Type", "application/json");

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();

    try {
      const response = await fetch(`/api${path}`, {
        ...options,
        headers,
        cache: "no-store",
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const detail =
          body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error
            : undefined;
        throw new ApiError(
          response.status === 401 || response.status === 403
            ? "Private service access was denied. Check that you’re using the configured private dashboard URL."
            : response.status === 409
              ? (detail ?? "A newer version was saved elsewhere. Your draft is still here.")
              : (detail ?? `The request could not be completed (${response.status}). Try again.`),
          response.status,
        );
      }
      // A successful status with an unreadable body may follow a committed write, so report it
      // as an uncertain outcome (status 0) rather than a definitive response.
      if (body === null)
        throw new ApiError("The service returned an unreadable response. Try again.", 0);
      return body as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (options.signal?.aborted) throw error;
      if (controller.signal.aborted) throw new ApiError("The request took too long. Try again.", 0);
      throw new ApiError(
        "Valerie’s service could not be reached. Check the connection and try again.",
        0,
      );
    } finally {
      window.clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
