import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Eye,
  FileCode2,
  Plus,
  Save,
  Search,
} from "lucide-react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { irOpsApi, type WorkflowItem } from "../api/irOps";

const PROFILE_OPTIONS = [
  "general",
  "research",
  "ads-checker",
  "engineer",
  "website-builder",
  "reviewer",
  "upkeep",
  "scribe",
] as const;

export function buildAgentWikiSopTemplate(input: {
  name: string;
  profile: string;
  trigger: string;
  inputs: string;
  steps: string;
  approvals: string;
}): string {
  const today = new Date().toISOString().slice(0, 10);
  const inputLines =
    input.inputs
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (line.startsWith("-") ? line : `- ${line}`))
      .join("\n") || "- Specify required inputs (fail closed if missing).";

  const stepLines =
    input.steps
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, idx) => (/^\d+\./.test(line) ? line : `${idx + 1}. ${line}`))
      .join("\n") || "1. Execute deterministic tool or API step.\n2. Verify live output.";

  const approvalLines =
    input.approvals
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (line.startsWith("-") ? line : `- ${line}`))
      .join("\n") ||
    "- Pause for explicit operator approval before any spend, publish, external message, or destructive action.";

  return `# ${input.name.trim()}

- **Workflow Name:** ${input.name.trim()}
- **Owner Profile:** \`${input.profile}\`
- **Trigger:** ${input.trigger.trim() || "Voice request or Paperclip task"}
- **Last Updated:** ${today}

## 1. Required Inputs (Fail Closed If Missing)
${inputLines}

## 2. Deterministic Steps (Code/Tools First)
${stepLines}

## 3. Verification & Evidence Gate
- Verify against real live output (API receipt, URL, screenshot, or passing test) before reporting done.

## 4. Human-Approval Checkpoints
${approvalLines}

## 5. Failure & Stall Escalation
- If any step fails twice or stalls for more than 15 minutes, stop retrying and escalate to the operator in Paperclip with the exact blocker and last successful step.
`;
}

function relativeFolderBadge(path: string, profile: string): string {
  const slashIdx = path.indexOf("/");
  if (slashIdx > 0) return path.slice(0, slashIdx);
  return profile || "general";
}

function formatUpdatedAt(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  const ms = ts > 1_000_000_000_000 ? ts : ts * 1000;
  return new Date(ms).toLocaleString();
}

export function WorkflowsPage() {
  const { setBreadcrumbs } = useBreadcrumbs();

  const [items, setItems] = useState<WorkflowItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [profileFilter, setProfileFilter] = useState<string>("all");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const [savedContent, setSavedContent] = useState("");
  const [content, setContent] = useState("");
  const [readingFile, setReadingFile] = useState(false);
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Create new workflow dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newProfile, setNewProfile] = useState<string>("general");
  const [newTrigger, setNewTrigger] = useState("");
  const [newInputs, setNewInputs] = useState("");
  const [newSteps, setNewSteps] = useState("");
  const [newApprovals, setNewApprovals] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Workflows & SOPs" }]);
  }, [setBreadcrumbs]);

  const loadList = useCallback(async (preferredPath?: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await irOpsApi.workflows.list();
      const list = Array.isArray(res.workflows) ? res.workflows : [];
      setItems(list);
      setSelectedPath((current) => {
        const target = preferredPath ?? current;
        if (target && list.some((item) => item.path === target)) return target;
        return list[0]?.path ?? null;
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load workflows.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const justCreatedPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedPath) {
      setContent("");
      setSavedContent("");
      return;
    }
    if (justCreatedPathRef.current === selectedPath) {
      justCreatedPathRef.current = null;
      return;
    }
    let active = true;
    setReadingFile(true);
    setNotice(null);
    setActionError(null);
    irOpsApi.workflows
      .read(selectedPath)
      .then((res) => {
        if (!active) return;
        const body = res.content ?? "";
        setContent(body);
        setSavedContent(body);
      })
      .catch((err) => {
        if (!active) return;
        setActionError(err instanceof Error ? err.message : "Could not read workflow playbook.");
      })
      .finally(() => {
        if (active) setReadingFile(false);
      });
    return () => {
      active = false;
    };
  }, [selectedPath]);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      if (profileFilter !== "all" && item.profile !== profileFilter) return false;
      if (
        q &&
        !item.title.toLowerCase().includes(q) &&
        !item.path.toLowerCase().includes(q) &&
        !item.profile.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [items, search, profileFilter]);

  const selectedItem = useMemo(
    () => items.find((item) => item.path === selectedPath) ?? null,
    [items, selectedPath],
  );

  const hasUnsavedChanges = selectedPath !== null && content !== savedContent;

  const handleSave = async () => {
    if (!selectedPath) return;
    setSaving(true);
    setNotice(null);
    setActionError(null);
    try {
      await irOpsApi.workflows.save(selectedPath, content);
      setSavedContent(content);
      setNotice("Saved & synced to GBrain. All agents now read this version.");
      void loadList(selectedPath);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not save workflow.");
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!newName.trim()) {
      setCreateError("Give the workflow a name first.");
      return;
    }
    const slug =
      newName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "workflow";
    const relPath = `${newProfile}/${slug}.md`;
    const formatted = buildAgentWikiSopTemplate({
      name: newName,
      profile: newProfile,
      trigger: newTrigger,
      inputs: newInputs,
      steps: newSteps,
      approvals: newApprovals,
    });

    setSaving(true);
    setCreateError(null);
    try {
      await irOpsApi.workflows.save(relPath, formatted);
      setCreateOpen(false);
      setNewName("");
      setNewTrigger("");
      setNewInputs("");
      setNewSteps("");
      setNewApprovals("");
      justCreatedPathRef.current = relPath;
      setSelectedPath(relPath);
      setContent(formatted);
      setSavedContent(formatted);
      setMode("preview");
      setNotice(`Created ${relPath} and synced to GBrain.`);
      void loadList(relPath);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create workflow.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">Workflows & SOPs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Single source of truth for agent playbooks, formatted to AgentWiki standard and synced to GBrain.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setCreateError(null);
            setCreateOpen(true);
          }}
        >
          <Plus className="size-3.5" />
          New workflow
        </Button>
      </header>

      {loadError && (
        <Card className="border-destructive/40 bg-destructive/5 py-4">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 px-4">
            <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
              <AlertTriangle className="size-4 shrink-0" />
              <span>{loadError}</span>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadList()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left Playbook Rail */}
        <Card className="gap-0 py-0 lg:col-span-4">
          <CardHeader className="gap-3 border-b border-border px-4 py-3.5">
            <CardTitle className="text-sm font-semibold">
              Playbooks ({filteredItems.length})
            </CardTitle>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search playbooks…"
                className="h-8 pl-8 text-xs"
              />
            </div>
            <div className="flex flex-wrap gap-1">
              <Button
                type="button"
                size="xs"
                variant={profileFilter === "all" ? "secondary" : "ghost"}
                onClick={() => setProfileFilter("all")}
              >
                All
              </Button>
              {PROFILE_OPTIONS.map((profile) => (
                <Button
                  key={profile}
                  type="button"
                  size="xs"
                  variant={profileFilter === profile ? "secondary" : "ghost"}
                  onClick={() => setProfileFilter(profile)}
                >
                  {profile}
                </Button>
              ))}
            </div>
          </CardHeader>

          <CardContent className="max-h-160 divide-y divide-border overflow-y-auto px-0">
            {loading ? (
              <div className="space-y-2.5 p-4">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No playbooks match your filter.
              </div>
            ) : (
              filteredItems.map((item) => {
                const active = item.path === selectedPath;
                return (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => {
                      if (
                        item.path !== selectedPath &&
                        hasUnsavedChanges &&
                        !window.confirm("You have unsaved changes. Discard them and switch playbooks?")
                      ) {
                        return;
                      }
                      setSelectedPath(item.path);
                    }}
                    className={cn(
                      "flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors",
                      active ? "bg-accent/70" : "hover:bg-accent/35",
                    )}
                  >
                    <div className="truncate text-sm font-medium text-foreground">{item.title}</div>
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="outline" className="font-mono text-xs font-normal text-muted-foreground">
                        {relativeFolderBadge(item.path, item.profile)}
                      </Badge>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {item.path.split("/").pop()}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </CardContent>
        </Card>

        {/* Right Preview / Editor Pane */}
        <Card className="flex flex-col gap-0 py-0 lg:col-span-8">
          {!selectedItem ? (
            <CardContent className="flex min-h-80 flex-col items-center justify-center gap-2 p-8 text-center">
              <BookOpen className="size-8 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">Select a playbook</p>
              <p className="text-xs text-muted-foreground">
                Choose a workflow on the left to review or edit, or create a new SOP.
              </p>
            </CardContent>
          ) : (
            <>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="truncate text-base font-semibold text-foreground">
                      {selectedItem.title}
                    </CardTitle>
                    <Badge variant="secondary" className="font-mono text-xs font-normal">
                      {selectedItem.profile}
                    </Badge>
                    {hasUnsavedChanges && (
                      <Badge
                        variant="outline"
                        className="border-amber-500/30 bg-amber-500/10 text-amber-300 font-normal"
                      >
                        Unsaved changes
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex rounded-md border border-border bg-muted p-0.5">
                    <Button
                      type="button"
                      size="xs"
                      variant={mode === "preview" ? "secondary" : "ghost"}
                      onClick={() => setMode("preview")}
                    >
                      <Eye className="size-3.5" />
                      Preview
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant={mode === "edit" ? "secondary" : "ghost"}
                      onClick={() => setMode("edit")}
                    >
                      <FileCode2 className="size-3.5" />
                      Edit
                    </Button>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={saving || readingFile || !hasUnsavedChanges}
                    onClick={() => void handleSave()}
                  >
                    <Save className="size-3.5" />
                    {saving ? "Saving…" : "Save & Sync to GBrain"}
                  </Button>
                </div>
              </CardHeader>

              <CardContent className="flex flex-1 flex-col gap-3 p-5">
                {notice && (
                  <div
                    role="status"
                    className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300"
                  >
                    <CheckCircle2 className="size-4 shrink-0" />
                    <span>{notice}</span>
                  </div>
                )}
                {actionError && (
                  <div
                    role="alert"
                    className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                  >
                    <AlertTriangle className="size-4 shrink-0" />
                    <span>{actionError}</span>
                  </div>
                )}

                {readingFile ? (
                  <div className="space-y-3 py-4">
                    <Skeleton className="h-6 w-1/3" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-5/6" />
                    <Skeleton className="h-32 w-full" />
                  </div>
                ) : mode === "preview" ? (
                  <div className="min-h-96 rounded-lg border border-border bg-background/50 p-5">
                    <MarkdownBody>{content || "_Empty playbook._"}</MarkdownBody>
                  </div>
                ) : (
                  <Textarea
                    value={content}
                    onChange={(e) => {
                      setContent(e.target.value);
                      setNotice(null);
                    }}
                    rows={22}
                    spellCheck={false}
                    className="min-h-96 font-mono text-xs leading-relaxed"
                  />
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-default font-mono">playbooks/{selectedItem.path}</span>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      Stored in GBrain SOP library ({selectedItem.path})
                    </TooltipContent>
                  </Tooltip>
                  <span>Updated {formatUpdatedAt(selectedItem.updatedAt)}</span>
                </div>
              </CardContent>
            </>
          )}
        </Card>
      </div>

      {/* Create New Workflow Dialog — DESIGN.md footer rule */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>New workflow playbook</DialogTitle>
            <DialogDescription>
              Auto-formatted to AgentWiki standard and synced to GBrain for every specialist agent.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-3.5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="wf-name" className="text-xs">
                  Workflow name
                </Label>
                <Input
                  id="wf-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Launch Meta Ads Campaign"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="wf-profile" className="text-xs">
                  Owner profile
                </Label>
                <Select value={newProfile} onValueChange={setNewProfile}>
                  <SelectTrigger id="wf-profile" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROFILE_OPTIONS.map((profile) => (
                      <SelectItem key={profile} value={profile}>
                        {profile}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="wf-trigger" className="text-xs">
                Trigger
              </Label>
              <Input
                id="wf-trigger"
                value={newTrigger}
                onChange={(e) => setNewTrigger(e.target.value)}
                placeholder="When should Javar or the specialist run this?"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="wf-inputs" className="text-xs">
                Required inputs (one per line)
              </Label>
              <Textarea
                id="wf-inputs"
                rows={2}
                value={newInputs}
                onChange={(e) => setNewInputs(e.target.value)}
                placeholder={"Client name & ad account ID\nDaily budget cap"}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="wf-steps" className="text-xs">
                Deterministic steps (one per line)
              </Label>
              <Textarea
                id="wf-steps"
                rows={4}
                value={newSteps}
                onChange={(e) => setNewSteps(e.target.value)}
                placeholder={"Audit pixel and active campaigns\nBuild paused draft campaign\nVerify tracking"}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="wf-approvals" className="text-xs">
                Human-approval checkpoints (one per line)
              </Label>
              <Textarea
                id="wf-approvals"
                rows={2}
                value={newApprovals}
                onChange={(e) => setNewApprovals(e.target.value)}
                placeholder="Require operator approval before publishing or changing budget."
              />
            </div>

            {createError && (
              <p className="text-xs text-destructive" role="alert">
                {createError}
              </p>
            )}

            <DialogFooter className="flex-row items-center justify-between sm:justify-between">
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Creating…" : "Create & Sync to GBrain"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
