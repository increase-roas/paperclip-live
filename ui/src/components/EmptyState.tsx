import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon: LucideIcon;
  /** Large decorative artwork; shares hover/focus with the action below. */
  graphic?: ReactNode;
  /** Optional bold heading rendered above the message. */
  title?: string;
  message: string;
  /** Optional secondary line rendered under the primary message. */
  description?: string;
  action?: string;
  onAction?: () => void;
  /** Icon for the primary action; defaults to the create glyph. */
  actionIcon?: LucideIcon;
  /** Hide the leading "+" glyph on the action button (e.g. for a "Set up" CTA). */
  hideActionIcon?: boolean;
  /** Optional escape hatch rendered as a quieter action below the primary one. */
  secondaryAction?: string;
  onSecondaryAction?: () => void;
}

export function EmptyState({
  icon: Icon,
  graphic,
  title,
  message,
  description,
  action,
  onAction,
  actionIcon: ActionIcon = Plus,
  hideActionIcon = false,
  secondaryAction,
  onSecondaryAction,
}: EmptyStateProps) {
  return (
    <div className={graphic ? "empty-state-artwork flex flex-col items-center justify-center gap-5 py-16 text-center" : "flex flex-col items-center justify-center py-16 text-center"}>
      {graphic ? <div className="empty-state-graphic" aria-hidden="true">{graphic}</div> : <div className="bg-muted/50 p-4 mb-4">
        <Icon className="h-10 w-10 text-muted-foreground/50" />
      </div>}
      {title ? (
        <>
          <p className="text-base font-semibold text-foreground mb-1.5">{title}</p>
          <p className="text-sm text-muted-foreground mb-4 max-w-md">{message}</p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-foreground mb-1">{message}</p>
          {description && <p className="max-w-md text-sm text-muted-foreground mb-4">{description}</p>}
        </>
      )}
      {(action && onAction) || (secondaryAction && onSecondaryAction) ? (
        <div className="flex flex-col items-center gap-2">
          {action && onAction && (
            <Button onClick={onAction}>
              {!hideActionIcon && <ActionIcon className="h-4 w-4 mr-1.5" />}
              {action}
            </Button>
          )}
          {secondaryAction && onSecondaryAction && (
            <Button variant="outline" onClick={onSecondaryAction}>
              {secondaryAction}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
