import { useEffect, useRef } from "react";
import { MessageSquareText, Mic, MicOff, PhoneOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useOptionalJavarVoice } from "./JavarVoiceContext";
import type { JavarVoiceState } from "./useJavarVoice";

function voiceStateLabel(state: JavarVoiceState, muted: boolean): string {
  if (state === "connecting") return "Connecting to Javar…";
  if (muted) return "Microphone muted";
  if (state === "speaking") return "Javar speaking";
  if (state === "thinking") return "Javar thinking…";
  if (state === "listening") return "Listening";
  return "Voice ready";
}

/**
 * Compact bottom-right floating voice call dock.
 * Renders only when a live call is connecting/active or an inline voice error needs dismissal.
 * Text chat remains strictly at /chats/javar — zero duplicate chat input here.
 */
export function JavarVoiceDock() {
  const voice = useOptionalJavarVoice();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const transcriptCount = voice?.transcript.length ?? 0;
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcriptCount, voice?.transcriptOpen]);

  if (!voice) return null;
  if (!voice.connected && !voice.error) return null;

  return (
    <aside
      aria-label="Javar live voice call"
      className="fixed bottom-4 right-4 z-50 flex w-80 max-w-full flex-col gap-2"
    >
      {voice.connected && voice.transcriptOpen && (
        <Card className="gap-0 overflow-hidden border-border bg-card py-0 shadow-sm">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-semibold text-foreground">Live transcript</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Hide transcript"
              onClick={() => voice.setTranscriptOpen(false)}
            >
              <X className="size-3.5" />
            </Button>
          </div>
          <div
            ref={scrollRef}
            className="max-h-56 space-y-2 overflow-y-auto px-3 py-2.5 text-xs"
          >
            {voice.transcript.length === 0 ? (
              <p className="text-muted-foreground">Speak naturally — Javar is listening.</p>
            ) : (
              voice.transcript.map((entry) => (
                <div
                  key={entry.id}
                  className={cn(
                    "rounded-md px-2.5 py-1.5 leading-relaxed",
                    entry.role === "user"
                      ? "ml-6 bg-accent text-accent-foreground"
                      : "mr-6 bg-muted text-foreground",
                  )}
                >
                  <div className="mb-0.5 text-xs font-medium text-muted-foreground">
                    {entry.role === "user" ? "You" : "Javar"}
                  </div>
                  <p className="whitespace-pre-wrap break-words">{entry.text}</p>
                </div>
              ))
            )}
          </div>
        </Card>
      )}

      {voice.error && (
        <Card className="gap-0 border-destructive/40 bg-card py-0 shadow-sm">
          <CardContent className="flex items-start justify-between gap-2 px-3 py-2.5">
            <div className="min-w-0 flex-1 text-xs text-destructive" role="alert">
              {voice.error}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss voice error"
              onClick={voice.dismissError}
            >
              <X className="size-3.5" />
            </Button>
          </CardContent>
        </Card>
      )}

      {voice.connected && (
        <Card className="gap-0 border-border bg-card py-0 shadow-sm">
          <CardContent className="flex items-center justify-between gap-2 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
                <span
                  className={cn(
                    "absolute inline-flex h-full w-full rounded-full opacity-75",
                    voice.muted
                      ? "bg-muted-foreground"
                      : voice.state === "speaking" || voice.state === "listening"
                        ? "animate-ping bg-ring"
                        : "animate-pulse bg-ring",
                  )}
                />
                <span
                  className={cn(
                    "relative inline-flex size-2.5 rounded-full",
                    voice.muted ? "bg-muted-foreground" : "bg-ring",
                  )}
                />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-semibold text-foreground">Javar</span>
                  <Badge variant="secondary" className="px-1.5 py-0 text-xs font-normal">
                    {voiceStateLabel(voice.state, voice.muted)}
                  </Badge>
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant={voice.transcriptOpen ? "secondary" : "ghost"}
                size="icon-xs"
                aria-label={voice.transcriptOpen ? "Hide transcript" : "Show transcript"}
                title={voice.transcriptOpen ? "Hide transcript" : "Show transcript"}
                onClick={() => voice.setTranscriptOpen(!voice.transcriptOpen)}
              >
                <MessageSquareText className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant={voice.muted ? "secondary" : "ghost"}
                size="icon-xs"
                aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}
                title={voice.muted ? "Unmute microphone" : "Mute microphone"}
                onClick={voice.toggleMute}
              >
                {voice.muted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="icon-xs"
                aria-label="End voice call"
                title="End voice call"
                onClick={voice.endCall}
              >
                <PhoneOff className="size-3.5" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </aside>
  );
}
