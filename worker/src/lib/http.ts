import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

/** Stops the request with a JSON error body: `{ "error": code, ...extra }`. */
export function fail(
  status: ContentfulStatusCode,
  error: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): never {
  throw new HTTPException(status, {
    res: new Response(JSON.stringify({ error, ...extra }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...headers },
    }),
  });
}

/** Reads at most `maxBytes` of the request body as text. */
async function readLimited(c: Context, maxBytes: number): Promise<string> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > maxBytes) fail(413, "payload_too_large", { max_bytes: maxBytes });
  const body = c.req.raw.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      fail(413, "payload_too_large", { max_bytes: maxBytes });
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Parses a JSON request body against a schema, failing with 400 and the problems found. */
export async function readJson<T extends z.ZodType>(
  c: Context,
  schema: T,
  maxBytes = 16 * 1024,
): Promise<z.infer<T>> {
  const type = c.req.header("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    fail(415, "unsupported_media_type", { expected: "application/json" });
  }
  const text = await readLimited(c, maxBytes);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    fail(400, "invalid_json");
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    fail(400, "invalid_request", {
      issues: result.error.issues.slice(0, 20).map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return result.data;
}
