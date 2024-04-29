import { describe, it, expect } from "bun:test";
import { sse } from "./sse";

describe("sse", () => {
  it("has been defined", () => {
    expect(sse).toBeDefined();
  });
});
