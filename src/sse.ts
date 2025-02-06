import type { Jsonifiable } from "type-fest";

export type SSEHandler<Env> = (
  request: Request,
  env: Env,
  ctx: ExecutionContext
) => SSEMessageAsyncGenerator;

export type SSEMessageAsyncGenerator = AsyncGenerator<SSEMessage, void, void>;

export interface SSEMessage {
  id?: string;
  event?: string;
  data?: null | boolean | number | bigint | string | Jsonifiable;
}

export interface SSEOptions<Env> {
  /**
   * Custom headers to include in the SSE response.
   *
   * Allows adding extra headers (e.g., CORS, security policies) as needed.
   */
  customHeaders?: { [K in string]: string };
  /**
   * Optional error handler.
   *
   * Invoked when an error occurs during streaming.
   * Can return an SSE message to send to the client.
   */
  onError?: OnErrorFunction<Env>;
}

export type OnErrorFunction<Env> = (
  error: unknown,
  request: Request,
  env: Env,
  ctx: ExecutionContext
) => SSEMessage | undefined | Promise<SSEMessage | undefined>;

export type FetchHandler<Env> = (
  request: Request,
  env: Env,
  ctx: ExecutionContext
) => Response | Promise<Response>;

/**
 * Creates a fetch handler that returns a streaming response using Server-Sent Events.
 *
 * The response body is a readable stream that transmits SSE messages to the client.
 * The connection remains open until all messages are dispatched and the stream is closed.
 */
export function sse<Env>(
  sseHandler: SSEHandler<Env>,
  options?: SSEOptions<Env>
): FetchHandler<Env> {
  return function fetchHandler(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ) {
    const onError = (error: unknown) =>
      options?.onError?.(error, request, env, ctx);

    const stream = createSSEStream();
    writeMessages(stream, sseHandler(request, env, ctx), onError);

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...(options?.customHeaders ?? {})
      }
    });
  };
}

type SSEStream = TransformStream<SSEMessage, Uint8Array>;

function createSSEStream(): SSEStream {
  const textEncoder = new TextEncoder();

  return new TransformStream<SSEMessage, Uint8Array>({
    transform(message, controller) {
      let serialized = "";

      if (message.id) {
        serialized += `id: ${message.id}\n`;
      }

      if (message.event) {
        serialized += `event: ${message.event}\n`;
      }

      if (message.data === null || message.data === undefined) {
        serialized += "data:";
      } else {
        const stringifiedData =
          typeof message.data === "object"
            ? JSON.stringify(message.data)
            : message.data.toString();

        serialized += stringifiedData
          .split("\n")
          .map((line) => `data: ${line}`)
          .join("\n");
      }

      serialized += "\n\n";

      controller.enqueue(textEncoder.encode(serialized));
    }
  });
}

async function writeMessages(
  stream: SSEStream,
  generator: SSEMessageAsyncGenerator,
  onError: (error: unknown) => ReturnType<OnErrorFunction<unknown>>
) {
  const writer = stream.writable.getWriter();

  try {
    for await (const message of generator) {
      await writer.write(message);
    }
  } catch (error) {
    const errorMessage = await onError(error);
    if (errorMessage) {
      await writer.write(errorMessage);
    }
  } finally {
    await writer.close();
  }
}
