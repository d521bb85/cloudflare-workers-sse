# cloudflare-workers-sse

Elegant Server-Sent Events (SSE) steaming implementation for Cloudflare Workers.

- Offers a simple, straightforward, and functional approach to streaming events using async generators.
- Easily integrates with existing Workers.
- Works seamlessly with [OpenAI](https://github.com/openai/openai-node) streaming.

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

A worker implementation:

```typescript
import { sse } from "cloudflare-workers-sse";

export default {
  fetch: sse(handle),
};

async function* handle(request: Request, env: Env, ctx: ExecutionContext) {
  yield {
    event: "greeting",
    data: { message: "Hello, World!" },
  };
}
```

And a sample client code consuming the events:

```typescript
const eventSource = new EventSource("https://your-worker.com");
eventSource.addEventListener("greeting", (event) => {
  const data = JSON.parse(event.data);
  console.log(data);
});
```

### Custom Headers

By default only essential headers such as "Content-Type", "Cache-Control", and "Connection" are set.

You can add additional headers using the `customHeaders` option.

Example:

```typescript
sse(handle, {
  customHeaders: { "Access-Control-Allow-Origin": "*" },
});
```
