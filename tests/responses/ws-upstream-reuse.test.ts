import { afterEach, expect, test } from "bun:test";
import { codexWsUpstreamFetch } from "../../src/server/responses/ws-upstream";
import { runOptionalShutdownHooks } from "../../src/lib/optional-shutdown-hooks";

const URL = "https://chatgpt.com/backend-api/codex/responses";
const realWebSocket = globalThis.WebSocket;
let sequence = 0;

class Socket extends EventTarget {
  static all: Socket[] = [];
  static onSend: (socket: Socket, frame: Record<string, unknown>) => void = (socket) => socket.complete();
  readyState = 0;
  frames: Record<string, unknown>[] = [];
  constructor(readonly url: string) {
    super();
    Socket.all.push(this);
    queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.dispatchEvent(new Event("open")); } });
  }
  send(text: string) {
    const frame = JSON.parse(text);
    this.frames.push(frame);
    Socket.onSend(this, frame);
  }
  emit(payload: Record<string, unknown>) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
  complete() {
    const id = `response-${++sequence}`;
    queueMicrotask(() => {
      this.emit({ type: "response.created", response: { id } });
      this.emit({ type: "response.completed", response: { id, status: "completed", output: [] } });
    });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  ref() {}
  unref() {}
}

function init(input = "first", signal?: AbortSignal): RequestInit {
  return { method: "POST", signal, headers: {
    authorization: "Bearer fixture-token", "chatgpt-account-id": "fixture-account", "thread-id": "fixture-thread",
  }, body: JSON.stringify({ model: "fixture-model", stream: true, input,
    client_metadata: { thread_id: "fixture-thread", turn_id: "fixture-turn" } }) };
}

const fallback = (async () => { throw new Error("unexpected HTTP fallback"); }) as typeof fetch;

afterEach(() => {
  runOptionalShutdownHooks();
  for (const socket of Socket.all) socket.close();
  Socket.all = [];
  Socket.onSend = socket => socket.complete();
  sequence = 0;
  globalThis.WebSocket = realWebSocket;
});

test("same account/thread/turn reuses one socket without trimming either HTTP input", async () => {
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  await (await codexWsUpstreamFetch(URL, init("first full input"), fallback, "1.4.0")).text();
  await (await codexWsUpstreamFetch(URL, init("second full input"), fallback, "1.4.0")).text();
  expect(Socket.all).toHaveLength(1);
  expect(Socket.all[0]!.frames.map(frame => frame.input)).toEqual(["first full input", "second full input"]);
  expect(Socket.all[0]!.frames.every(frame => !Object.hasOwn(frame, "previous_response_id"))).toBe(true);
});
