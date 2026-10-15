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

  it("calls onError when the handler throws AbortError from its own AbortController", async () => {
    const request = new Request("http://test.sse.workers.dev");
    const ctx = createExecutionContext();
    const onError = vi.fn(() => ({ event: "error", data: "upstream timeout" }));
    const upstreamAbort = new DOMException(
      "The operation was aborted.",
      "AbortError"
    );

    const fetchHandler = sse(
      async function* () {
        yield { data: "start" };
        throw upstreamAbort;
      },
      { onError }
    );

    const response = await fetchHandler(request, env, ctx);
    const body = (await readResponseStream(response)).join("");
    await waitOnExecutionContext(ctx);

    expect(onError).toBeCalledWith(upstreamAbort, request, env, ctx);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(body).toContain("data: start");
    expect(body).toContain("event: error");
    expect(body).toContain("data: upstream timeout");
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

  it("aborts the handler signal when a main-loop write fails after cancel", async () => {
    const ctx = createExecutionContext();
    let handlerSignal: AbortSignal | undefined;

    const fetchHandler = sse(async function* (_request, _env, _ctx, signal) {
      handlerSignal = signal;
      yield { data: "first" };
      await delay(50);
      yield { data: "second" };
      await delay(50);
      yield { data: "third" };
    });

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

    // No request.signal abort — only cancel the body so the next write fails.
    await reader.cancel();
    await delay(200);
    await waitOnExecutionContext(ctx);

    expect(handlerSignal?.aborted).toBe(true);
  });

  it("does not allow customHeaders to override Cache-Control", async () => {
    const ctx = createExecutionContext();

    const fetchHandler = sse(
      async function* () {
        yield {};
      },
      {
        customHeaders: {
          "Cache-Control": "max-age=3600"
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

  it("closes the stream promptly when aborted during a pending next()", async () => {
    const ctx = createExecutionContext();
    const controller = new AbortController();
    const never = new Promise<void>(() => {});

    const fetchHandler = sse(async function* () {
      yield { data: "first" };
      await never;
      yield { data: "second" };
    });

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

    // Must finish without waiting for the stuck generator.next()
    const closed = await Promise.race([
      reader.read().then(() => true),
      delay(200).then(() => false)
    ]);

    expect(closed).toBe(true);
    await waitOnExecutionContext(ctx);
  });

  it("stops the generator when serialization fails", async () => {
    const ctx = createExecutionContext();
    let cleanupRan = false;
    const onError = vi.fn();

    const fetchHandler = sse(
      async function* () {
        try {
          yield { retry: 0 };
          yield { data: "should-not-appear" };
        } finally {
          cleanupRan = true;
        }
      },
      { onError }
    );

    const response = await fetchHandler(
      new Request("http://test.sse.workers.dev"),
      env,
      ctx
    );

    const body = (await readResponseStream(response)).join("");
    await waitOnExecutionContext(ctx);

    expect(onError).toHaveBeenCalledWith(
      expect.any(RangeError),
      expect.any(Request),
      env,
      ctx
    );
    expect(cleanupRan).toBe(true);
    expect(body).not.toContain("should-not-appear");
  });

  it("splits data and comments on CR / CRLF and rejects newlines in id/event", async () => {
    const ctx = createExecutionContext();
    const onError = vi.fn();

    const fetchHandler = sse(
      async function* () {
        yield { data: "x\revent: evil" };
        yield { data: "a\r\nb" };
        yield { comment: "c1\rc2" };
        yield { id: "safe\ninject", data: "nope" };
      },
      { onError }
    );

    const response = await fetchHandler(
      new Request("http://test.sse.workers.dev"),
      env,
      ctx
    );

    const body = (await readResponseStream(response)).join("");
    await waitOnExecutionContext(ctx);

    expect(body).toContain("data: x\ndata: event: evil\n\n");
    expect(body).toContain("data: a\ndata: b\n\n");
    expect(body).toContain(": c1\n: c2\n\n");
    expect(body).not.toContain("id: safe");
    expect(onError).toHaveBeenCalledWith(
      expect.any(RangeError),
      expect.any(Request),
      env,
      ctx
    );
  });

  it("rejects NUL in id", async () => {
    const request = new Request("http://test.sse.workers.dev");
    const ctx = createExecutionContext();
    const onError = vi.fn();

    const fetchHandler = sse(
      async function* () {
        yield { id: "before\0after", data: "x" };
      },
      { onError }
    );

    const response = await fetchHandler(request, env, ctx);
    await response.text();
    await waitOnExecutionContext(ctx);

    expect(onError).toBeCalledWith(expect.any(RangeError), request, env, ctx);
  });

  it("writes an empty id to reset the last event ID", async () => {
    const ctx = createExecutionContext();

    const fetchHandler = sse(async function* () {
      yield { id: "", data: "reset" };
    });

    const response = await fetchHandler(
      new Request("http://test.sse.workers.dev"),
      env,
      ctx
    );

    const messages = await readResponseStream(response);
    await waitOnExecutionContext(ctx);

    expect(messages.join("")).toBe("id: \ndata: reset\n\n");
  });

  it("calls onError when toJSON returns undefined", async () => {
    const request = new Request("http://test.sse.workers.dev");
    const ctx = createExecutionContext();
    const onError = vi.fn();

    const fetchHandler = sse(
      async function* () {
        yield {
          data: {
            toJSON() {
              return undefined as unknown as string;
            }
          }
        };
      },
      { onError }
    );

    const response = await fetchHandler(request, env, ctx);
    await response.text();
    await waitOnExecutionContext(ctx);

    expect(onError).toBeCalledWith(expect.any(TypeError), request, env, ctx);
  });

  it("closes the stream when a heartbeat write fails after cancel", async () => {
    const ctx = createExecutionContext();
    const never = new Promise<void>(() => {});

    const fetchHandler = sse(
      async function* () {
        yield { data: "first" };
        await never;
        yield { data: "second" };
      },
      { heartbeatIntervalMs: 15 }
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

    await reader.cancel();

    // Heartbeat write fails → requestStop → writer closes; must not wait on never
    await waitOnExecutionContext(ctx);
    await delay(80);
  });

  it("aborts the handler signal when a heartbeat write fails so upstream can stop", async () => {
    const ctx = createExecutionContext();
    let cleanupMs = 0;
    const started = Date.now();

    const fetchHandler = sse(
      async function* (_request, _env, _ctx, signal) {
        yield { data: "first" };
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 1000);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(toAbortError());
            });
          });
        } catch {
          // aborted by failed heartbeat
        } finally {
          cleanupMs = Date.now() - started;
        }
      },
      { heartbeatIntervalMs: 15 }
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

    await reader.cancel();

    // writeMessages returns without awaiting generator.return(); wait for finally.
    for (let i = 0; i < 50 && cleanupMs === 0; i++) {
      await delay(10);
    }

    await waitOnExecutionContext(ctx);

    // Without signal abort, finally would wait ~1000ms for the timer.
    expect(cleanupMs).toBeGreaterThan(0);
    expect(cleanupMs).toBeLessThan(500);
  });

  it("aborts the handler signal when the request is aborted", async () => {
    const ctx = createExecutionContext();
    const controller = new AbortController();
    let handlerSignal: AbortSignal | undefined;

    const fetchHandler = sse(async function* (_request, _env, _ctx, signal) {
      handlerSignal = signal;
      yield { data: "first" };
      await delay(100);
      yield { data: "second" };
    });

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
    await reader.read();
    controller.abort();
    await delay(50);
    await waitOnExecutionContext(ctx);

    expect(handlerSignal?.aborted).toBe(true);
  });

  it("streams many messages then completes without retaining abort handlers", async () => {
    const ctx = createExecutionContext();
    const count = 500;

    const fetchHandler = sse(async function* () {
      for (let i = 0; i < count; i++) {
        yield { data: i };
      }
    });

    const response = await fetchHandler(
      new Request("http://test.sse.workers.dev"),
      env,
      ctx
    );

    const body = (await readResponseStream(response)).join("");
    await waitOnExecutionContext(ctx);

    expect(body).toContain(`data: 0\n\n`);
    expect(body).toContain(`data: ${count - 1}\n\n`);
  });
});

function toAbortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

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
