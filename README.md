# cloudflare-workers-sse

SSE streaming for Cloudflare Workers via async generators.

Yield messages from a handler — they are streamed to the client as Server-Sent Events. Fits any token stream: Workers AI, AI Gateway, OpenAI-compatible APIs, Anthropic, or your own backend.

- Drop-in `fetch` handler
- Early `Response` for auth / validation (no SSE opened)
- Heartbeats, custom headers, and error callbacks
- Follows the [SSE specification](https://html.spec.whatwg.org/multipage/server-sent-events.html)

## Installation

```bash
npm install cloudflare-workers-sse
```

Also works with yarn, pnpm, and bun.

## Quick start

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

Each yielded message is streamed to the client. When the generator finishes, the stream closes.

To reject a request without opening SSE, return a plain `Response`:

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

## Stream an LLM

Wire any streaming API into the same `yield` loop. Example: Workers AI through [AI Gateway](https://developers.cloudflare.com/ai-gateway/) — auth first, then forward tokens as your own SSE events:

```typescript
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
    const stream = await env.AI.run(
      "@cf/meta/llama-3.1-8b-instruct",
      {
        messages: [{ role: "user", content: prompt }],
        stream: true,
      },
      { gateway: { id: "my-gateway" } }
    );

    for await (const chunk of stream) {
      yield { event: "token", data: chunk };
    }

    yield { event: "done" };
  })();
}
```

Workers AI with `stream: true` can already return SSE. Use this library when you want your own protocol — custom events, auth gates, heartbeats, or shaped error messages.

The same pattern works with any OpenAI-compatible client pointed at AI Gateway (or another provider):

```typescript
import OpenAI from "openai";

async function* streamCompletion(env: Env) {
  const openai = new OpenAI({
    apiKey: env.AI_GATEWAY_TOKEN,
    baseURL: `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${env.GATEWAY_ID}/compat`,
  });

  const stream = await openai.chat.completions.create({
    model: "workers-ai/@cf/meta/llama-3.1-8b-instruct",
    messages: [{ role: "user", content: "Hello" }],
    stream: true,
  });

  for await (const part of stream) {
    const text = part.choices[0]?.delta?.content;
    if (text) {
      yield { data: text };
    }
  }
}
```

### Client

Browser `EventSource` only supports GET. For the POST example above (or auth headers), use something like [`@microsoft/fetch-event-source`](https://github.com/Azure/fetch-event-source):

```typescript
import { fetchEventSource } from "@microsoft/fetch-event-source";

await fetchEventSource("https://<YOUR_WORKER>.workers.dev", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "Hello" }),
  onmessage(event) {
    if (event.event === "token") {
      // handle each token
    }
  },
});
```

## Message shape

Yielded values should match `SSEMessage`:

```typescript
interface SSEMessage {
  id?: string;
  event?: string;
  data?: null | boolean | number | bigint | string | Jsonifiable;
  retry?: number;
  comment?: string;
}
```

- **`data`** — primitives or objects (objects are JSON-stringified). Omitted / `null` / `undefined` become an empty `data` field (except comment-only messages).
- **`retry`** — reconnection time in ms; must be a positive integer.
- **`comment`** — serialized as `: ...` lines. A comment-only message (no `id` / `event` / `retry` / `data`) is useful for keepalives.

## Options

### Errors

`onError` runs when the handler or serialization throws. It may return a message to send before the stream closes. Client disconnects do not invoke it.

```typescript
export default {
  fetch: sse(handler, {
    onError: (error, request, env, ctx) => ({ event: "error_occurred" }),
  }),
};
```

### Heartbeats

Set `heartbeatIntervalMs` to write a comment keepalive (`:\n\n`) on that interval while the stream is open.

```typescript
export default {
  fetch: sse(handler, {
    heartbeatIntervalMs: 15_000,
  }),
};
```

### Custom headers

Essential SSE headers (`Content-Type`, `Cache-Control`, `Connection`) always win. Add others via `customHeaders`:

```typescript
export default {
  fetch: sse(handler, {
    customHeaders: { "access-control-allow-origin": "https://example.com" },
  }),
};
```

### Middleware

Wrap the SSE handler for validation or response tweaks:

```typescript
import { type FetchHandler, sse } from "cloudflare-workers-sse";

export default {
  fetch: middleware(sse(handler)),
};

function middleware<Env>(next: FetchHandler<Env>): FetchHandler<Env> {
  return async (request, env, ctx) => {
    const response = await next(request, env, ctx);
    return response;
  };
}
```
