import {
  createExecutionContext,
  env,
  waitOnExecutionContext
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { type FetchHandler, sse } from "../src/sse";

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

      // with all fields
      yield {
        id: "f34853b5-c6bb-462a-8add-8ae84afecc36",
        event: "liftoff",
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

      // with retry field
      yield { retry: 1000 };
      yield { retry: 2000, data: "with retry" };
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

id: f34853b5-c6bb-462a-8add-8ae84afecc36
event: liftoff
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

data:
retry: 1000

data: with retry
retry: 2000

`;

    expect(messages.join("")).toBe(expectedOutput);
  });

  describe("retry field validation", () => {
    it("includes valid retry value", async () => {
      const ctx = createExecutionContext();
      const fetchHandler = sse(async function* () {
        yield { retry: 1000 };
      });

      const response = await fetchHandler(
        new Request("http://test.sse.workers.dev"),
        env,
        ctx
      );

      const messages = await readResponseStream(response);
      await waitOnExecutionContext(ctx);

      expect(messages[0]).toBe("data:\nretry: 1000\n\n");
    });

    it("ignores negative retry value", async () => {
      const ctx = createExecutionContext();
      const fetchHandler = sse(async function* () {
        yield { retry: -1000 };
      });

      const response = await fetchHandler(
        new Request("http://test.sse.workers.dev"),
        env,
        ctx
      );

      const messages = await readResponseStream(response);
      await waitOnExecutionContext(ctx);

      expect(messages[0]).toBe("data:\n\n");
    });

    it("ignores non-integer retry value", async () => {
      const ctx = createExecutionContext();
      const fetchHandler = sse(async function* () {
        yield { retry: 1000.5 };
      });

      const response = await fetchHandler(
        new Request("http://test.sse.workers.dev"),
        env,
        ctx
      );

      const messages = await readResponseStream(response);
      await waitOnExecutionContext(ctx);

      expect(messages[0]).toBe("data:\n\n");
    });

    it("ignores zero retry value", async () => {
      const ctx = createExecutionContext();
      const fetchHandler = sse(async function* () {
        yield { retry: 0 };
      });

      const response = await fetchHandler(
        new Request("http://test.sse.workers.dev"),
        env,
        ctx
      );

      const messages = await readResponseStream(response);
      await waitOnExecutionContext(ctx);

      expect(messages[0]).toBe("data:\n\n");
    });

    it("handles retry with other fields", async () => {
      const ctx = createExecutionContext();
      const fetchHandler = sse(async function* () {
        yield {
          retry: 1000,
          id: "test-id",
          event: "test-event",
          data: "test data"
        };
      });

      const response = await fetchHandler(
        new Request("http://test.sse.workers.dev"),
        env,
        ctx
      );

      const messages = await readResponseStream(response);
      await waitOnExecutionContext(ctx);

      expect(messages[0]).toBe(
        "id: test-id\nevent: test-event\ndata: test data\nretry: 1000\n\n"
      );
    });

    it("handles multiple retry values in sequence", async () => {
      const ctx = createExecutionContext();
      const fetchHandler = sse(async function* () {
        yield { retry: 1000 };
        yield { retry: 2000 };
        yield { retry: -1000 }; // Should be ignored
        yield { retry: 3000 };
      });

      const response = await fetchHandler(
        new Request("http://test.sse.workers.dev"),
        env,
        ctx
      );

      const messages = await readResponseStream(response);
      await waitOnExecutionContext(ctx);

      expect(messages[0]).toBe("data:\nretry: 1000\n\n");
      expect(messages[1]).toBe("data:\nretry: 2000\n\n");
      expect(messages[2]).toBe("data:\n\n");
      expect(messages[3]).toBe("data:\nretry: 3000\n\n");
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
  });
});

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
