import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { irOpsApi } from "../../api/irOps";
import { parseMultiLineScopes } from "./gatewayHelpers";

interface AddScopeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  integrationId: string;
  integrationLabel: string;
  onAdded: (result: { addedCount: number; pendingReauth: boolean }) => void;
}

export function AddScopeDialog({
  open,
  onOpenChange,
  integrationId,
  integrationLabel,
  onAdded,
}: AddScopeDialogProps) {
  const [rawScopes, setRawScopes] = useState("");
  const [group, setGroup] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setRawScopes("");
      setGroup("");
      setError(null);
    }
  }, [open, integrationId]);

  const parsed = useMemo(() => parseMultiLineScopes(rawScopes), [rawScopes]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (parsed.length === 0) {
      setError("Paste at least one scope identifier.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await irOpsApi.gateway.addScopes(integrationId, {
        scopes: parsed.map((item) => ({
          id: item.id,
          access: item.access,
          ...(group.trim() ? { group: group.trim() } : {}),
        })),
      });
      const addedCount = res.added ?? parsed.length;
      const pendingReauth = res.pendingReauth ?? integrationId === "ghl";
      setRawScopes("");
      setGroup("");
      onOpenChange(false);
      onAdded({ addedCount, pendingReauth });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add scopes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add scopes to {integrationLabel}</DialogTitle>
          <DialogDescription>
            Paste one or more scope IDs (newline or space separated). Access level is inferred
            automatically from each scope name.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="add-scopes-input" className="text-xs">
              Scope identifiers
            </Label>
            <Textarea
              id="add-scopes-input"
              rows={5}
              value={rawScopes}
              onChange={(e) => {
                setRawScopes(e.target.value);
                setError(null);
              }}
              placeholder={
                integrationId === "ghl"
                  ? "contacts.readonly\ncontacts.write\nopportunities.write"
                  : "scope.read\nscope.write"
              }
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="add-scopes-group" className="text-xs">
              Group label (optional)
            </Label>
            <Input
              id="add-scopes-group"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="e.g. Contacts, Funnels, Billing"
            />
          </div>

          {parsed.length > 0 && (
            <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3">
              <div className="text-xs font-medium text-muted-foreground">
                Preview ({parsed.length} scope{parsed.length === 1 ? "" : "s"})
              </div>
              <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                {parsed.map((item) => (
                  <Badge
                    key={item.id}
                    variant="outline"
                    className="gap-1.5 font-mono text-xs font-normal"
                  >
                    <span>{item.id}</span>
                    <span className="text-muted-foreground">· {item.access}</span>
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {integrationId === "ghl" && (
            <p className="text-xs text-muted-foreground">
              New GoHighLevel scopes are saved as pending until you complete the agency OAuth
              re-authorization flow.
            </p>
          )}

          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}

          <DialogFooter className="flex-row items-center justify-between sm:justify-between">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || parsed.length === 0}>
              {saving
                ? "Adding…"
                : `Add ${parsed.length || ""} scope${parsed.length === 1 ? "" : "s"}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
