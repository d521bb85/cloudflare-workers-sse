```typecript
import { sse } from "cloudflare-workers-sse";

export default {
  fetch: sse(handle)
};

async function* handle(request: Request, env: Env, ctx: ExecutionContext) {
  yield {
    event: "greeting",
    data: { time: new Date().toISOString() }
  };

  await new Promise(resolve => setTimeout(resolve, 1000));

  yield {
    event: "farewell",
    data: { time: new Date().toISOString() }
  };
}
```
