# cloudflare-workers-sse

Elegant Server-Sent Events (SSE) Streaming for Cloudflare Workers.

- Provides a simple, straightforward, and functional approach to streaming SSE messages using async generators.
- Easily integrates with existing Workers.
- Works seamlessly with [OpenAI streaming](https://github.com/openai/openai-node?tab=readme-ov-file#streaming-responses).
- Adheres to the [SSE specification](https://html.spec.whatwg.org/multipage/server-sent-events.html) and is thoroughly tested.

## Installation

With npm

```bash
npm install cloudflare-workers-sse
```

With Yarn

```bash
yarn add cloudflare-workers-sse
```

With pnpm

```bash
pnpm add cloudflare-workers-sse
```

With Bun

```bash
bun add cloudflare-workers-sse
```

## Usage

The implementation of SSE involves two components: a client that receives messages and a server (in this case, a worker) that publishes them.

Let's start with the worker.

```typescript
import { sse } from "cloudflare-workers-sse";

export default {
  fetch: sse(handler),
};

async function* handler(request: Request, env: Env, ctx: ExecutionContext) {
  yield {
    event: "greeting",
    data: { text: "Hi there!" },
  };
}
```

And that's basically it. All messages yielded are streamed to a client listening for them. Once there are no more messages, the stream is closed.

The handler may also return a plain `Response` (synchronously or asynchronously) instead of a generator — for example, to reject unauthorized requests without opening an SSE stream:

```typescript
async function handler(request: Request, env: Env, ctx: ExecutionContext) {
  if (!isAuthorized(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  return (async function* () {
    yield { event: "greeting", data: { text: "Hi there!" } };
  })();
}
```

Although the simplest client-side implementation can be achieved using `EventSource`, for more advanced scenarios — such as using `POST` requests or handling authentication — it is recommended to use libraries such as [`@microsoft/fetch-event-source`](https://github.com/Azure/fetch-event-source).

```typescript
const eventSource = new EventSource(
  "https://<YOUR_WORKER_SUBDOMAIN>.workers.dev"
);
eventSource.addEventListener("greeting", (event) => {
  // handle the greeting message
});
```

### Message Type

All messages yielded by a handler should conform to the `SSEMessage` interface.

```typescript
interface SSEMessage {
  id?: string;
  event?: string;
  data?: null | boolean | number | bigint | string | Jsonifiable;
  retry?: number;
  comment?: string;
}
```

`data` can be of any primitive type (except `Symbol`) or an object, in which case it will be converted to JSON. `Jsonifiable` covers JSON-serializable objects, arrays, primitives, and values with a `toJSON()` method. If data is omitted or set to `undefined` or `null`, the empty `data` field will be added — except for comment-only messages.

`retry` sets the reconnection time in milliseconds. If specified, must be a positive integer, otherwise a `RangeError` is thrown.

`comment` is serialized as SSE comment line(s) starting with `:`. Multiline comments become multiple comment lines. A comment-only message (no `id`, `event`, `retry`, or `data`) does not include a `data` field, which is useful for keepalives.

### Handling Errors

Errors thrown by a handler or during serialization can be caught via the `onError` callback. It may also return a message to stream to the client before the connection closes. Client disconnects and request aborts do not invoke `onError`.

```typescript
import { sse } from "cloudflare-workers-sse";

export default {
  fetch: sse(handler, {
    onError: (error, request, env, ctx) => ({ event: "error_occurred" }),
  }),
};
```

### Heartbeats

To keep the connection alive during long idle periods, set `heartbeatIntervalMs` to a positive number of milliseconds. While the stream is open, a comment-only keepalive (`:\n\n`) is written on that interval.

```typescript
import { sse } from "cloudflare-workers-sse";

export default {
  fetch: sse(handler, {
    heartbeatIntervalMs: 15_000,
  }),
};
```

### Custom Headers

By default, only essential headers such as `Content-Type`, `Cache-Control`, and `Connection` are included in the response. To send additional headers, use the `customHeaders` option. Essential SSE headers always take precedence and cannot be overridden.

```typescript
import { sse } from "cloudflare-workers-sse";

export default {
  fetch: sse(handler, {
    customHeaders: { "access-control-allow-origin": "https://example.com" },
  }),
};
```

### Middleware

If your worker requires additional logic — such as request validation, response modification, or other pre/post-processing — you can implement a middleware.

```typescript
import { type FetchHandler, sse } from "cloudflare-workers-sse";

export default {
  fetch: middleware(sse(handler)),
};

function middleware<Env>(nextHandler: FetchHandler<Env>): FetchHandler<Env> {
  return async function middlewareHandler(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ) {
    // a before logic
    const response = await nextHandler(request, env, ctx);
    // an after logic
    return response;
  };
}
```
