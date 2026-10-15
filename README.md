# cloudflare-workers-sse

Server-Sent Events for Cloudflare Workers. Write an async generator, and every
message it yields is streamed to the client.

Works with any token source: Workers AI, AI Gateway, OpenAI-compatible APIs,
Anthropic, or your own backend.

- Drop-in `fetch` handler
- Return a plain `Response` to reject a request before the stream opens
- Cancellation `signal`, heartbeats, custom headers, and an error callback
- Output follows the [SSE specification](https://html.spec.whatwg.org/multipage/server-sent-events.html)

## Installation

```bash
npm install cloudflare-workers-sse
```

To detect client disconnects promptly, enable this compatibility flag in your
Wrangler config (see [Cancellation](#cancellation)):

```toml
compatibility_flags = ["enable_request_signal"]
```

## Quick start

```typescript
import { sse } from "cloudflare-workers-sse";

export default {
  fetch: sse(handler),
};

async function* handler() {
  yield { event: "greeting", data: { text: "Hi there!" } };
}
```

The client receives:

```text
event: greeting
data: {"text":"Hi there!"}

```

When the generator returns, the stream closes.

The handler is called with `(request, env, ctx, signal)`. Declare only the
parameters you use.

### Reject a request before streaming

Make the handler a plain `async` function. Return a `Response` to send it
as-is, or return a generator to start streaming:

```typescript
async function handler(request: Request) {
  if (!isAuthorized(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  return (async function* () {
    yield { event: "greeting", data: { text: "Hi there!" } };
  })();
}
```

## Stream an LLM

### OpenAI-compatible APIs

Pass `signal` to the SDK so the upstream request is cancelled when the client
goes away:

```typescript
import OpenAI from "openai";
import { sse } from "cloudflare-workers-sse";

export default {
  fetch: sse(
    (_request: Request, env: Env, _ctx: ExecutionContext, signal: AbortSignal) =>
      streamCompletion(env, signal),
    { heartbeatIntervalMs: 15_000 }
  ),
};

async function* streamCompletion(env: Env, signal: AbortSignal) {
  const openai = new OpenAI({
    apiKey: env.AI_GATEWAY_TOKEN,
    baseURL: `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${env.GATEWAY_ID}/compat`,
  });

  const stream = await openai.chat.completions.create(
    {
      model: "workers-ai/@cf/meta/llama-3.1-8b-instruct",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    },
    { signal }
  );

  for await (const part of stream) {
    const text = part.choices[0]?.delta?.content;
    if (text) {
      yield { event: "token", data: text };
    }
  }

  yield { event: "done" };
}
```

### Workers AI binding

With `stream: true`, `env.AI.run` returns a `ReadableStream` of raw SSE bytes,
not parsed chunks. Parse it (here with
[`eventsource-parser`](https://github.com/rexxars/eventsource-parser)) and
re-emit the tokens as your own events:

```typescript
import { EventSourceParserStream } from "eventsource-parser/stream";
import { sse } from "cloudflare-workers-sse";

export default {
  fetch: sse(handler, {
    heartbeatIntervalMs: 15_000,
    onError: () => ({ event: "error", data: { message: "generation failed" } }),
  }),
};

async function handler(request: Request, env: Env) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const { prompt } = await request.json<{ prompt: string }>();

  return (async function* () {
    const stream = (await env.AI.run(
      "@cf/meta/llama-3.1-8b-instruct",
      { messages: [{ role: "user", content: prompt }], stream: true },
      { gateway: { id: "my-gateway" } }
    )) as ReadableStream<Uint8Array>;

    const events = stream
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream());

    for await (const { data } of events) {
      if (data === "[DONE]") {
        break;
      }

      const { response } = JSON.parse(data) as { response?: string };
      if (response) {
        yield { event: "token", data: response };
      }
    }

    yield { event: "done" };
  })();
}
```

If you only need to pass Workers AI output through unchanged, return its stream
directly in a `Response`; you don't need this library. Use it when you want
your own protocol: custom events, auth checks, heartbeats, or shaped errors.

### Client

Browser `EventSource` supports only `GET` requests without custom headers. For
`POST` or auth headers, use a fetch-based client such as
[`@microsoft/fetch-event-source`](https://github.com/Azure/fetch-event-source):

```typescript
import { fetchEventSource } from "@microsoft/fetch-event-source";

let text = "";

await fetchEventSource("https://<YOUR_WORKER>.workers.dev", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "Hello" }),
  onmessage(event) {
    if (event.event === "token") {
      text += event.data; // string data arrives unchanged
    }
  },
});
```

## Messages

Each yielded value is an `SSEMessage`. All fields are optional.

| Field | Type | Written as |
| --- | --- | --- |
| `data` | string, number, boolean, bigint, `null`, or a JSON-serializable value | Objects and arrays: `JSON.stringify`. Other values: `String(value)`. Text is split into one `data:` line per line (CR, LF, or CRLF). Omitted, `null`, or `undefined`: an empty `data:` line, so the client still receives an event. |
| `event` | string | `event: <value>`. Must not contain CR or LF. |
| `id` | string | `id: <value>`. Must not contain CR, LF, or NUL. `""` is written and resets the client's last event ID. |
| `retry` | number | `retry: <value>`. Must be a positive integer (milliseconds). |
| `comment` | string | One `: <line>` per line. A message with only `comment` (no `data` key, no `id`, `event`, or `retry`) is comment-only and dispatches no event on the client. |

A message that breaks a rule above throws (`RangeError` or `TypeError`). The
error goes to [`onError`](#errors) and the stream closes.

`bigint` works only as top-level `data`. Inside an object, `JSON.stringify`
throws.

## Lifecycle

1. The handler runs. If it throws here, the error propagates out of `fetch`
   (the Workers runtime responds with a 500) and `onError` is **not** called.
2. If it returns a `Response`, that response is sent as-is.
3. If it returns a generator, the response starts immediately with
   `Content-Type: text/event-stream` and `Cache-Control: no-cache`, and each
   yielded message is written in order.
4. **Generator returns:** the stream closes.
5. **Generator throws, or a message fails to serialize:** `onError` is called.
   If it returns a message, that message is written. Then the generator is
   closed (its `finally` blocks run) and the stream closes.
6. **Client disconnects:** `signal` aborts, the generator is closed, and the
   stream closes. `onError` is not called.

Put cleanup (closing readers, releasing locks) in the generator's `finally`
block. It runs in every case above.

## Cancellation

The handler's fourth argument, `signal`, aborts when any of these happen:

- the client disconnects (requires the `enable_request_signal` compatibility
  flag);
- a write to the stream fails;
- a heartbeat write fails.

```typescript
async function* handler(
  _request: Request,
  _env: Env,
  _ctx: ExecutionContext,
  signal: AbortSignal
) {
  const upstream = await fetch("https://api.example.com/stream", { signal });
  // ...
}
```

Always pass `signal` to upstream requests. Closing the generator alone can't
interrupt an `await` that is already pending; the generator's `finally` only
runs once that `await` settles. Aborting `signal` cancels the upstream request
right away.

You don't need to check `signal.aborted` inside your loop. The library closes
the generator at the next `yield`.

Without the compatibility flag, a disconnect is detected only when a write
fails, which is either the next message or the next heartbeat. To detect it
sooner during long silences, set `heartbeatIntervalMs`.

## Options

`sse(handler, options?)` returns a `fetch` handler.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `onError` | `(error, request, env, ctx) => SSEMessage \| undefined` (may be async) | none | Called when the generator throws or a message fails to serialize. A returned message is written before the stream closes. Not called on disconnect, or if the handler throws before returning a generator. |
| `heartbeatIntervalMs` | `number` | off | Writes a comment-only keepalive (`:\n\n`) at this interval while the stream is open. Ignored unless positive. |
| `customHeaders` | `Record<string, string>` | none | Extra response headers. `Content-Type` and `Cache-Control` can't be overridden. |

### Errors

```typescript
export default {
  fetch: sse(handler, {
    onError: (error) => {
      console.error(error);
      return { event: "error", data: { message: "generation failed" } };
    },
  }),
};
```

If `onError` throws, or its message fails to serialize, the stream closes
without calling it again.

### Heartbeats

```typescript
export default {
  fetch: sse(handler, { heartbeatIntervalMs: 15_000 }),
};
```

Heartbeats keep idle connections open through proxies, and a failed heartbeat
write aborts `signal` (see [Cancellation](#cancellation)).

### Custom headers

```typescript
export default {
  fetch: sse(handler, {
    customHeaders: { "Access-Control-Allow-Origin": "https://example.com" },
  }),
};
```

## Middleware

`sse()` returns a standard `FetchHandler`, so you can wrap it. This example
answers CORS preflight requests before the SSE handler runs:

```typescript
import { type FetchHandler, sse } from "cloudflare-workers-sse";

export default {
  fetch: withCors(sse(handler)),
};

function withCors<Env>(next: FetchHandler<Env>): FetchHandler<Env> {
  return async (request, env, ctx) => {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "https://example.com",
          "Access-Control-Allow-Methods": "GET, POST",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    return next(request, env, ctx);
  };
}
```

Don't read the response body in middleware; it is a live stream.

## API

The package exports `sse` and these types:

| Export | Description |
| --- | --- |
| `sse(handler, options?)` | Wraps an `SSEHandler` and returns a `FetchHandler`. |
| `SSEHandler<Env>` | `(request, env, ctx, signal) => generator \| Response`, sync or async. |
| `SSEMessage` | A message to yield. See [Messages](#messages). |
| `SSEMessageAsyncGenerator` | `AsyncGenerator<SSEMessage, void, void>` |
| `SSEOptions<Env>` | See [Options](#options). |
| `OnErrorFunction<Env>` | Type of `onError`. |
| `FetchHandler<Env>` | `(request, env, ctx) => Response \| Promise<Response>` |
| `Jsonifiable` | JSON-serializable values accepted as `data`. |

## License

MIT
