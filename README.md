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
  fetch: sse(handler)
};

async function* handler(request: Request, env: Env, ctx: ExecutionContext) {
  yield {
    event: "greeting",
    data: { text: "Hi there!" }
  };
}

```

And that's basically it. All messages yielded are streamed to a client listening for them. Once there are no more messages, the stream is closed.

Although the simplest client-side implementation can be achieved using `EventSource`, for more advanced scenarios — such as using `POST` requests or handling authentication — it is recommended to use libraries such as [`@microsoft/fetch-event-source`](https://github.com/Azure/fetch-event-source).

```typescript
const eventSource = new EventSource("https://<YOUR_WORKER_SUBDOMAIN>.workers.dev");
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
}
```

`data` is optional and can be any primitive type (except `Symbol`) or an object, in which case it will be converted to JSON. More information about `Jsonifiable` can be found [here](https://github.com/sindresorhus/type-fest/blob/main/source/jsonifiable.d.ts). If data is omitted or set to `undefined` or `null`, the empty `data` field will be added. 


### Handling Errors

Errors thrown by a handler can be caught using the `onError` callback, which can also return a message to be streamed to the client before closing the stream.

```typescript
import { sse } from "cloudflare-workers-sse";

export default {
  fetch: sse(handler, {
    onError: (error, request, env, ctx) => ({ event: "error_occurred" })
  })
}
```

### Custom Headers

By default, only essential headers such as `Content-Type`, `Cache-Control`, and `Connection` are included in the response. To send additional headers, use the `customHeaders` option.

```typescript
import { sse } from "cloudflare-workers-sse";

export default {
  fetch: sse(handler, {
    customHeaders: { "access-control-allow-origin": "https://example.com" }
  })
}
```

### Request Preprocessing

Request preprocessing can be easily achieved by implementing a middleware handler.

For example, to allow only `POST` requests, you can do the following:

```typescript
import { sse } from "cloudflare-workers-sse";

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    return sse(handler)(request, env, ctx);
  }
}
