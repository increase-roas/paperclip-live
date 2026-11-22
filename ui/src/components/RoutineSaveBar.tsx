import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { RoutineHistoryDirtyFieldDescriptor } from "./RoutineHistoryTab";

/**
 * What stops a routine save before it reaches the server.
 *
 * The title is required on every editable section because the request sends
 * the whole draft. Without this the save button and Cmd+S silently did
 * nothing when the title was empty.
 */
export function routineSaveBlockedReason(title: string): string | null {
  return title.trim() ? null : "Add a title before saving.";
}

/**
 * Per-section sticky save bar (§1.4–§1.5). Hidden when clean; reveals on dirty.
 * On a 409 it swaps to the conflict-recovery surface ("Reload latest" /
 * "Overwrite anyway"). Wires ⌘/Ctrl+S → save and Esc → discard-with-confirm.
 */
export function RoutineSaveBar({
  dirtyFields,
  isSaving,
  saveConflict,
  onSave,
  onDiscard,
  onReload,
  disabled,
  blockedReason,
}: {
  dirtyFields: RoutineHistoryDirtyFieldDescriptor[];
  isSaving: boolean;
  saveConflict: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onReload: () => void;
  disabled?: boolean;
  /** A field-level reason the draft cannot be saved yet. Shown and announced. */
  blockedReason?: string | null;
}) {
  const dirtyCount = dirtyFields.length;
  const isDirty = dirtyCount > 0;
  const isBlocked = Boolean(blockedReason);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

  useEffect(() => {
    if (!isDirty && !saveConflict) return;
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!isSaving && !disabled && !isBlocked) onSave();
      } else if (event.key === "Escape" && isDirty) {
        event.preventDefault();
        setConfirmDiscardOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isDirty, saveConflict, isSaving, disabled, isBlocked, onSave]);

  if (!isDirty && !saveConflict) return null;

  return (
    <>
      <div
        className={cn(
          "sticky bottom-0 z-10 -mx-8 mt-6 flex h-14 items-center justify-between border-t px-8 backdrop-blur",
          "motion-safe:transition-colors motion-safe:duration-200",
          "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2",
          saveConflict
            ? "border-amber-500/30 bg-amber-500/5"
            : "border-border bg-background/95",
        )}
      >
        {saveConflict ? (
          <div className="flex items-center gap-2 text-sm text-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4" />
            <span>Routine changed elsewhere. Reload to merge.</span>
          </div>
        ) : (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 text-sm text-foreground hover:text-foreground"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                <span className="font-medium">
                  {dirtyCount} unsaved {dirtyCount === 1 ? "change" : "changes"}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Pending changes
              </p>
              <ul className="space-y-1 text-sm">
                {dirtyFields.map((field) => (
                  <li key={field.key} className="flex items-center gap-2">
                    <span className="h-1 w-1 rounded-full bg-amber-500" />
                    <span className="capitalize">{field.label}</span>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        )}

        <div className="flex items-center gap-2">
          {blockedReason ? (
            <p id="routine-save-blocked-reason" role="alert" className="text-xs text-destructive">
              {blockedReason}
            </p>
          ) : null}
          {saveConflict ? (
            <>
              <Button variant="outline" size="sm" onClick={onReload}>
                Reload latest
              </Button>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={isSaving || disabled || isBlocked}
                      aria-describedby={isBlocked ? "routine-save-blocked-reason" : undefined}
                      onClick={onSave}
                    >
                      {isSaving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                      Overwrite anyway
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Replaces the newer revision with your local edits.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={isSaving || disabled}
                onClick={() => setConfirmDiscardOpen(true)}
              >
                Discard
              </Button>
              <Button
                size="sm"
                disabled={isSaving || disabled || isBlocked}
                aria-describedby={isBlocked ? "routine-save-blocked-reason" : undefined}
                onClick={onSave}
              >
                {isSaving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Save changes
                <kbd className="ml-2 hidden rounded bg-foreground/10 px-1 text-(length:--text-nano) font-medium sm:inline">
                  ⌘S
                </kbd>
              </Button>
            </>
          )}
        </div>
      </div>

      <Dialog open={confirmDiscardOpen} onOpenChange={setConfirmDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              This will revert {dirtyCount} unsaved{" "}
              {dirtyCount === 1 ? "change" : "changes"} in this section.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDiscardOpen(false)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                onDiscard();
                setConfirmDiscardOpen(false);
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Read-only strip for non-owners on editable sections (§1.6). */
export function RoutineReadOnlyStrip() {
  return (
    <div className="-mx-8 mt-6 border-t border-border bg-muted/20 px-8 py-3 text-xs text-muted-foreground">
      Read-only — you don't own this routine.
    </div>
  );
}
