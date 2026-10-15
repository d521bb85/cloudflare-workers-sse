import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { sse } from "../src/sse";

describe("sse", () => {
  it("writes essential headers", async () => {
    const ctx = createExecutionContext();

    const fetchHandler = sse(async function* () {
      yield {};
    });

    const response = await fetchHandler(
      new Request("http://test.sse.workers.dev"),
      env,
      ctx
    );

    await waitOnExecutionContext(ctx);

    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });

  it("writes custom headers", async () => {
    const ctx = createExecutionContext();

    const fetchHandler = sse(
      async function* () {
        yield {};
      },
      {
        customHeaders: {
          "access-control-allow-origin": "*",
          "x-custom-header": "added"
        }
      }
    );

    const response = await fetchHandler(
      new Request("http://test.sse.workers.dev"),
      env,
      ctx
    );

    await waitOnExecutionContext(ctx);

    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-custom-header")).toBe("added");
  });

  it("does not allow customHeaders to override Content-Type", async () => {
    const ctx = createExecutionContext();

    const fetchHandler = sse(
      async function* () {
        yield {};
      },
      {
        customHeaders: {
          "Content-Type": "text/plain",
          "content-type": "application/json"
        }
      }
    );

    const response = await fetchHandler(
      new Request("http://test.sse.workers.dev"),
      env,
      ctx
    );

    await waitOnExecutionContext(ctx);

    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });

  it("writes messages according to the spec", async () => {
    const ctx = createExecutionContext();

    const fetchHandler = sse(async function* () {
      // a dummy one
      yield {};

      // with an id only
      yield { id: "854426ea-63a9-44ca-b569-7a59192743a1" };

      // with an event only
      yield { event: "ping" };

      // with a data ommited
      yield {
        id: "98f6ade1-a75d-40f9-83b8-50f519c68e7b",
        event: "ignition"
      };

      // with a retry only
      yield { retry: 2000 };

      // with all fields
      yield {
        id: "f34853b5-c6bb-462a-8add-8ae84afecc36",
        event: "liftoff",
        retry: 1000,
        data: { engines: "OK" }
      };

      // with a primitive type data
      yield { data: undefined };
      yield { data: null };
      yield { data: true };
      yield { data: 1 };
      yield { data: Math.PI };
      yield { data: 435450713972672392763916375520n };
      yield { data: "message" };

      // with a multiline string data
      yield { data: "one\ntwo\nthree" };

      // with an object type data
      yield {
        data: {
          from: "Alice",
          to: "Bob"
        }
      };

      yield { data: ["Alice", "Bob"] };
    });

    const response = await fetchHandler(
      new Request("http://test.sse.workers.dev"),
      env,
      ctx
    );

    const messages = await readResponseStream(response);
    await waitOnExecutionContext(ctx);

    const expectedOutput = `data:

id: 854426ea-63a9-44ca-b569-7a59192743a1
data:

event: ping
data:

id: 98f6ade1-a75d-40f9-83b8-50f519c68e7b
event: ignition
data:

retry: 2000
data:

id: f34853b5-c6bb-462a-8add-8ae84afecc36
event: liftoff
retry: 1000
data: {"engines":"OK"}

data:

data:

data: true

data: 1

data: 3.141592653589793

data: 435450713972672392763916375520

data: message

data: one
data: two
data: three

data: {"from":"Alice","to":"Bob"}

data: ["Alice","Bob"]

`;

    expect(messages.join("")).toBe(expectedOutput);
  });

  it("serializes comment-only and comment-with-fields messages", async () => {
    const ctx = createExecutionContext();

    const fetchHandler = sse(async function* () {
      yield { comment: "" };
      yield { comment: "keepalive" };
      yield { comment: "line1\nline2" };
      yield { comment: "note", event: "ping", data: "ok" };
      // explicit `data` key (even undefined) is not comment-only
      yield { comment: "with-data-key", data: undefined };
    });

    const response = await fetchHandler(
      new Request("http://test.sse.workers.dev"),
      env,
      ctx
    );

    const messages = await readResponseStream(response);
    await waitOnExecutionContext(ctx);

    expect(messages.join("")).toBe(
      `:

: keepalive

: line1
: line2

: note
event: ping
data: ok

: with-data-key
data:

`
    );
  });

  it("emits heartbeat comments while the handler yields slowly", async () => {
    const ctx = createExecutionContext();

    const fetchHandler = sse(
      async function* () {
        yield { data: "start" };
        await delay(40);
        yield { data: "end" };
      },
      { heartbeatIntervalMs: 10 }
    );

    const response = await fetchHandler(
      new Request("http://test.sse.workers.dev"),
      env,
      ctx
    );

    const body = (await readResponseStream(response)).join("");
    await waitOnExecutionContext(ctx);

    expect(body).toContain("data: start");
    expect(body).toContain("data: end");
    expect(body).toMatch(/:\n\n/);
  });

  it("returns an early Response from the handler without SSE wrapping", async () => {
    const ctx = createExecutionContext();

    const fetchHandler = sse(async () => {
      return new Response("unauthorized", { status: 401 });
    });

    const response = await fetchHandler(
      new Request("http://test.sse.workers.dev"),
      env,
      ctx
    );

    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).not.toBe("text/event-stream");
    expect(await response.text()).toBe("unauthorized");
  });

  it("accepts an async function that returns a generator", async () => {
    const ctx = createExecutionContext();

    const fetchHandler = sse(async () => {
      return (async function* () {
        yield { event: "ready", data: "yes" };
      })();
    });

    const response = await fetchHandler(
      new Request("http://test.sse.workers.dev"),
      env,
      ctx
    );

    const messages = await readResponseStream(response);
    await waitOnExecutionContext(ctx);

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(messages.join("")).toBe("event: ready\ndata: yes\n\n");
  });

  it("does not call onError when the request is aborted", async () => {
    const ctx = createExecutionContext();
    const onError = vi.fn();
    const controller = new AbortController();

    let reachedSecond = false;

    const fetchHandler = sse(
      async function* () {
        yield { data: "first" };
        await delay(100);
        reachedSecond = true;
        yield { data: "second" };
      },
      { onError }
    );

    const response = await fetchHandler(
      new Request("http://test.sse.workers.dev", {
        signal: controller.signal
      }),
      env,
      ctx
    );

    if (!response.body) {
      throw new Error("Expected SSE response body");
    }

    const reader = response.body.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("data: first");

    controller.abort();
    await reader.cancel().catch(() => {});

    await delay(150);
    await waitOnExecutionContext(ctx);

    expect(onError).not.toHaveBeenCalled();
    expect(reachedSecond).toBe(false);
  });

  it("calls onError when the handler throws an error whose message mentions abort or closed", async () => {
    const request = new Request("http://test.sse.workers.dev");
    const ctx = createExecutionContext();
    const onError = vi.fn();
    const error = new Error("operation aborted: connection closed by policy");

    const fetchHandler = sse(
      async function* () {
        yield { data: "ok" };
        throw error;
      },
      { onError }
    );

    const response = await fetchHandler(request, env, ctx);
    await response.text();
    await waitOnExecutionContext(ctx);

    expect(onError).toBeCalledWith(error, request, env, ctx);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does not call onError when the response body is cancelled without aborting the request", async () => {
    const ctx = createExecutionContext();
    const onError = vi.fn();

    const fetchHandler = sse(
      async function* () {
        yield { data: "first" };
        await delay(50);
        yield { data: "second" };
        await delay(50);
        yield { data: "third" };
      },
      { onError }
    );

    const response = await fetchHandler(
      new Request("http://test.sse.workers.dev"),
      env,
      ctx
    );

    if (!response.body) {
      throw new Error("Expected SSE response body");
    }

    const reader = response.body.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("data: first");

    // cancel() with no reason errors the writable side with `undefined`
    await reader.cancel();

    await delay(200);
    await waitOnExecutionContext(ctx);

    expect(onError).not.toHaveBeenCalled();
  });

  it("does not allow customHeaders to override Cache-Control or Connection", async () => {
    const ctx = createExecutionContext();

    const fetchHandler = sse(
      async function* () {
        yield {};
      },
      {
        customHeaders: {
          "Cache-Control": "max-age=3600",
          Connection: "close"
        }
      }
    );

    const response = await fetchHandler(
      new Request("http://test.sse.workers.dev"),
      env,
      ctx
    );

    await waitOnExecutionContext(ctx);

    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("connection")).toBe("keep-alive");
  });

  describe("calls onError with a RangeError when an invalid retry value is passed", async () => {
    it("retry value is non-integer", async () => {
      const request = new Request("http://test.sse.workers.dev");
      const ctx = createExecutionContext();

      const onError = vi.fn();

      const fetchHandler = sse(
        async function* () {
          yield { retry: 500.19 };
        },
        { onError }
      );

      const response = await fetchHandler(request, env, ctx);
      await response.text();
      await waitOnExecutionContext(ctx);

      expect(onError).toBeCalledWith(expect.any(RangeError), request, env, ctx);
    });

    it("retry value is zero", async () => {
      const request = new Request("http://test.sse.workers.dev");
      const ctx = createExecutionContext();

      const onError = vi.fn();

      const fetchHandler = sse(
        async function* () {
          yield { retry: 0 };
        },
        { onError }
      );

      const response = await fetchHandler(request, env, ctx);
      await response.text();
      await waitOnExecutionContext(ctx);

      expect(onError).toBeCalledWith(expect.any(RangeError), request, env, ctx);
    });

    it("retry value is negative", async () => {
      const request = new Request("http://test.sse.workers.dev");
      const ctx = createExecutionContext();

      const onError = vi.fn();

      const fetchHandler = sse(
        async function* () {
          yield { retry: -1000 };
        },
        { onError }
      );

      const response = await fetchHandler(request, env, ctx);
      await response.text();
      await waitOnExecutionContext(ctx);

      expect(onError).toBeCalledWith(expect.any(RangeError), request, env, ctx);
    });
  });

  it("calls onError when handler throws", async () => {
    const error = new Error();
    const request = new Request("http://test.sse.workers.dev");
    const ctx = createExecutionContext();

    const onError = vi.fn();

    const fetchHandler = sse(
      async function* () {
        yield {};
        throw error;
      },
      { onError }
    );

    const response = await fetchHandler(request, env, ctx);
    const messages = await readResponseStream(response);
    await waitOnExecutionContext(ctx);

    expect(onError).toBeCalledWith(error, request, env, ctx);
    expect(messages).toEqual(["data:\n\n"]);
  });

  it("writes a message returned from onError", async () => {
    const ctx = createExecutionContext();

    const fetchHandler = sse(
      async function* () {
        yield {};
        throw new Error();
      },
      { onError: async () => ({ event: "error_occurred" }) }
    );

    const response = await fetchHandler(
      new Request("http://test.sse.workers.dev"),
      env,
      ctx
    );

    const messages = await readResponseStream(response);
    await waitOnExecutionContext(ctx);

    expect(messages.at(-1)).toBe("event: error_occurred\ndata:\n\n");
  });

  it("calls onError when an error thrown during a message serialization", async () => {
    const error = new Error();
    const request = new Request("http://test.sse.workers.dev");
    const ctx = createExecutionContext();

    const onError = vi.fn();

    const fetchHandler = sse(
      async function* () {
        yield {
          data: {
            toJSON() {
              throw error;
            }
          }
        };
      },
      { onError }
    );

    const response = await fetchHandler(request, env, ctx);
    await response.text();
    await waitOnExecutionContext(ctx);

    expect(onError).toBeCalledWith(error, request, env, ctx);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does not recursively call onError when the error message fails to serialize", async () => {
    const request = new Request("http://test.sse.workers.dev");
    const ctx = createExecutionContext();
    const onError = vi.fn(() => ({ retry: -1 }));

    const fetchHandler = sse(
      async function* () {
        yield { retry: 1.5 };
      },
      { onError }
    );

    const response = await fetchHandler(request, env, ctx);
    await response.text();
    await waitOnExecutionContext(ctx);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toBeCalledWith(expect.any(RangeError), request, env, ctx);
  });

  it("does not leave an unhandled rejection when the write task fails", async () => {
    const ctx = createExecutionContext();
    const unhandled: unknown[] = [];

    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };

    process.on("unhandledRejection", onUnhandled);

    try {
      const fetchHandler = sse(
        async function* () {
          yield {
            data: {
              toJSON() {
                throw new Error("serialize boom");
              }
            }
          };
        },
        {
          onError: () => {
            throw new Error("onError boom");
          }
        }
      );

      const response = await fetchHandler(
        new Request("http://test.sse.workers.dev"),
        env,
        ctx
      );

      await response.text().catch(() => {});
      await waitOnExecutionContext(ctx);
      await delay(20);

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readResponseStream(response: Response): Promise<string[]> {
  if (!response.body) {
    throw new Error("Given response has no body.");
  }

  const messages: string[] = [];

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    const chunk = decoder.decode(value);
    messages.push(chunk);
  }

  return messages;
}
