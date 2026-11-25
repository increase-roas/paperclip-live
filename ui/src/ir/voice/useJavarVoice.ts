// Native duplex WebRTC Realtime voice hook for Javar via Paperclip's board-only
// /api/voice/hermes-talk/* proxy.
import { useCallback, useEffect, useRef, useState } from "react";
import { irOpsApi } from "../api/irOps";

export type JavarVoiceState = "idle" | "connecting" | "listening" | "thinking" | "speaking";

export interface VoiceTranscriptEvent {
  role: "user" | "javar";
  text: string;
  final: boolean;
}

export interface VoiceStatusInfo {
  checked: boolean;
  ready: boolean;
  model?: string;
  voice?: string;
  detail?: string;
}

const WORK_STARTED_RE = /WORK_STARTED #(\d+) kind=(\w+)/;
const RUN_POLL_MS = 4_000;
const RUN_POLL_CAP_MS = 15 * 60 * 1000;
const OFFER_TIMEOUT_MS = 20_000;

interface ToolBatchItem {
  output: string;
  message: Record<string, unknown>;
}

interface ToolBatch {
  done: boolean;
  results: Array<ToolBatchItem | null>;
}

export function useJavarVoiceSession(options: {
  onTranscript: (event: VoiceTranscriptEvent) => void;
  active?: boolean;
}) {
  const onTranscriptRef = useRef(options.onTranscript);
  onTranscriptRef.current = options.onTranscript;

  const [state, setState] = useState<JavarVoiceState>("idle");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusInfo, setStatusInfo] = useState<VoiceStatusInfo>({ checked: false, ready: false });

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const closedRef = useRef(true);
  const responseActiveRef = useRef(false);
  const toolBatchRef = useRef<ToolBatch | null>(null);
  const toolTailRef = useRef<Promise<void>>(Promise.resolve());
  const pollTimersRef = useRef<Set<number>>(new Set());
  const watchedRunsRef = useRef<Set<number>>(new Set());
  const journalCallIdRef = useRef<string | null>(null);
  const journalSeqRef = useRef(0);

  const supported =
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof RTCPeerConnection !== "undefined";

  const sendEvent = useCallback((payload: Record<string, unknown>) => {
    const ch = channelRef.current;
    if (!closedRef.current && ch && ch.readyState === "open") {
      ch.send(JSON.stringify(payload));
    }
  }, []);

  const postJournalEvent = useCallback(
    (kind: "user" | "assistant" | "call_end", text?: string) => {
      const callId = journalCallIdRef.current;
      if (!callId) return;
      journalSeqRef.current += 1;
      const event: Record<string, unknown> = {
        kind,
        seq: journalSeqRef.current,
        client_ts: Date.now(),
      };
      if (text) {
        event.text = text;
        event.source = "voice";
      }
      void irOpsApi.voice.postJournal(callId, [event]).catch(() => {});
    },
    [],
  );

  const stop = useCallback(() => {
    closedRef.current = true;
    responseActiveRef.current = false;
    toolBatchRef.current = null;
    for (const id of pollTimersRef.current) window.clearTimeout(id);
    pollTimersRef.current.clear();
    watchedRunsRef.current.clear();

    if (channelRef.current) {
      try {
        channelRef.current.close();
      } catch {
        /* ignore */
      }
      channelRef.current = null;
    }
    if (peerRef.current) {
      try {
        peerRef.current.close();
      } catch {
        /* ignore */
      }
      peerRef.current = null;
    }
    if (mediaRef.current) {
      try {
        mediaRef.current.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      mediaRef.current = null;
    }
    if (audioRef.current) {
      try {
        audioRef.current.srcObject = null;
        audioRef.current.remove();
      } catch {
        /* ignore */
      }
      audioRef.current = null;
    }
    if (journalCallIdRef.current) {
      postJournalEvent("call_end");
      journalCallIdRef.current = null;
      journalSeqRef.current = 0;
    }
    setMuted(false);
    setState("idle");
  }, [postJournalEvent]);

  useEffect(() => {
    if (options.active === false) return;
    let cancelled = false;
    void irOpsApi.voice
      .getStatus()
      .then((res) => {
        if (cancelled) return;
        setStatusInfo({
          checked: true,
          ready: Boolean(res.ok && res.configured !== false),
          model: res.model,
          voice: res.voice,
          detail: res.detail,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setStatusInfo({ checked: true, ready: false });
      });
    return () => {
      cancelled = true;
    };
  }, [options.active]);

  useEffect(() => () => stop(), [stop]);

  const pollRun = useCallback(
    (runId: number, kind: string) => {
      if (closedRef.current || watchedRunsRef.current.has(runId)) return;
      watchedRunsRef.current.add(runId);
      const startedAt = Date.now();
      const tick = async () => {
        if (closedRef.current || Date.now() - startedAt > RUN_POLL_CAP_MS) return;
        let run: { runId?: number; status?: string; kind?: string; output?: string } | null = null;
        try {
          const res = await irOpsApi.voice.getRuns();
          for (const r of res.runs ?? []) {
            if (Number(r.runId) === runId) {
              run = r;
              break;
            }
          }
        } catch {
          if (!closedRef.current) {
            const id = window.setTimeout(() => {
              pollTimersRef.current.delete(id);
              void tick();
            }, RUN_POLL_MS);
            pollTimersRef.current.add(id);
          }
          return;
        }
        if (closedRef.current) return;
        if (!run || run.status === "running" || responseActiveRef.current || toolBatchRef.current) {
          const id = window.setTimeout(() => {
            pollTimersRef.current.delete(id);
            void tick();
          }, RUN_POLL_MS);
          pollTimersRef.current.add(id);
          return;
        }
        const result = run.output || "(no output)";
        sendEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  `Work run #${runId} (${run.kind || kind}) finished with status '${run.status}'. ` +
                  `Result: ${result}\n\nSummarize this aloud in one to three spoken sentences.`,
              },
            ],
          },
        });
        sendEvent({ type: "response.create" });
        const followOn = WORK_STARTED_RE.exec(result);
        if (followOn) pollRun(Number(followOn[1]), followOn[2]);
      };
      const id = window.setTimeout(() => {
        pollTimersRef.current.delete(id);
        void tick();
      }, RUN_POLL_MS);
      pollTimersRef.current.add(id);
    },
    [sendEvent],
  );

  const flushToolBatch = useCallback(
    (batch: ToolBatch) => {
      if (closedRef.current || toolBatchRef.current !== batch || !batch.done || batch.results.some((x) => !x)) {
        return;
      }
      for (const item of batch.results) {
        if (item) sendEvent(item.message);
      }
      sendEvent({ type: "response.create" });
      for (const item of batch.results) {
        if (item) {
          const m = WORK_STARTED_RE.exec(item.output);
          if (m) pollRun(Number(m[1]), m[2]);
        }
      }
      toolBatchRef.current = null;
    },
    [pollRun, sendEvent],
  );

  const enqueueToolCall = useCallback(
    (event: { call_id?: string; name?: string; arguments?: string }) => {
      const callId = typeof event.call_id === "string" ? event.call_id : "";
      const name = typeof event.name === "string" ? event.name : "";
      if (!callId || !name) return;
      if (!toolBatchRef.current) toolBatchRef.current = { done: false, results: [] };
      const batch = toolBatchRef.current;
      const pos = batch.results.length;
      batch.results.push(null);

      toolTailRef.current = toolTailRef.current.then(async () => {
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(event.arguments || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          /* execute with empty args */
        }
        let output = "";
        try {
          setState("thinking");
          const res = await irOpsApi.voice.runTool(name, args);
          output = res && res.output ? String(res.output) : "(no output)";
        } catch (err) {
          output = `${name} failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        if (closedRef.current) return;
        batch.results[pos] = {
          output,
          message: {
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: callId, output },
          },
        };
        flushToolBatch(batch);
      });
    },
    [flushToolBatch],
  );

  const handleRealtimeEvent = useCallback(
    (raw: string) => {
      if (closedRef.current) return;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (ev.type) {
        case "input_audio_buffer.speech_started":
          setState("listening");
          if (responseActiveRef.current) sendEvent({ type: "response.cancel" });
          return;
        case "input_audio_buffer.speech_stopped":
          setState("thinking");
          return;
        case "conversation.item.input_audio_transcription.completed":
          if (typeof ev.transcript === "string" && ev.transcript.trim()) {
            const text = ev.transcript.trim();
            onTranscriptRef.current({ role: "user", text, final: true });
            postJournalEvent("user", text);
          }
          return;
        case "response.output_audio_transcript.delta":
          if (typeof ev.delta === "string" && ev.delta) {
            setState("speaking");
            onTranscriptRef.current({ role: "javar", text: ev.delta, final: false });
          }
          return;
        case "response.output_audio_transcript.done":
          if (typeof ev.transcript === "string" && ev.transcript.trim()) {
            const text = ev.transcript.trim();
            onTranscriptRef.current({ role: "javar", text, final: true });
            postJournalEvent("assistant", text);
          }
          return;
        case "response.created":
          responseActiveRef.current = true;
          setState("thinking");
          return;
        case "output_audio_buffer.started":
          setState("speaking");
          return;
        case "output_audio_buffer.stopped":
        case "output_audio_buffer.cleared":
          if (!responseActiveRef.current) setState("listening");
          return;
        case "response.done":
          responseActiveRef.current = false;
          if (toolBatchRef.current) {
            toolBatchRef.current.done = true;
            flushToolBatch(toolBatchRef.current);
          }
          setState("listening");
          return;
        case "response.function_call_arguments.done":
          enqueueToolCall(ev as { call_id?: string; name?: string; arguments?: string });
          return;
        case "error": {
          const errObj = ev.error as { message?: string; code?: string } | undefined;
          const msg = String(errObj?.message || errObj?.code || "Realtime voice error");
          if (!msg.toLowerCase().includes("no active response")) setError(msg);
          return;
        }
        default:
          return;
      }
    },
    [enqueueToolCall, flushToolBatch, postJournalEvent, sendEvent],
  );

  const start = useCallback(async () => {
    if (!supported) {
      setError("This browser does not support live microphone calls.");
      return;
    }
    if (peerRef.current || mediaRef.current || audioRef.current) {
      return;
    }
    setError(null);
    closedRef.current = false;
    setState("connecting");

    try {
      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.setAttribute("playsinline", "true");
      (audioEl as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
      audioEl.className = "hidden";
      document.body.appendChild(audioEl);
      audioRef.current = audioEl;

      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (closedRef.current) {
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      mediaRef.current = media;

      const session = await irOpsApi.voice.createSession();
      if (closedRef.current) return;
      if (!session.clientSecret || !session.offerUrl) {
        throw new Error("Voice server did not return a WebRTC session.");
      }
      journalSeqRef.current = 0;
      journalCallIdRef.current =
        typeof session.journal?.callId === "string" && session.journal.callId
          ? session.journal.callId
          : null;

      const peer = new RTCPeerConnection();
      peerRef.current = peer;

      peer.addEventListener("track", (event) => {
        const stream = event.streams[0];
        if (audioRef.current && stream) {
          audioRef.current.srcObject = stream;
          void audioRef.current.play().catch(() => {});
        }
      });

      media.getAudioTracks().forEach((track) => peer.addTrack(track, media));

      const channel = peer.createDataChannel("oai-events");
      channelRef.current = channel;
      channel.addEventListener("open", () => {
        if (!closedRef.current) setState("listening");
      });
      channel.addEventListener("message", (ev) => handleRealtimeEvent(String(ev.data)));

      peer.addEventListener("connectionstatechange", () => {
        if (closedRef.current) return;
        if (peer.connectionState === "failed" || peer.connectionState === "closed") {
          setError("Voice connection closed.");
          stop();
        }
      });

      const offer = await peer.createOffer();
      if (closedRef.current) return;
      await peer.setLocalDescription(offer);
      if (closedRef.current) return;

      const sdpCtrl = new AbortController();
      const sdpTimer = window.setTimeout(() => sdpCtrl.abort(), OFFER_TIMEOUT_MS);
      let answerSdp = "";
      try {
        const sdpRes = await fetch(session.offerUrl, {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${session.clientSecret}`,
            "Content-Type": "application/sdp",
          },
          signal: sdpCtrl.signal,
        });
        if (!sdpRes.ok) throw new Error(`Realtime WebRTC handshake failed (${sdpRes.status})`);
        answerSdp = await sdpRes.text();
      } finally {
        window.clearTimeout(sdpTimer);
      }

      if (closedRef.current) return;
      await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
      setStatusInfo((prev) => ({
        ...prev,
        checked: true,
        ready: true,
        model: session.model ?? prev.model,
        voice: session.voice ?? prev.voice,
      }));
    } catch (caught) {
      const msg =
        caught instanceof Error && caught.name === "NotAllowedError"
          ? "Microphone access was blocked. Allow microphone permission in your browser and try again."
          : caught instanceof Error
            ? caught.message
            : "Could not start live voice.";
      setError(msg);
      stop();
    }
  }, [handleRealtimeEvent, stop, supported]);

  const toggleCall = useCallback(() => {
    if (state === "idle") void start();
    else stop();
  }, [start, state, stop]);

  const toggleMute = useCallback(() => {
    const stream = mediaRef.current;
    if (!stream) return;
    const nextMuted = !muted;
    stream.getAudioTracks().forEach((t) => {
      t.enabled = !nextMuted;
    });
    setMuted(nextMuted);
  }, [muted]);

  const dismissError = useCallback(() => setError(null), []);

  const connected = state !== "idle";

  return {
    state,
    connected,
    muted,
    error,
    supported,
    statusInfo,
    toggleCall,
    toggleMute,
    endCall: stop,
    dismissError,
  };
}
