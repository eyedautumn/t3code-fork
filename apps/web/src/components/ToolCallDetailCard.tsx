import type { ReactNode } from "react";

import { ScrollArea } from "./ui/scroll-area";
import { cn } from "~/lib/utils";
import type { ToolCallDetailSection } from "~/session-logic";

interface ToolCallDetailCardProps {
  header: string;
  subheader?: string | undefined;
  sections: ToolCallDetailSection[];
  metadata?: ReactNode;
  actions?: ReactNode;
  isFullScreen?: boolean;
}

export default function ToolCallDetailCard({
  header,
  subheader,
  sections,
  metadata,
  actions,
  isFullScreen = false,
}: ToolCallDetailCardProps) {
  const scrollAreaClassName = cn(
    "mt-3 overflow-hidden rounded-lg border border-border/70 bg-background/70",
    isFullScreen ? "max-h-[68vh]" : "max-h-[260px]",
  );

  return (
    <div
      className={cn(
        "rounded-2xl border border-border/70 bg-card/60 p-4",
        isFullScreen && "max-h-[80vh]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold text-foreground">{header}</p>
          {subheader && (
            <p className="text-xs text-muted-foreground/80">{subheader}</p>
          )}
          {metadata && <div className="mt-2 flex flex-wrap gap-1 text-[10px]">{metadata}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <ScrollArea className={scrollAreaClassName} scrollFade>
        <div className="space-y-4 px-3 py-2 text-[13px] leading-relaxed text-foreground">
          {sections.map((section) => (
            <div key={section.title} className="space-y-1">
              <p className="text-[9px] font-semibold uppercase tracking-[0.3em] text-muted-foreground/70">
                {section.title}
              </p>
              <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-foreground">
                {section.body}
              </pre>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
