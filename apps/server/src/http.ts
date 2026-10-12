import type { Context } from "hono";

type RouteAction = (c: Context) => Response | Promise<Response>;
/** Return a response for a feature's known errors, or undefined to use the shared mapping. */
export type RouteErrorResponse = (error: unknown, c: Context) => Response | undefined;

/**
 * Wrap owner routes so feature errors map first, then validation (TypeError) and malformed
 * JSON (SyntaxError) become 400 responses. Anything else reaches the app's error handler.
 */
export function routeHandler(featureError: RouteErrorResponse = () => undefined) {
  return (action: RouteAction) => async (c: Context) => {
    try {
      return await action(c);
    } catch (error) {
      const response = featureError(error, c);
      if (response) return response;
      if (error instanceof TypeError) return c.json({ error: error.message }, 400);
      if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON." }, 400);
      throw error;
    }
  };
}

/** Read a JSON object body. Failures are TypeErrors, which `routeHandler` returns as 400. */
export async function readJsonObject(
  c: Context,
  messages: { contentType: string; shape: string },
): Promise<Record<string, unknown>> {
  if (!c.req.header("Content-Type")?.startsWith("application/json"))
    throw new TypeError(messages.contentType);
  const value: unknown = await c.req.json();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(messages.shape);
  return value as Record<string, unknown>;
}
