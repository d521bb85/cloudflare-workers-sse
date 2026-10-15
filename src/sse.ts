/**
 * A JSON-serializable value (objects, arrays, and primitives).
 * Objects with a `toJSON` method are also accepted.
 */
export type Jsonifiable =
  | string
  | number
  | boolean
  | null
  | Jsonifiable[]
  | { [key: string]: Jsonifiable }
  | { toJSON(): Jsonifiable };

export type SSEHandler<Env> = (
  request: Request,
  env: Env,
  ctx: ExecutionContext
) =>
  | SSEMessageAsyncGenerator
  | Response
  | Promise<SSEMessageAsyncGenerator | Response>;

export type SSEMessageAsyncGenerator = AsyncGenerator<SSEMessage, void, void>;

export interface SSEMessage {
  id?: string;
  event?: string;
  data?: null | boolean | number | bigint | string | Jsonifiable;
  retry?: number;
  /**
   * Optional SSE comment. Serialized as line(s) starting with `:`.
   * When used alone, produces a comment-only message (useful for keepalives).
   */
  comment?: string;
}

export interface SSEOptions<Env> {
  /**
   * Custom headers to include in the SSE response.
   *
   * Allows adding extra headers (e.g., CORS, security policies) as needed.
   * Essential SSE headers (`Content-Type`, `Cache-Control`, `Connection`)
   * always take precedence and cannot be overridden.
   */
  customHeaders?: { [K in string]: string };
  /**
   * Optional error handler.
   *
   * Invoked when an error occurs during streaming.
   * Can return an SSE message to send to the client.
   * Not called on client disconnect / abort.
   */
  onError?: OnErrorFunction<Env>;
  /**
   * When set to a positive number, periodically writes an SSE comment
   * (`:\n\n`) to keep the connection alive while the stream is open.
   */
  heartbeatIntervalMs?: number;
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

type BoundOnErrorFunction = (
  error: unknown
) => ReturnType<OnErrorFunction<unknown>>;

/**
 * Creates a fetch handler that returns a streaming response using Server-Sent Events.
 *
 * The response body is a readable stream that transmits SSE messages to the client.
 * The connection remains open until all messages are dispatched and the stream is closed.
 *
 * The handler may instead return a `Response` (for example, for auth failures),
 * which is sent as-is without SSE wrapping.
 */
export function sse<Env>(
  sseHandler: SSEHandler<Env>,
  options?: SSEOptions<Env>
): FetchHandler<Env> {
  return async function fetchHandler(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ) {
    const onError = (error: unknown) =>
      options?.onError?.(error, request, env, ctx);

    const result = await sseHandler(request, env, ctx);

    if (result instanceof Response) {
      return result;
    }

    const headers = new Headers(options?.customHeaders);
    headers.set("Content-Type", "text/event-stream");
    headers.set("Cache-Control", "no-cache");
    headers.set("Connection", "keep-alive");

    const stream = createSSEStream();

    void writeMessages(
      stream,
      result,
      onError,
      request.signal,
      options?.heartbeatIntervalMs
    ).catch(() => {
      // writeMessages handles cleanup; this prevents unhandled rejections
    });

    return new Response(stream.readable, { headers });
  };
}

type SSEStream = TransformStream<Uint8Array, Uint8Array>;

function createSSEStream(): SSEStream {
  return new TransformStream<Uint8Array, Uint8Array>();
}

const textEncoder = new TextEncoder();

function serializeMessage(message: SSEMessage) {
  let serialized = "";

  if (message.comment !== undefined) {
    for (const line of message.comment.split("\n")) {
      serialized += `${line === "" ? ":" : `: ${line}`}\n`;
    }
  }

  if (message.id) {
    serialized += `id: ${message.id}\n`;
  }

  if (message.event) {
    serialized += `event: ${message.event}\n`;
  }

  if (message.retry !== undefined) {
    if (!Number.isInteger(message.retry) || message.retry <= 0) {
      throw new RangeError("The retry is expected to be a positive integer.");
    }

    serialized += `retry: ${message.retry}\n`;
  }

  const isCommentOnly =
    message.comment !== undefined &&
    !message.id &&
    !message.event &&
    message.retry === undefined &&
    !("data" in message);

  if (!isCommentOnly) {
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
  } else {
    // comment lines already end with \n; one more blank line ends the message
    serialized += "\n";
  }

  return textEncoder.encode(serialized);
}

/**
 * Disconnect is identified by hard signals only — never by error message text.
 * Stream write failures are normalized to AbortError in writeSerialized.
 */
function isDisconnectError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    return true;
  }

  return error instanceof Error && error.name === "AbortError";
}

function toAbortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

async function writeMessages(
  stream: SSEStream,
  generator: SSEMessageAsyncGenerator,
  onError: BoundOnErrorFunction,
  signal: AbortSignal,
  heartbeatIntervalMs?: number
) {
  const writer = stream.writable.getWriter();
  let heartbeatId: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let writeQueue: Promise<void> = Promise.resolve();
  let resolveAbort: (() => void) | undefined;
  const abortBarrier = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });

  const closeWriter = async () => {
    if (closed) {
      return;
    }

    closed = true;

    try {
      await writer.close();
    } catch {
      // stream may already be closed or errored (e.g. client disconnect)
    }
  };

  const stopGenerator = async () => {
    try {
      await generator.return?.(undefined);
    } catch {
      // ignore generator cleanup errors
    }
  };

  const clearHeartbeat = () => {
    if (heartbeatId !== undefined) {
      clearInterval(heartbeatId);
      heartbeatId = undefined;
    }
  };

  const writeSerialized = (message: SSEMessage) => {
    // Serialization errors reject synchronously so callers can invoke onError.
    const bytes = serializeMessage(message);

    const next = writeQueue.then(async () => {
      if (closed || signal.aborted) {
        return;
      }

      try {
        await writer.write(bytes);
      } catch {
        // Any write failure means the consumer side is gone (cancel, closed
        // writable, network drop). Classify by source, not message text.
        throw toAbortError();
      }
    });

    // Keep the queue usable after a failed write, but return `next` so the
    // caller still observes the rejection (no double onError / no swallow).
    writeQueue = next.catch(() => {});

    return next;
  };

  if (
    heartbeatIntervalMs !== undefined &&
    heartbeatIntervalMs > 0 &&
    !signal.aborted
  ) {
    heartbeatId = setInterval(() => {
      void writeSerialized({ comment: "" }).catch(() => {
        clearHeartbeat();
      });
    }, heartbeatIntervalMs);
  }

  const onAbort = () => {
    clearHeartbeat();
    resolveAbort?.();
    void stopGenerator();
  };

  signal.addEventListener("abort", onAbort);

  try {
    if (signal.aborted) {
      await stopGenerator();
      return;
    }

    // Manual iteration (not for-await) so abort can win a race against a
    // pending generator.next() — return() alone only queues behind it.
    while (true) {
      const nextPromise = generator.next();

      const winner = await Promise.race([
        nextPromise.then((result) => ({ type: "next" as const, result })),
        abortBarrier.then(() => ({ type: "abort" as const }))
      ]);

      if (winner.type === "abort") {
        // next() may still settle later; prevent unhandled rejections
        void nextPromise.then(
          () => {},
          () => {}
        );
        await stopGenerator();
        return;
      }

      if (winner.result.done) {
        break;
      }

      if (signal.aborted) {
        await stopGenerator();
        break;
      }

      await writeSerialized(winner.result.value);
    }
  } catch (error) {
    if (isDisconnectError(error, signal)) {
      await stopGenerator();
      return;
    }

    try {
      const errorMessage = await onError(error);

      if (errorMessage) {
        try {
          await writeSerialized(errorMessage);
        } catch {
          // do not recursively invoke onError if the error message fails to serialize
        }
      }
    } catch {
      // onError itself threw — close without further callbacks
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    clearHeartbeat();
    await writeQueue.catch(() => {});
    await closeWriter();
  }
}
