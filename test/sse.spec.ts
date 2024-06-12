import { describe, it, expect } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext,
  env,
} from "cloudflare:test";
import { sse } from "../src/sse";

describe("sse", () => {
  it("streams produced events", async () => {
    const fetchHandler = sse(async function* () {
      yield {
        id: "854426ea-63a9-44ca-b569-7a59192743a1",
        event: "terminal_countdown",
      };
      yield {
        id: "98f6ade1-a75d-40f9-83b8-50f519c68e7b",
        event: "ignition",
        data: "check",
      };
      yield {
        id: "f34853b5-c6bb-462a-8add-8ae84afecc36",
        event: "liftoff",
        data: { engines: ["full_thrust", "full_thrust", "full_thrust"] },
      };
    });

    const ctx = createExecutionContext();
    const response = await fetchHandler(
      new Request("http://rocker-launch.com"),
      env,
      ctx
    );

    expect(response.status).toBe(200);

    const receivedEvents: string[] = [];
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Empty response body returned.");
    }
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const event = decoder.decode(value);
      receivedEvents.push(event);
    }

    expect(receivedEvents).toEqual([
      "id: 854426ea-63a9-44ca-b569-7a59192743a1\nevent: terminal_countdown\ndata: null\n\n",
      'id: 98f6ade1-a75d-40f9-83b8-50f519c68e7b\nevent: ignition\ndata: "check"\n\n',
      'id: f34853b5-c6bb-462a-8add-8ae84afecc36\nevent: liftoff\ndata: {"engines":["full_thrust","full_thrust","full_thrust"]}\n\n',
    ]);

    await waitOnExecutionContext(ctx);
  });

  it("writes custom headers to the response", async () => {
    const fetchHandler = sse(
      async function* () {
        yield { event: "pong" };
      },
      { customHeaders: { "Access-Control-Allow-Origin": "*" } }
    );

    const ctx = createExecutionContext();
    const response = await fetchHandler(
      new Request("http://example.com"),
      env,
      ctx
    );

    await response.text();
    await waitOnExecutionContext(ctx);

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
