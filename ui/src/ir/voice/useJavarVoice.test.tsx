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

  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({});
    }
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

describe("useJavarVoiceSession", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestSession: ReturnType<typeof useJavarVoiceSession> | null = null;
  let originalFetch: typeof globalThis.fetch;
  let originalRTCPeerConnection: typeof globalThis.RTCPeerConnection;
  let originalMediaDevices: MediaDevices | undefined;
  const onTranscript = vi.fn();

  function Harness() {
    latestSession = useJavarVoiceSession({
      onTranscript,
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
    vi.useRealTimers();
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

  const CALL_SESSION = {
    ok: true,
    clientSecret: "ek_call_1",
    offerUrl: "https://realtime.example/calls",
    journal: { callId: "call_1" },
  };

  async function startCall(session: Record<string, unknown> = CALL_SESSION) {
    voiceApiMocks.createSession.mockResolvedValue(session);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      latestSession!.toggleCall();
      for (let i = 0; i < 3; i += 1) await flushMicrotasks();
    });
  }

  async function startOpenCall(session: Record<string, unknown> = CALL_SESSION) {
    await startCall(session);
    const channel = FakePeerConnection.instances.at(-1)!.channel!;
    await act(async () => {
      channel.readyState = "open";
      channel.emit("open");
    });
    return channel;
  }

  /** Delivers events from the Realtime server on the call's data channel. */
  async function receive(channel: FakeDataChannel, ...events: Array<Record<string, unknown>>) {
    await act(async () => {
      for (const event of events) channel.emit("message", { data: JSON.stringify(event) });
      await flushMicrotasks();
    });
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  const sentEvents = (channel: FakeDataChannel) => channel.sent.map((raw) => JSON.parse(raw));

  const toolCall = (callId: string, name: string, args = "{}") => ({
    type: "response.function_call_arguments.done",
    call_id: callId,
    name,
    arguments: args,
  });

  const toolOutput = (callId: string, output: string) => ({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output },
  });

  const runReport = (runId: number, kind: string, status: string, result: string) => ({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text:
            `Work run #${runId} (${kind}) finished with status '${status}'. Result: ${result}` +
            "\n\nSummarize this aloud in one to three spoken sentences.",
        },
      ],
    },
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

  it("answers every tool call in call order, only after Javar's response ends, even when a tool fails", async () => {
    voiceApiMocks.runTool.mockImplementation(async (name: string) => {
      if (name === "broken") throw new Error("Gateway timed out");
      if (name === "silent") return { ok: true };
      return { ok: true, output: `ran:${name}` };
    });
    const channel = await startOpenCall();

    await receive(
      channel,
      toolCall("fn_1", "lookup", "{not json"),
      { type: "response.function_call_arguments.done", name: "missing_call_id", arguments: "{}" },
      toolCall("fn_2", "broken"),
      toolCall("fn_3", "silent", "[1, 2]"),
    );

    // Bad or non-object arguments run with {}; an event without a call ID never runs.
    expect(voiceApiMocks.runTool.mock.calls.map(([name, args]) => [name, args])).toEqual([
      ["lookup", {}],
      ["broken", {}],
      ["silent", {}],
    ]);
    // Results wait for response.done so Javar never answers with a partial set.
    expect(channel.sent).toEqual([]);

    await receive(channel, { type: "response.done" });

    expect(sentEvents(channel)).toEqual([
      toolOutput("fn_1", "ran:lookup"),
      toolOutput("fn_2", "broken failed: Gateway timed out"),
      toolOutput("fn_3", "(no output)"),
      { type: "response.create" },
    ]);
  });

  it("reads a finished work run back into the call, waiting while Javar is still talking", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    voiceApiMocks.runTool.mockResolvedValue({ ok: true, output: "Queued. WORK_STARTED #42 kind=research" });
    voiceApiMocks.getRuns
      .mockResolvedValueOnce({ runs: [{ runId: 42, status: "running" }] })
      .mockResolvedValue({
        runs: [
          { runId: 41, status: "succeeded", kind: "other", output: "Not this one." },
          { runId: 42, status: "succeeded", kind: "research", output: "Found 3 leads." },
        ],
      });
    const channel = await startOpenCall();

    await receive(channel, toolCall("fn_1", "start_research"), { type: "response.done" });
    expect(sentEvents(channel)).toEqual([
      toolOutput("fn_1", "Queued. WORK_STARTED #42 kind=research"),
      { type: "response.create" },
    ]);
    channel.sent.length = 0;

    await advance(3_999);
    expect(voiceApiMocks.getRuns).not.toHaveBeenCalled();
    await advance(1);
    expect(voiceApiMocks.getRuns).toHaveBeenCalledTimes(1);
    expect(channel.sent).toEqual([]);

    // The run finishes while Javar is mid-reply: hold the result until the reply ends.
    await receive(channel, { type: "response.created" });
    await advance(4_000);
    expect(voiceApiMocks.getRuns).toHaveBeenCalledTimes(2);
    expect(channel.sent).toEqual([]);

    await receive(channel, { type: "response.done" });
    await advance(4_000);
    expect(sentEvents(channel)).toEqual([
      runReport(42, "research", "succeeded", "Found 3 leads."),
      { type: "response.create" },
    ]);

    // Reported once, then polling stops.
    await advance(60_000);
    expect(voiceApiMocks.getRuns).toHaveBeenCalledTimes(3);
  });

  it("follows a chained work run and never reports the same run twice", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    voiceApiMocks.runTool.mockResolvedValue({ ok: true, output: "WORK_STARTED #7 kind=build" });
    voiceApiMocks.getRuns.mockResolvedValue({
      runs: [
        { runId: 7, status: "done", kind: "build", output: "Built. WORK_STARTED #8 kind=deploy" },
        { runId: 8, status: "done", output: "" },
      ],
    });
    const channel = await startOpenCall();

    // Two tool calls in one reply both point at run #7.
    await receive(channel, toolCall("fn_a", "build"), toolCall("fn_b", "build_again"), {
      type: "response.done",
    });
    channel.sent.length = 0;

    await advance(4_000);
    expect(voiceApiMocks.getRuns).toHaveBeenCalledTimes(1);
    expect(sentEvents(channel)).toEqual([
      runReport(7, "build", "done", "Built. WORK_STARTED #8 kind=deploy"),
      { type: "response.create" },
    ]);
    channel.sent.length = 0;

    // Run #8 has no kind or output of its own: fall back to the started kind and "(no output)".
    await advance(4_000);
    expect(voiceApiMocks.getRuns).toHaveBeenCalledTimes(2);
    expect(sentEvents(channel)).toEqual([runReport(8, "deploy", "done", "(no output)"), { type: "response.create" }]);

    await advance(60_000);
    expect(voiceApiMocks.getRuns).toHaveBeenCalledTimes(2);
  });

  it("keeps polling after a failed runs read, and stops for good on hang-up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    voiceApiMocks.runTool.mockResolvedValue({ ok: true, output: "WORK_STARTED #9 kind=report" });
    voiceApiMocks.getRuns
      .mockRejectedValueOnce(new Error("Runs feed unavailable"))
      .mockResolvedValue({ runs: [{ runId: 9, status: "running" }] });
    const channel = await startOpenCall();
    await receive(channel, toolCall("fn_1", "report"), { type: "response.done" });
    channel.sent.length = 0;

    await advance(4_000);
    expect(voiceApiMocks.getRuns).toHaveBeenCalledTimes(1);
    await advance(4_000);
    expect(voiceApiMocks.getRuns).toHaveBeenCalledTimes(2);

    await act(async () => {
      latestSession!.endCall();
    });
    expect(vi.getTimerCount()).toBe(0);
    voiceApiMocks.getRuns.mockResolvedValue({ runs: [{ runId: 9, status: "done", output: "late" }] });
    await advance(60_000);

    expect(voiceApiMocks.getRuns).toHaveBeenCalledTimes(2);
    expect(channel.sent).toEqual([]);
  });

  it("gives up on a work run that is still running after 15 minutes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    voiceApiMocks.runTool.mockResolvedValue({ ok: true, output: "WORK_STARTED #11 kind=audit" });
    voiceApiMocks.getRuns.mockResolvedValue({ runs: [{ runId: 11, status: "running" }] });
    const channel = await startOpenCall();
    await receive(channel, toolCall("fn_1", "audit"), { type: "response.done" });
    channel.sent.length = 0;

    await advance(15 * 60 * 1000);
    const pollsWithinCap = voiceApiMocks.getRuns.mock.calls.length;
    expect(pollsWithinCap).toBe((15 * 60) / 4);

    await advance(10 * 60 * 1000);
    expect(voiceApiMocks.getRuns).toHaveBeenCalledTimes(pollsWithinCap);
    expect(channel.sent).toEqual([]);
  });

  it("journals the call transcript in order and closes the journal on hang-up", async () => {
    const channel = await startOpenCall();

    await receive(
      channel,
      { type: "conversation.item.input_audio_transcription.completed", transcript: "  Pull the HTL numbers  " },
      { type: "conversation.item.input_audio_transcription.completed", transcript: "   " },
      { type: "response.output_audio_transcript.delta", delta: "On it" },
      { type: "response.output_audio_transcript.done", transcript: "On it." },
    );
    await act(async () => {
      latestSession!.endCall();
    });

    expect(onTranscript.mock.calls.map(([event]) => event)).toEqual([
      { role: "user", text: "Pull the HTL numbers", final: true },
      { role: "javar", text: "On it", final: false },
      { role: "javar", text: "On it.", final: true },
    ]);
    expect(voiceApiMocks.postJournal.mock.calls).toEqual([
      ["call_1", [{ kind: "user", seq: 1, client_ts: expect.any(Number), text: "Pull the HTL numbers", source: "voice" }]],
      ["call_1", [{ kind: "assistant", seq: 2, client_ts: expect.any(Number), text: "On it.", source: "voice" }]],
      ["call_1", [{ kind: "call_end", seq: 3, client_ts: expect.any(Number) }]],
    ]);

    // A second hang-up does not close the journal twice.
    await act(async () => {
      latestSession!.endCall();
    });
    expect(voiceApiMocks.postJournal).toHaveBeenCalledTimes(3);
  });

  it("writes no journal when the voice server returns no call ID", async () => {
    const channel = await startOpenCall({ ...CALL_SESSION, journal: null });

    await receive(channel, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Hello",
    });
    await act(async () => {
      latestSession!.endCall();
    });

    expect(onTranscript).toHaveBeenCalledWith({ role: "user", text: "Hello", final: true });
    expect(voiceApiMocks.postJournal).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "the microphone is blocked",
      setup: () => {
        // Browsers reject with a DOMException, which is an Error there; jsdom's is not, so build it directly.
        vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(
          Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }),
        );
      },
      session: CALL_SESSION,
      error: "Microphone access was blocked. Allow microphone permission in your browser and try again.",
    },
    {
      name: "the voice server returns no WebRTC session",
      setup: () => {},
      session: { ok: true },
      error: "Voice server did not return a WebRTC session.",
    },
    {
      name: "the Realtime handshake is rejected",
      setup: () => {
        vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
      },
      session: CALL_SESSION,
      error: "Realtime WebRTC handshake failed (401)",
    },
  ])("shows a clear error and fully hangs up when $name", async ({ setup, session, error }) => {
    setup();
    await startCall(session);

    expect(latestSession!.error).toBe(error);
    expect(latestSession!.state).toBe<JavarVoiceState>("idle");
    expect(latestSession!.connected).toBe(false);
    expect(document.querySelectorAll("audio")).toHaveLength(0);
    expect(FakePeerConnection.instances.every((peer) => peer.connectionState === "closed")).toBe(true);
  });

  it("hangs up with a clear error when the connection drops mid-call", async () => {
    const channel = await startOpenCall();
    const peer = FakePeerConnection.instances.at(-1)!;
    expect(latestSession!.state).toBe<JavarVoiceState>("listening");

    await act(async () => {
      peer.connectionState = "failed";
      peer.emit("connectionstatechange");
    });

    expect(latestSession!.error).toBe("Voice connection closed.");
    expect(latestSession!.state).toBe<JavarVoiceState>("idle");
    expect(channel.readyState).toBe("closed");
    expect(voiceApiMocks.postJournal).toHaveBeenCalledWith("call_1", [
      { kind: "call_end", seq: 1, client_ts: expect.any(Number) },
    ]);
  });

  it("cancels Javar's reply when the caller talks over it, and hides the harmless no-active-response error", async () => {
    const channel = await startOpenCall();

    await receive(channel, { type: "input_audio_buffer.speech_started" });
    expect(channel.sent).toEqual([]);
    expect(latestSession!.state).toBe<JavarVoiceState>("listening");

    await receive(channel, { type: "response.created" }, { type: "input_audio_buffer.speech_started" });
    expect(sentEvents(channel)).toEqual([{ type: "response.cancel" }]);

    await receive(channel, { type: "error", error: { message: "Cancellation failed: no active response found" } });
    expect(latestSession!.error).toBeNull();

    await receive(channel, { type: "error", error: { code: "session_expired" } });
    expect(latestSession!.error).toBe("session_expired");
  });
});
