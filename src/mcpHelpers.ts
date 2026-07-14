/**
 * mcpHelpers — shared utilities for tool error boundaries and DX.
 *
 * These helpers are deliberately generic so every tool handler in index.ts
 * can use them consistently without importing anything MCP-specific at the
 * handler level.
 */

import type { ZodError } from "zod";

/**
 * Wraps an async tool handler so that any thrown exception is caught and
 * returned as a sanitized error result (no stack traces, no internal paths,
 * no environment details).
 *
 * Usage:
 * ```ts
 * server.registerTool("tool_name", schema, withSanitizedErrors(async (args) => {
 *   // … handler logic …
 * }));
 * ```
 */
export function withSanitizedErrors<TArgs, TReturn extends { content: unknown[]; isError?: boolean }>(
  handler: (args: TArgs) => Promise<TReturn>,
): (args: TArgs) => Promise<TReturn> {
  return async (args: TArgs): Promise<TReturn> => {
    try {
      return await handler(args);
    } catch (error) {
      const message = sanitizeError(error);
      // Cast is safe — every tool handler returns this shape.
      return {
        isError: true,
        content: [{ type: "text" as const, text: message }],
      } as TReturn;
    }
  };
}

/**
 * Converts a ZodError into a clean, human-readable list of field issues
 * instead of dumping the raw JSON tree.
 */
export function formatZodIssues(error: ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `  - ${path}: ${issue.message}`;
  });
  return `Validation failed (${error.issues.length} issue(s)):\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Produces a safe, user-facing error message from an unknown thrown value.
 * Never includes stack traces, file paths, process.env keys, or host details.
 */
function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    // Only include the message — never the stack or any nested details.
    return error.message || "An unexpected error occurred.";
  }
  if (typeof error === "string") {
    // Truncate excessively long string errors.
    return error.length > 200 ? error.slice(0, 200) + "…" : error;
  }
  return "An unexpected error occurred.";
}
