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
  ctx: ExecutionContext,
  /**
   * Aborts when the client disconnects or a heartbeat write fails.
   * Pass this into upstream `fetch` / SDK calls so generation stops promptly.
   */
  signal: AbortSignal
) =>
  | SSEMessageAsyncGenerator
  | Response
  | Promise<SSEMessageAsyncGenerator | Response>;

export type SSEMessageAsyncGenerator = AsyncGenerator<SSEMessage, void, void>;

/**
 * A message to yield from an SSE handler. All fields are optional.
 * Invalid fields throw during serialization; the error goes to `onError`.
 */
export interface SSEMessage {
  /**
   * Written as `id: <value>`. Must not contain CR, LF, or NUL (throws
   * `RangeError`). An empty string is written and resets the client's
   * last event ID.
   */
  id?: string;
  /**
   * Written as `event: <value>`. Must not contain CR or LF (throws
   * `RangeError`).
   */
  event?: string;
  /**
   * Objects and arrays are JSON-stringified; other values use `toString()`.
   * Each line (CR, LF, or CRLF) becomes its own `data:` line. Omitted,
   * `null`, or `undefined` writes an empty `data:` line, so the client still
   * receives an event (unless the message is comment-only).
   * A `bigint` is only supported at the top level, not inside objects.
   */
  data?: null | boolean | number | bigint | string | Jsonifiable;
  /**
   * Client reconnection delay in milliseconds, written as `retry: <value>`.
   * Must be a positive integer (throws `RangeError`).
   */
  retry?: number;
  /**
   * SSE comment, written as one `: <line>` per line.
   * A message with only `comment` (no `data` key, and no `id`, `event`,
   * or `retry`) is comment-only and dispatches no event on the client.
   */
  comment?: string;
}

export interface SSEOptions<Env> {
  /**
   * Custom headers to include in the SSE response.
   *
   * Allows adding extra headers (e.g., CORS, security policies) as needed.
   * Essential SSE headers (`Content-Type`, `Cache-Control`)
   * always take precedence and cannot be overridden.
   */
  customHeaders?: { [K in string]: string };
  /**
   * Optional error handler.
   *
   * Invoked when the generator throws or a message fails to serialize.
   * Can return an SSE message to send to the client before the stream closes.
   * Not called on client disconnect / abort, or when the handler throws
   * before returning a generator (that error propagates out of `fetch`).
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

type RaceWinner =
  | { type: "next"; result: IteratorResult<SSEMessage, void> }
  | { type: "abort" };

/**
 * Creates a fetch handler that returns a streaming response using Server-Sent Events.
 *
 * The response body is a readable stream that transmits SSE messages to the client.
 * The connection remains open until all messages are dispatched and the stream is closed.
 *
 * The handler may instead return a `Response` (for example, for auth failures),
 * which is sent as-is without SSE wrapping.
 *
 * The fourth argument is an `AbortSignal` that aborts on client disconnect or a
 * failed heartbeat write — pass it to upstream fetches so they cancel promptly.
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

    // Combined signal: client abort (request.signal) or library teardown
    // (failed heartbeat / stream stop). Handler should pass this upstream.
    const streamAbort = new AbortController();

    const forwardRequestAbort = () => {
      if (!streamAbort.signal.aborted) {
        streamAbort.abort();
      }
    };

    if (request.signal.aborted) {
      streamAbort.abort();
    } else {
      request.signal.addEventListener("abort", forwardRequestAbort);
    }

    try {
      const result = await sseHandler(request, env, ctx, streamAbort.signal);

      if (result instanceof Response) {
        request.signal.removeEventListener("abort", forwardRequestAbort);
        return result;
      }

      const headers = new Headers(options?.customHeaders);
      headers.set("Content-Type", "text/event-stream");
      headers.set("Cache-Control", "no-cache");

      const stream = createSSEStream();

      void writeMessages(
        stream,
        result,
        onError,
        streamAbort,
        options?.heartbeatIntervalMs
      )
        .catch(() => {
          // writeMessages handles cleanup; this prevents unhandled rejections
        })
        .finally(() => {
          request.signal.removeEventListener("abort", forwardRequestAbort);
        });

      return new Response(stream.readable, { headers });
    } catch (error) {
      request.signal.removeEventListener("abort", forwardRequestAbort);
      throw error;
    }
  };
}

type SSEStream = TransformStream<Uint8Array, Uint8Array>;

function createSSEStream(): SSEStream {
  return new TransformStream<Uint8Array, Uint8Array>();
}

const textEncoder = new TextEncoder();

/** SSE / HTML treats CR, LF, and CRLF as line endings. */
const SSE_LINE_ENDINGS = /\r\n|\r|\n/;

function assertValidSSEField(
  name: "id" | "event",
  value: string
): asserts value is string {
  if (name === "id" && value.includes("\0")) {
    throw new RangeError("The id field must not contain NUL (\\0).");
  }

  if (/[\r\n]/.test(value)) {
    throw new RangeError(
      `The ${name} field must not contain CR or LF characters.`
    );
  }
}

function serializeMessage(message: SSEMessage) {
  let serialized = "";

  if (message.comment !== undefined) {
    for (const line of message.comment.split(SSE_LINE_ENDINGS)) {
      serialized += `${line === "" ? ":" : `: ${line}`}\n`;
    }
  }

  if (message.id !== undefined) {
    assertValidSSEField("id", message.id);
    serialized += `id: ${message.id}\n`;
  }

  if (message.event !== undefined) {
    assertValidSSEField("event", message.event);
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
    message.id === undefined &&
    message.event === undefined &&
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

      if (typeof stringifiedData !== "string") {
        throw new TypeError(
          "message.data JSON serialization produced a non-string value."
        );
      }

      serialized += stringifiedData
        .split(SSE_LINE_ENDINGS)
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
 * Private marker for consumer-side write failures.
 * Do not treat arbitrary AbortError (e.g. upstream timeout) as disconnect —
 * those must reach onError so the client is not left with a silent cutoff.
 */
class StreamWriteError extends Error {
  constructor() {
    super("SSE stream write failed.");
    this.name = "StreamWriteError";
  }
}

/**
 * Disconnect is identified by hard signals only — never by error name/message.
 * Write failures throw StreamWriteError; client/heartbeat abort sets signal.aborted.
 */
function isDisconnectError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    return true;
  }

  return error instanceof StreamWriteError;
}

async function writeMessages(
  stream: SSEStream,
  generator: SSEMessageAsyncGenerator,
  onError: BoundOnErrorFunction,
  streamAbort: AbortController,
  heartbeatIntervalMs?: number
) {
  const signal = streamAbort.signal;
  const writer = stream.writable.getWriter();
  let heartbeatId: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let stopped = false;
  let writeQueue: Promise<void> = Promise.resolve();
  // Overwritten each iteration — never retains handlers on a long-lived promise.
  let wakeOnAbort: (() => void) | undefined;

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

  /**
   * Begin teardown without awaiting generator.return().
   * On an async generator, return() waits behind a pending next() — awaiting
   * it here would hang the stream until that next() settles (e.g. upstream fetch).
   * Aborting streamAbort lets handler code cancel that fetch via `signal`.
   */
  const requestStop = () => {
    if (stopped) {
      return;
    }

    stopped = true;
    clearHeartbeat();
    wakeOnAbort?.();
    wakeOnAbort = undefined;
    void stopGenerator();

    if (!signal.aborted) {
      streamAbort.abort();
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
        // writable, network drop). Private class — not a generic AbortError.
        throw new StreamWriteError();
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
        // Same path as client abort: wake the loop, start return(), abort signal.
        requestStop();
      });
    }, heartbeatIntervalMs);
  }

  signal.addEventListener("abort", requestStop);

  try {
    if (signal.aborted) {
      await stopGenerator();
      return;
    }

    // Manual iteration (not for-await) so abort can win against a pending
    // generator.next() without Promise.race retaining handlers on abortRace.
    while (true) {
      const nextPromise = generator.next();

      const winner = await new Promise<RaceWinner>((resolve, reject) => {
        wakeOnAbort = () => resolve({ type: "abort" });

        nextPromise.then((result) => resolve({ type: "next", result }), reject);

        // Abort may have landed between next() and assigning wakeOnAbort.
        if (signal.aborted) {
          resolve({ type: "abort" });
        }
      });

      wakeOnAbort = undefined;

      if (winner.type === "abort") {
        // next() may still settle later; prevent unhandled rejections.
        // Do not await stopGenerator(): return() waits behind pending next(),
        // and requestStop already started a non-awaited return().
        void nextPromise.then(
          () => {},
          () => {}
        );
        return;
      }

      if (winner.result.done) {
        break;
      }

      if (signal.aborted) {
        // next() already settled; safe to await cleanup
        await stopGenerator();
        break;
      }

      await writeSerialized(winner.result.value);
    }
  } catch (error) {
    if (isDisconnectError(error, signal)) {
      // Write-side disconnect (no enable_request_signal / no heartbeat):
      // abort handler signal so parallel upstream work can cancel, then clean up.
      requestStop();
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

    // Generator is paused at yield (or already errored); resume finally blocks
    // so upstream fetches / readers are released.
    await stopGenerator();
  } finally {
    signal.removeEventListener("abort", requestStop);
    clearHeartbeat();
    await writeQueue.catch(() => {});
    await closeWriter();
  }
}
