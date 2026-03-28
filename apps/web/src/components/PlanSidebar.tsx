import { memo, useState, useCallback } from "react";
import { type TimestampFormat } from "../appSettings";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { CheckIcon, EllipsisIcon, LoaderIcon, PanelRightCloseIcon, TargetIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import type { ActivePlanState } from "../session-logic";
import type { LatestProposedPlanState } from "../session-logic";
import { formatTimestamp } from "../timestampFormat";
import { buildProposedPlanMarkdownFilename, normalizePlanMarkdownForExport } from "../proposedPlan";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { readNativeApi } from "~/nativeApi";
import { toastManager } from "./ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

function stepStatusIcon(status: string): React.ReactNode {
  if (status === "completed") {
    return (
      <div className="relative z-10 flex size-[22px] shrink-0 items-center justify-center rounded-full bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.4)] ring-4 ring-background">
        <CheckIcon className="size-3 text-white" strokeWidth={3} />
      </div>
    );
  }
  if (status === "inProgress") {
    return (
      <div className="relative z-10 flex size-[22px] shrink-0 items-center justify-center rounded-full bg-blue-500 shadow-[0_0_16px_rgba(59,130,246,0.5)] ring-4 ring-blue-500/20">
        <LoaderIcon className="size-3.5 text-white animate-spin" strokeWidth={2.5} />
      </div>
    );
  }
  return (
    <div className="relative z-10 flex size-[22px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-border/80 bg-background ring-4 ring-background">
      <div className="size-1.5 rounded-full bg-muted-foreground/30" />
    </div>
  );
}

interface PlanSidebarProps {
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  workspaceRoot: string | undefined;
  timestampFormat: TimestampFormat;
  onClose: () => void;
}

const PlanSidebar = memo(function PlanSidebar({
  activePlan,
  activeProposedPlan,
  workspaceRoot,
  timestampFormat,
  onClose,
}: PlanSidebarProps) {
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const planMarkdown = activeProposedPlan?.planMarkdown ?? null;

  const handleCopyPlan = useCallback(() => {
    if (!planMarkdown) return;
    copyToClipboard(planMarkdown);
  }, [planMarkdown, copyToClipboard]);

  const handleSaveToWorkspace = useCallback(() => {
    const api = readNativeApi();
    if (!api || !workspaceRoot || !planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    setIsSavingToWorkspace(true);
    void api.projects
      .writeFile({
        cwd: workspaceRoot,
        relativePath: filename,
        contents: normalizePlanMarkdownForExport(planMarkdown),
      })
      .then((result) => {
        toastManager.add({
          type: "success",
          title: "Plan saved",
          description: result.relativePath,
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not save plan",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      })
      .then(
        () => setIsSavingToWorkspace(false),
        () => setIsSavingToWorkspace(false),
      );
  }, [planMarkdown, workspaceRoot]);

  return (
    <div className="flex h-full w-[360px] shrink-0 flex-col border-l border-border/40 bg-background/95 backdrop-blur-xl shadow-2xl supports-[backdrop-filter]:bg-background/80 relative z-50">
      {/* Header */}
      <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-border/40 px-4 bg-muted/10">
        <div className="flex items-center gap-3">
          <Badge
            variant="secondary"
            className="rounded-md bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 text-[10px] font-bold tracking-widest text-blue-500 uppercase shadow-sm"
          >
            Active Plan
          </Badge>
          {activePlan ? (
            <span className="text-[11px] text-muted-foreground/60">
              {formatTimestamp(activePlan.createdAt, timestampFormat)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-0.5">
          {planMarkdown ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 rounded-md transition-colors"
                    aria-label="Plan actions"
                  />
                }
              >
                <EllipsisIcon className="size-4" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={handleCopyPlan}>
                  {isCopied ? "Copied!" : "Copy to clipboard"}
                </MenuItem>
                <MenuItem
                  onClick={handleSaveToWorkspace}
                  disabled={!workspaceRoot || isSavingToWorkspace}
                  className="text-[13px]"
                >
                  Save to workspace
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label="Close plan sidebar"
            className="h-7 w-7 text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 rounded-md transition-colors"
          >
            <PanelRightCloseIcon className="size-4" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-5 space-y-6">
          {/* Explanation Card */}
          {activePlan?.explanation ? (
            <div className="rounded-xl border border-primary/10 bg-gradient-to-br from-primary/[0.03] to-transparent p-4 shadow-sm relative overflow-hidden">
              <div className="absolute top-0 right-0 w-24 h-24 bg-primary/5 rounded-full blur-2xl -mr-8 -mt-8 pointer-events-none" />
              <h4 className="mb-2 flex items-center gap-2 text-[11px] font-bold tracking-widest text-primary/80 uppercase">
                <TargetIcon className="size-3.5" />
                Objective
              </h4>
              <p className="text-[13px] leading-relaxed text-foreground/80 relative z-10">
                {activePlan.explanation}
              </p>
              {activePlan.steps.map((step) => (
                <div
                  key={`${step.status}:${step.step}`}
                  className={cn(
                    "flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-200",
                    step.status === "inProgress" && "bg-blue-500/5",
                    step.status === "completed" && "bg-emerald-500/5",
                  )}
                >
                  <div className="mt-0.5">{stepStatusIcon(step.status)}</div>
                  <p
                    className={cn(
                      "text-[13px] leading-snug",
                      step.status === "completed"
                        ? "text-muted-foreground/50 line-through decoration-muted-foreground/20"
                        : step.status === "inProgress"
                          ? "text-foreground/90"
                          : "text-muted-foreground/70",
                    )}
                  >
                    {step.step}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
});

export default PlanSidebar;
export type { PlanSidebarProps };
