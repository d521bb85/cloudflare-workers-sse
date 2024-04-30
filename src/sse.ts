import {
  type ExportedHandlerFetchHandler,
  type IncomingRequestCfProperties,
  type Request,
  Response,
} from "@cloudflare/workers-types";

export type SSEFetchHandler<
  Env = unknown,
  CfHostMetadata = unknown,
  TReturn = unknown,
  TNext = unknown,
> = (
  request: Request<CfHostMetadata, IncomingRequestCfProperties<CfHostMetadata>>,
  env: Env,
  ctx: ExecutionContext,
) => AsyncGenerator<SSEEvent, TReturn, TNext>;

export interface SSEEvent {
  id?: string;
  event?: string;
  data: string;
}

export function sse<Env = unknown, CfHostMetadata = unknown>(
  sseHandler: SSEFetchHandler<Env, CfHostMetadata>,
): ExportedHandlerFetchHandler<Env, CfHostMetadata> {
  return async function handler(
    request: Request<
      CfHostMetadata,
      IncomingRequestCfProperties<CfHostMetadata>
    >,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const stream = new TransformStream();
    const completed = run(sseHandler, stream.writable, request, env, ctx);
    ctx.waitUntil(completed);
    return createResponse(stream.readable);
  };
}

async function run<Env, CfHostMetadata>(
  sseHandler: SSEFetchHandler<Env, CfHostMetadata>,
  writableStream: WritableStream,
  request: Request<CfHostMetadata, IncomingRequestCfProperties<CfHostMetadata>>,
  env: Env,
  ctx: ExecutionContext,
) {
  const writer = writableStream.getWriter();
  try {
    for await (const event of sseHandler(request, env, ctx)) {
      writer.write(encodeEvent(event));
    }
  } finally {
    await writer.close();
  }
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
  payload += `data: ${JSON.stringify(event.data)}\n\n`;
  return textEncoder.encode(payload);
}

function createResponse(readableStream: ReadableStream): Response {
  const headers = new Headers();
  headers.append("Content-Type", "text/event-stream");
  headers.append("Cache-Control", "no-cache");
  headers.append("Connection", "keep-alive");
  return new Response(readableStream, {
    headers,
    status: 200,
  });
}
