import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { codexWsUpstreamFetch } from "../../src/server/responses/ws-upstream";
import { providerFetch } from "../../src/server/responses/fetch-helpers";
import type { OcxProviderConfig } from "../../src/types";

const URL = "https://chatgpt.com/backend-api/codex/responses";
const realWebSocket = globalThis.WebSocket;

class DelayedWebSocket extends EventTarget {
  static instances: DelayedWebSocket[] = [];
  static constructed?: (socket: DelayedWebSocket) => void;
  readonly sent: string[] = [];
  readonly listeners = new Set<EventListenerOrEventListenerObject>();
  closed = false;
  constructor(readonly url: string, readonly options: { headers: Record<string, string> }) {
    super();
    DelayedWebSocket.instances.push(this);
    DelayedWebSocket.constructed?.(this);
  }
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    if (listener) this.listeners.add(listener);
    super.addEventListener(type, listener, options);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    if (listener) this.listeners.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  send(frame: string): void { this.sent.push(frame); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
}

function install(): void {
  globalThis.WebSocket = DelayedWebSocket as unknown as typeof WebSocket;
}

function init(signal?: AbortSignal): RequestInit {
  return {
    method: "POST", signal,
    headers: { authorization: "Bearer fixture-reserve", "chatgpt-account-id": "fixture-workspace" },
    body: JSON.stringify({ model: "gpt-reserve", input: "ping", stream: true }),
  };
}

afterEach(() => {
  for (const socket of DelayedWebSocket.instances) socket.close();
  DelayedWebSocket.instances = [];
  DelayedWebSocket.constructed = undefined;
  globalThis.WebSocket = realWebSocket;
});

describe("synchronous Reserve dispatch callbacks on WebSocket", () => {
  test("handshake refusal rejects the original error without dialing or HTTP fallback", async () => {
    install();
    const refusal = new Error("local permission refused");
    let fallbacks = 0;
    const fallback = Object.assign(async () => { fallbacks += 1; return new Response("unexpected"); }, { preconnect() {} });
    await expect(codexWsUpstreamFetch(URL, init(), fallback, "1.4.0", () => { throw refusal; }))
      .rejects.toBe(refusal);
    expect(DelayedWebSocket.instances).toHaveLength(0);
    expect(fallbacks).toBe(0);
  });

  test("delayed-open refusal closes and detaches before synchronous close, with no create or fallback", async () => {
    install();
    const refusal = new Error("proof revoked during upgrade");
    const abort = new AbortController();
    const removeAbort = spyOn(abort.signal, "removeEventListener");
    let checks = 0;
    let fallbacks = 0;
    const fallback = Object.assign(async () => { fallbacks += 1; return new Response("unexpected"); }, { preconnect() {} });
    const pending = codexWsUpstreamFetch(URL, init(abort.signal), fallback, "1.4.0", headers => {
      expect(headers.get("authorization")).toBe("Bearer fixture-reserve");
      expect(headers.get("chatgpt-account-id")).toBe("fixture-workspace");
      if (++checks === 2) throw refusal;
    });
    const rejected = expect(pending).rejects.toBe(refusal);
    const socket = DelayedWebSocket.instances[0]!;
    socket.dispatchEvent(new Event("open"));
    await rejected;
    expect(checks).toBe(2);
    expect(socket.sent).toEqual([]);
    expect(socket.closed).toBe(true);
    expect(socket.listeners.size).toBe(0);
    expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
    abort.abort();
    socket.dispatchEvent(new Event("open"));
    expect(fallbacks).toBe(0);
    removeAbort.mockRestore();
  });

  test("allowed handshake and create dispatch one frame using the actual handshake credential", async () => {
    install();
    const seen: string[] = [];
    let fallbacks = 0;
    const fallback = Object.assign(async () => { fallbacks += 1; return new Response("unexpected"); }, { preconnect() {} });
    const pending = codexWsUpstreamFetch(URL, init(), fallback, "1.4.0", headers => {
      seen.push(headers.get("authorization")!);
    });
    const socket = DelayedWebSocket.instances[0]!;
    socket.dispatchEvent(new Event("open"));
    const response = await pending;
    expect(response.status).toBe(200);
    expect(seen).toEqual(["Bearer fixture-reserve", "Bearer fixture-reserve"]);
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "response.create", model: "gpt-reserve" });
    expect(fallbacks).toBe(0);
    await response.body?.cancel();
  });

  test("an upgrade failure's HTTP fallback still runs the dispatch guard", async () => {
    install();
    const refusal = new Error("permission expired before fallback");
    let permitted = true;
    let httpSends = 0;
    let constructed!: (socket: DelayedWebSocket) => void;
    const created = new Promise<DelayedWebSocket>(resolve => { constructed = resolve; });
    DelayedWebSocket.constructed = constructed;
    const provider: OcxProviderConfig & { fetch: typeof fetch } = {
      adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex",
      fetch: Object.assign(async () => { httpSends += 1; return new Response("unexpected"); }, { preconnect() {} }),
    };
    const executor = providerFetch(provider, "1.4.0", { beforeDispatch: () => { if (!permitted) throw refusal; } });
    const pending = executor(URL, init());
    const rejected = expect(pending).rejects.toBe(refusal);
    const socket = await created;
    permitted = false;
    socket.close();
    await rejected;
    expect(socket.sent).toEqual([]);
    expect(httpSends).toBe(0);
  });
});
