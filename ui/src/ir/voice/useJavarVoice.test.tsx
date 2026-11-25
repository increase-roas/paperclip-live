// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useJavarVoiceSession, type JavarVoiceState } from "./useJavarVoice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const voiceApiMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  createSession: vi.fn(),
  runTool: vi.fn(),
  getRuns: vi.fn(),
  postJournal: vi.fn(),
}));

vi.mock("../api/irOps", async () => {
  const actual = await vi.importActual<typeof import("../api/irOps")>("../api/irOps");
  return {
    ...actual,
    irOpsApi: {
      ...actual.irOpsApi,
      voice: {
        getStatus: voiceApiMocks.getStatus,
        createSession: voiceApiMocks.createSession,
        runTool: voiceApiMocks.runTool,
        getRuns: voiceApiMocks.getRuns,
        postJournal: voiceApiMocks.postJournal,
      },
    },
  };
});

class FakeDataChannel {
  readyState: RTCDataChannelState = "connecting";
  sent: string[] = [];
  private listeners = new Map<string, Array<(ev: unknown) => void>>();

  addEventListener(type: string, fn: (ev: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  emit(type: string, ev: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(ev);
    }
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = "closed";
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState: RTCPeerConnectionState = "new";
  channel: FakeDataChannel | null = null;
  private listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  addTrack() {}

  createDataChannel(_label: string) {
    this.channel = new FakeDataChannel();
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer() {
    return { type: "offer", sdp: "v=0-offer" } as RTCSessionDescriptionInit;
  }

  async setLocalDescription(_desc: RTCSessionDescriptionInit) {}

  async setRemoteDescription(_desc: RTCSessionDescriptionInit) {}

  close() {
    this.connectionState = "closed";
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

describe("useJavarVoiceSession hang-up command isolation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestSession: ReturnType<typeof useJavarVoiceSession> | null = null;
  let originalFetch: typeof globalThis.fetch;
  let originalRTCPeerConnection: typeof globalThis.RTCPeerConnection;
  let originalMediaDevices: MediaDevices | undefined;

  function Harness() {
    latestSession = useJavarVoiceSession({
      onTranscript: vi.fn(),
      active: false,
    });
    return null;
  }

  beforeEach(() => {
    FakePeerConnection.instances = [];
    latestSession = null;
    vi.clearAllMocks();

    voiceApiMocks.getStatus.mockResolvedValue({ ok: true, configured: true });
    voiceApiMocks.postJournal.mockResolvedValue({ ok: true });
    voiceApiMocks.getRuns.mockResolvedValue({ runs: [] });

    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("v=0-answer", { status: 200 })) as typeof fetch;

    originalRTCPeerConnection = globalThis.RTCPeerConnection;
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePeerConnection;

    originalMediaDevices = navigator.mediaDevices;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: vi.fn(), enabled: true }],
          getAudioTracks: () => [{ stop: vi.fn(), enabled: true }],
        })),
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      originalRTCPeerConnection;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
  });

  it("discards queued voice commands immediately on hang-up and aborts the active call", async () => {
    const firstTool = createDeferred<{ ok: boolean; output: string }>();
    let capturedSignal: AbortSignal | undefined;

    voiceApiMocks.createSession.mockResolvedValue({
      ok: true,
      clientSecret: "ek_call_1",
      offerUrl: "https://realtime.example/calls",
      journal: { callId: "call_1" },
    });
    voiceApiMocks.runTool.mockImplementation(
      (name: string, _args: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
        if (name === "first_command") {
          capturedSignal = opts?.signal;
          return firstTool.promise;
        }
        return Promise.resolve({ ok: true, output: "should never run" });
      },
    );

    await act(async () => {
      root.render(<Harness />);
    });

    await act(async () => {
      latestSession!.toggleCall();
      await flushMicrotasks();
    });

    const peer1 = FakePeerConnection.instances[0]!;
    const channel1 = peer1.channel!;
    expect(channel1).not.toBeNull();

    await act(async () => {
      channel1.readyState = "open";
      channel1.emit("open");
      channel1.emit("message", {
        data: JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "fn_1",
          name: "first_command",
          arguments: JSON.stringify({ target: "crm" }),
        }),
      });
      channel1.emit("message", {
        data: JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "fn_2",
          name: "second_queued_command",
          arguments: JSON.stringify({ action: "delete" }),
        }),
      });
      channel1.emit("message", { data: JSON.stringify({ type: "response.done" }) });
      await flushMicrotasks();
    });

    expect(voiceApiMocks.runTool).toHaveBeenCalledTimes(1);
    expect(voiceApiMocks.runTool).toHaveBeenCalledWith(
      "first_command",
      { target: "crm" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(capturedSignal?.aborted).toBe(false);

    // Hang up while first_command is still in flight and second_queued_command is queued.
    await act(async () => {
      latestSession!.endCall();
      await flushMicrotasks();
    });

    expect(capturedSignal?.aborted).toBe(true);
    expect(latestSession!.state).toBe<JavarVoiceState>("idle");

    // Even if the in-flight first_command later resolves, second_queued_command must NEVER run.
    await act(async () => {
      firstTool.resolve({ ok: true, output: "late response" });
      await flushMicrotasks();
    });

    expect(voiceApiMocks.runTool).toHaveBeenCalledTimes(1);
    expect(latestSession!.state).toBe<JavarVoiceState>("idle");
    expect(channel1.sent).toEqual([]);
  });

  it("binds queued commands and channel events to their originating call/session ID across reconnects", async () => {
    const staleCallTool = createDeferred<{ ok: boolean; output: string }>();
    let callCounter = 0;

    voiceApiMocks.createSession.mockImplementation(async () => {
      callCounter += 1;
      return {
        ok: true,
        clientSecret: `ek_call_${callCounter}`,
        offerUrl: "https://realtime.example/calls",
        journal: { callId: `call_${callCounter}` },
      };
    });
    voiceApiMocks.runTool.mockImplementation((name: string) => {
      if (name === "call1_inflight") return staleCallTool.promise;
      return Promise.resolve({ ok: true, output: `ran:${name}` });
    });

    await act(async () => {
      root.render(<Harness />);
    });

    // Start Call 1
    await act(async () => {
      latestSession!.toggleCall();
      await flushMicrotasks();
    });

    const channel1 = FakePeerConnection.instances[0]!.channel!;
    await act(async () => {
      channel1.readyState = "open";
      channel1.emit("open");
      channel1.emit("message", {
        data: JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "fn_c1_a",
          name: "call1_inflight",
          arguments: "{}",
        }),
      });
      channel1.emit("message", {
        data: JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "fn_c1_b",
          name: "call1_queued_must_drop",
          arguments: "{}",
        }),
      });
      await flushMicrotasks();
    });

    expect(voiceApiMocks.runTool).toHaveBeenCalledTimes(1);

    // Hang up Call 1 and immediately start Call 2 before Call 1's promise settles
    await act(async () => {
      latestSession!.endCall();
      await flushMicrotasks();
    });
    await act(async () => {
      latestSession!.toggleCall();
      await flushMicrotasks();
    });

    const channel2 = FakePeerConnection.instances[1]!.channel!;
    await act(async () => {
      channel2.readyState = "open";
      channel2.emit("open");
      // Late message arriving on Call 1's old channel must be ignored.
      channel1.emit("message", {
        data: JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "fn_c1_late",
          name: "call1_late_channel_event",
          arguments: "{}",
        }),
      });
      // Call 1's stale in-flight tool resolves during Call 2.
      staleCallTool.resolve({ ok: true, output: "stale_result" });
      await flushMicrotasks();
    });

    // Neither call1_queued_must_drop nor call1_late_channel_event ran, and Call 2's channel is untouched.
    expect(voiceApiMocks.runTool).toHaveBeenCalledTimes(1);
    expect(channel2.sent).toEqual([]);

    // Now Call 2 runs its own command cleanly.
    await act(async () => {
      channel2.emit("message", {
        data: JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "fn_c2_a",
          name: "call2_command",
          arguments: JSON.stringify({ ok: true }),
        }),
      });
      channel2.emit("message", { data: JSON.stringify({ type: "response.done" }) });
      await flushMicrotasks();
    });

    expect(voiceApiMocks.runTool).toHaveBeenCalledTimes(2);
    expect(voiceApiMocks.runTool).toHaveBeenLastCalledWith(
      "call2_command",
      { ok: true },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(channel2.sent.map((raw) => JSON.parse(raw))).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "fn_c2_a",
          output: "ran:call2_command",
        },
      },
      { type: "response.create" },
    ]);
  });
});
