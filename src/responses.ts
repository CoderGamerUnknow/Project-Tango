/**
 * Success and error envelopes, shared by every tool handler.
 *
 * Extracted from the registration module so that file stays a declarative list
 * of what the server exposes; the wire shape of a response is its own concern.
 */

/**
 * Success response carrying the same payload twice, on purpose.
 *
 * `structuredContent` is what a typed MCP client validates and reads directly,
 * so it never has to re-parse JSON. `content` is retained as compact JSON text
 * for clients and models that consume the text block. Pretty-printing used to
 * cost ~30% of every response in pure whitespace — about 365 tokens per
 * `list_all_products` call — so the text form is unindented.
 */
export function jsonResult<T extends Record<string, unknown>>(payload: T) {
  return {
    structuredContent: payload,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload),
      },
    ],
  };
}

export function errorResult(message: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
}
