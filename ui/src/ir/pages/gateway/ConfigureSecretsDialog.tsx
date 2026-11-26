import { useEffect, useState } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound, ShieldAlert } from "lucide-react";
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
import { IrApiError, irOpsApi } from "../../api/irOps";

export interface ProviderSecretSchema {
  provider: string;
  label: string;
  redirectUri?: string;
  fields: Array<{ key: string; label: string; placeholder?: string }>;
}

interface ConfigureSecretsDialogProps {
  open: boolean;
  schema: ProviderSecretSchema | null;
  workerName: string;
  writerConfigured: boolean;
  onClose: () => void;
  onSaved: (providerLabel: string, updatedKeys: string[]) => void;
}

export function ConfigureSecretsDialog({
  open,
  schema,
  workerName,
  writerConfigured,
  onClose,
  onSaved,
}: ConfigureSecretsDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [copiedUri, setCopiedUri] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setValues({});
      setRevealed({});
      setCopiedUri(false);
      setError(null);
      setSaving(false);
    }
  }, [open, schema?.provider]);

  if (!schema) return null;

  const filledEntries = schema.fields
    .map((f) => [f.key, (values[f.key] ?? "").trim()] as const)
    .filter(([, val]) => val.length > 0);

  const handleCopyRedirect = async () => {
    if (!schema.redirectUri) return;
    try {
      await navigator.clipboard.writeText(schema.redirectUri);
      setCopiedUri(true);
      window.setTimeout(() => setCopiedUri(false), 1800);
    } catch {
      // Clipboard may be unavailable in non-HTTPS dev contexts
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!writerConfigured || filledEntries.length === 0) return;

    setSaving(true);
    setError(null);
    try {
      const payload = Object.fromEntries(filledEntries);
      const res = await irOpsApi.gateway.saveProviderSecrets(schema.provider, payload);
      setValues({});
      onSaved(schema.label, res.updatedKeys);
      onClose();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : `Failed to bind ${schema.label} credentials on ${workerName}.`;
      // A multi-key save can fail partway; say which keys already landed.
      const written = err instanceof IrApiError ? err.body?.updatedKeys : undefined;
      const writtenKeys = Array.isArray(written)
        ? written.filter((k): k is string => typeof k === "string")
        : [];
      setError(
        writtenKeys.length > 0
          ? `${message} Already saved: ${writtenKeys.join(", ")}. Save the remaining fields again.`
          : message,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" />
            Configure {schema.label}
          </DialogTitle>
          <DialogDescription>
            Credentials are pushed directly to Cloudflare Worker{" "}
            <span className="font-mono text-foreground">{workerName}</span> as encrypted
            secrets and are never stored in Paperclip&apos;s database. Leading and trailing
            spaces are trimmed; leave a field blank to keep its current value.
          </DialogDescription>
        </DialogHeader>

        {!writerConfigured && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-200"
          >
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-400" />
            <div>
              <p className="font-medium text-amber-100">Cloudflare secret writer not configured</p>
              <p className="mt-0.5 text-amber-200/90">
                Set <code className="font-mono">CLOUDFLARE_API_TOKEN</code> (scoped to{" "}
                <code className="font-mono">Workers Scripts: Edit</code>) on the Paperclip server
                to enable direct 1-place key binding.
              </p>
            </div>
          </div>
        )}

        {schema.redirectUri && (
          <div className="space-y-1.5 rounded-md border border-border bg-muted/40 p-3">
            <Label className="text-xs text-muted-foreground">OAuth Callback / Redirect URI</Label>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-background px-2 py-1 font-mono text-xs text-foreground">
                {schema.redirectUri}
              </code>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void handleCopyRedirect()}
              >
                {copiedUri ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
                {copiedUri ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
          {schema.fields.map((field) => {
            const isRevealed = Boolean(revealed[field.key]);
            return (
              <div key={field.key} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor={`secret-${field.key}`} className="text-xs">
                    {field.label}
                  </Label>
                  <span className="font-mono text-[11px] text-muted-foreground">{field.key}</span>
                </div>
                <div className="relative">
                  <Input
                    id={`secret-${field.key}`}
                    type={isRevealed ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={!writerConfigured || saving}
                    placeholder={field.placeholder ?? `Paste ${field.label}`}
                    value={values[field.key] ?? ""}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    className="pr-9 font-mono text-xs"
                  />
                  <button
                    type="button"
                    aria-label={isRevealed ? `Hide ${field.label}` : `Show ${field.label}`}
                    onClick={() =>
                      setRevealed((prev) => ({ ...prev, [field.key]: !prev[field.key] }))
                    }
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {isRevealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>
              </div>
            );
          })}

          {error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </div>
          )}

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" size="sm" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!writerConfigured || saving || filledEntries.length === 0}
            >
              {saving ? "Binding on Cloudflare…" : "Save to Gateway"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
