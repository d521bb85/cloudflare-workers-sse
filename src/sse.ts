import type {
  ExportedHandlerFetchHandler,
  IncomingRequestCfProperties,
  Request,
} from "@cloudflare/workers-types";
import type { JsonValue } from "type-fest";

export type SSEHandler<Env = unknown, CfHostMetadata = unknown> = (
  request: Request<CfHostMetadata, IncomingRequestCfProperties<CfHostMetadata>>,
  env: Env,
  ctx: ExecutionContext,
) => AsyncGenerator<SSEEvent, void, void>;

export interface SSEEvent {
  id?: string;
  event?: string;
  data?: JsonValue;
}

export interface SSEOptions {
  customHeaders?: { [K in string]: string };
}

export function sse<Env = unknown, CfHostMetadata = unknown>(
  sseHandler: SSEHandler<Env, CfHostMetadata>,
  options?: SSEOptions,
): ExportedHandlerFetchHandler<Env, CfHostMetadata> {
  const stream = new TransformStream();

  async function run(
    request: Request<
      CfHostMetadata,
      IncomingRequestCfProperties<CfHostMetadata>
    >,
    env: Env,
    ctx: ExecutionContext,
  ) {
    const writer = stream.writable.getWriter();
    try {
      for await (const event of sseHandler(request, env, ctx)) {
        await writer.write(encodeEvent(event));
      }
    } finally {
      await writer.close();
    }
  }

  /*
    The fetch handler is synchronous and returns a response with a stream as its body.
    The run function, which is called within, runs the given sseHandler generator and writes the events it produces to the stream.
    Calling ctx.waitUntil ensures that execution won't terminate until the generator is exhausted.
  */
  return async function fetchHandler(
    request: Request<
      CfHostMetadata,
      IncomingRequestCfProperties<CfHostMetadata>
    >,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    ctx.waitUntil(run(request, env, ctx));
    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...(options?.customHeaders ?? {}),
      },
    });
  };
}

const textEncoder = new TextEncoder();

function encodeEvent(event: SSEEvent): Uint8Array {
  let payload = "";
  if (event.id) {
    payload = `id: ${event.id}\n`;
  }
  if (event.event) {
    payload += `event: ${event.event}\n`;
  }
  payload += `data: ${JSON.stringify(event.data ?? null)}\n\n`;
  return textEncoder.encode(payload);
}
