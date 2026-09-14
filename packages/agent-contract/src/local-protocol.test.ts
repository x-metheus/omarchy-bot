import { describe, expect, test } from "bun:test";
import { isAgentLocalToolRequest } from "./local-protocol.ts";

const context = {
  botId: "bot_0123456789abcdef0123456789abcdef",
  turnId: "turn_0123456789abcdef0123456789abcdef",
  workerSessionId: "s_session",
  toolCallId: "local-1",
};

describe("local.request reverse-request", () => {
  test("accepts a Turn-bound run on this-device", () => {
    expect(isAgentLocalToolRequest({
      type: "local.request",
      requestId: "req-1",
      context,
      action: "run",
      target: "this-device",
      command: "echo sidecar-sentinel",
    })).toBeTrue();
  });

  test("rejects extra keys, missing command, and Host Session actions", () => {
    expect(isAgentLocalToolRequest({
      type: "local.request",
      requestId: "req-1",
      context,
      action: "run",
      command: "echo ok",
      screenshot: true,
    })).toBeFalse();
    expect(isAgentLocalToolRequest({
      type: "local.request",
      requestId: "req-1",
      context,
      action: "run",
    })).toBeFalse();
    expect(isAgentLocalToolRequest({
      type: "computer.request",
      requestId: "req-1",
      context,
      action: "run",
      command: "echo ok",
    })).toBeFalse();
  });
});

describe("local.search, local.read, and local.write reverse-requests", () => {
  test("accepts Turn-bound search, read, and write with explicit query or path", () => {
    expect(isAgentLocalToolRequest({
      type: "local.request",
      requestId: "req-search",
      context,
      action: "search",
      target: "this-device",
      query: "hello-from-sidecar",
    })).toBeTrue();
    expect(isAgentLocalToolRequest({
      type: "local.request",
      requestId: "req-read",
      context,
      action: "read",
      path: "notes/doc.txt",
    })).toBeTrue();
    expect(isAgentLocalToolRequest({
      type: "local.request",
      requestId: "req-write",
      context,
      action: "write",
      path: "notes/doc.txt",
      contents: "hello-from-sidecar",
    })).toBeTrue();
  });

  test("rejects missing query or path and Host Session or Bot mail extras", () => {
    expect(isAgentLocalToolRequest({
      type: "local.request",
      requestId: "req-search",
      context,
      action: "search",
    })).toBeFalse();
    expect(isAgentLocalToolRequest({
      type: "local.request",
      requestId: "req-read",
      context,
      action: "read",
    })).toBeFalse();
    expect(isAgentLocalToolRequest({
      type: "local.request",
      requestId: "req-write",
      context,
      action: "write",
      contents: "hello-from-sidecar",
    })).toBeFalse();
    expect(isAgentLocalToolRequest({
      type: "local.request",
      requestId: "req-write",
      context,
      action: "write",
      path: "notes/doc.txt",
      screenshot: true,
    })).toBeFalse();
    expect(isAgentLocalToolRequest({
      type: "local.request",
      requestId: "req-write",
      context,
      action: "write",
      path: "notes/doc.txt",
      pointer: true,
    })).toBeFalse();
    expect(isAgentLocalToolRequest({
      type: "local.request",
      requestId: "req-write",
      context,
      action: "write",
      path: "notes/doc.txt",
      mail: true,
    })).toBeFalse();
    expect(isAgentLocalToolRequest({
      type: "computer.request",
      requestId: "req-write",
      context,
      action: "write",
      path: "notes/doc.txt",
      contents: "hello-from-sidecar",
    })).toBeFalse();
  });
});

