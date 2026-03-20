import { type ProviderInteractionMode } from "@t3tools/contracts";
import { MenuRadioGroup, MenuRadioItem } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

export type InteractionModeTooltipStyle = "inline" | "bubble";

export const INTERACTION_MODE_OPTIONS: ReadonlyArray<{
  value: ProviderInteractionMode;
  label: string;
  description: string;
}> = [
  {
    value: "default",
    label: "Agent",
    description: "Default mode for general-purpose work and tool use.",
  },
  {
    value: "plan",
    label: "Plan",
    description: "Plan first, then execute once you confirm.",
  },
  {
    value: "debug",
    label: "Debug",
    description: "Focus on diagnosing issues and proposing fixes.",
  },
  {
    value: "ask",
    label: "Ask",
    description: "Ask clarifying questions before taking action.",
  },
];

export function getInteractionModeLabel(mode: ProviderInteractionMode): string {
  return INTERACTION_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? "Agent";
}

export function InteractionModeMenuItems(props: {
  value: ProviderInteractionMode;
  tooltipStyle: InteractionModeTooltipStyle;
  onValueChange: (value: ProviderInteractionMode) => void;
}) {
  return (
    <MenuRadioGroup
      value={props.value}
      onValueChange={(value) => {
        if (!value) return;
        props.onValueChange(value as ProviderInteractionMode);
      }}
    >
      {INTERACTION_MODE_OPTIONS.map((option) => {
        const inlineDescription =
          props.tooltipStyle === "inline" ? (
            <span className="mt-0.5 text-xs text-muted-foreground">{option.description}</span>
          ) : null;
        const itemContent = (
          <div className="flex flex-col">
            <span>{option.label}</span>
            {inlineDescription}
          </div>
        );
        const item = (
          <MenuRadioItem
            value={option.value}
            className={cn(props.tooltipStyle === "inline" && "items-start")}
          >
            {itemContent}
          </MenuRadioItem>
        );

        if (props.tooltipStyle === "bubble") {
          return (
            <Tooltip key={option.value}>
              <TooltipTrigger render={item} />
              <TooltipPopup side="right" className="max-w-56 text-xs">
                {option.description}
              </TooltipPopup>
            </Tooltip>
          );
        }

        return (
          <MenuRadioItem
            key={option.value}
            value={option.value}
            className={cn(props.tooltipStyle === "inline" && "items-start")}
          >
            {itemContent}
          </MenuRadioItem>
        );
      })}
    </MenuRadioGroup>
  );
}
