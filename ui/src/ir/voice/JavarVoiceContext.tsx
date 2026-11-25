import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import {
  useJavarVoiceSession,
  type JavarVoiceState,
  type VoiceStatusInfo,
  type VoiceTranscriptEvent,
} from "./useJavarVoice";

export interface VoiceTranscriptEntry {
  id: string;
  role: "user" | "javar";
  text: string;
  final: boolean;
}

export interface JavarVoiceContextValue {
  state: JavarVoiceState;
  connected: boolean;
  muted: boolean;
  error: string | null;
  supported: boolean;
  statusInfo: VoiceStatusInfo;
  transcript: VoiceTranscriptEntry[];
  transcriptOpen: boolean;
  setTranscriptOpen: (open: boolean) => void;
  toggleCall: () => void;
  toggleMute: () => void;
  endCall: () => void;
  dismissError: () => void;
  clearTranscript: () => void;
}

const JavarVoiceContext = createContext<JavarVoiceContextValue | null>(null);

const MAX_TRANSCRIPT_ENTRIES = 60;

export function JavarVoiceProvider({ children }: { children: ReactNode }) {
  const [transcript, setTranscript] = useState<VoiceTranscriptEntry[]>([]);
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  const handleTranscript = useCallback((event: VoiceTranscriptEvent) => {
    setTranscript((prev) => {
      if (event.role === "javar" && !event.final) {
        const last = prev[prev.length - 1];
        if (last && last.role === "javar" && !last.final) {
          return [...prev.slice(0, -1), { ...last, text: `${last.text}${event.text}` }];
        }
        const next: VoiceTranscriptEntry = {
          id: `voice-${Date.now()}-${prev.length}`,
          role: "javar",
          text: event.text,
          final: false,
        };
        return [...prev, next].slice(-MAX_TRANSCRIPT_ENTRIES);
      }

      if (event.role === "javar" && event.final) {
        const last = prev[prev.length - 1];
        if (last && last.role === "javar" && !last.final) {
          return [...prev.slice(0, -1), { ...last, text: event.text, final: true }];
        }
      }

      const next: VoiceTranscriptEntry = {
        id: `voice-${Date.now()}-${prev.length}`,
        role: event.role,
        text: event.text,
        final: event.final,
      };
      return [...prev, next].slice(-MAX_TRANSCRIPT_ENTRIES);
    });
  }, []);

  const session = useJavarVoiceSession({ onTranscript: handleTranscript });

  const toggleCall = useCallback(() => {
    if (!session.connected) {
      setTranscript([]);
    }
    session.toggleCall();
  }, [session]);

  const clearTranscript = useCallback(() => setTranscript([]), []);

  const value = useMemo<JavarVoiceContextValue>(
    () => ({
      ...session,
      transcript,
      transcriptOpen,
      setTranscriptOpen,
      toggleCall,
      clearTranscript,
    }),
    [session, transcript, transcriptOpen, toggleCall, clearTranscript],
  );

  return <JavarVoiceContext.Provider value={value}>{children}</JavarVoiceContext.Provider>;
}

export function useJavarVoice(): JavarVoiceContextValue {
  const ctx = useContext(JavarVoiceContext);
  if (!ctx) {
    throw new Error("useJavarVoice must be used within a JavarVoiceProvider");
  }
  return ctx;
}

export function useOptionalJavarVoice(): JavarVoiceContextValue | null {
  return useContext(JavarVoiceContext);
}
