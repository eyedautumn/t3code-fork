import { useState } from "react";
import type { ModelSlug, ProviderKind } from "@t3tools/contracts";
import { getDefaultModel, getModelOptions } from "@t3tools/shared/model";
import { PROVIDER_OPTIONS } from "~/session-logic";
import { ChevronDownIcon, ZapIcon, Box } from "lucide-react";
import { OpenCodeIcon, OpenAI, ClaudeAI, Gemini, CursorIcon } from "~/components/Icons";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { getAppModelOptions, type AppServiceTier } from "~/appSettings";
import { cn } from "~/lib/utils";

type ProviderPickerKind = ProviderKind | "cursor";

const PROVIDER_ICON_BY_PROVIDER: Record<
  ProviderPickerKind,
  React.ComponentType<{ className?: string }>
> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  cursor: CursorIcon,
  opencode: OpenCodeIcon,
};

function isAvailableProviderOption(
  option: (typeof PROVIDER_OPTIONS)[number],
): option is { value: ProviderPickerKind; label: string; available: true } {
  return option.available;
}

const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);
const UNAVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter((option) => !option.available);
const COMING_SOON_PROVIDER_OPTIONS = [
  { id: "gemini", label: "Gemini", icon: Gemini },
] as const;

function shouldShowFastTierIcon(model: string, serviceTierSetting: AppServiceTier): boolean {
  return (
    serviceTierSetting === "flex" &&
    (model.includes("5.4") || model.includes("5.3") || model.includes("5.2"))
  );
}

function getModelOptionsByProvider(): Record<string, ReadonlyArray<{ slug: string; name: string }>> {
  return {
    codex: getAppModelOptions("codex", []),
    opencode: getAppModelOptions("opencode", []),
  };
}

function resolveModelForProviderPicker(
  provider: ProviderKind,
  value: string,
  modelOptions: ReadonlyArray<{ slug: string; name: string }>,
): string | null {
  if (!value) {
    return getDefaultModel(provider);
  }
  const exists = modelOptions?.some((option) => option.slug === value);
  return exists ? value : getDefaultModel(provider);
}

export interface ModelPickerProps {
  provider: ProviderKind;
  model: ModelSlug | string;
  modelOptionsByProvider?: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  lockedProvider?: ProviderKind | null;
  serviceTierSetting?: AppServiceTier;
  disabled?: boolean;
  onProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
  className?: string;
}

export function ModelPicker(props: ModelPickerProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  
  const modelOptionsByProvider = props.modelOptionsByProvider ?? getModelOptionsByProvider();
  
  const selectedProviderOptions = modelOptionsByProvider[props.provider] ?? getModelOptions(props.provider as any) ?? [];
  const selectedModelLabel = selectedProviderOptions.find((option) => option.slug === props.model)?.name ?? props.model;
  
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.provider as ProviderPickerKind] || Box;
  const showZap = props.provider === "codex" && shouldShowFastTierIcon(props.model, props.serviceTierSetting ?? "flex");

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            variant="outline"
            className={cn(
              "group relative flex h-9 items-center justify-between gap-2 overflow-hidden rounded-lg border-border/50 bg-muted/20 px-3 text-sm font-medium shadow-sm transition-all duration-300",
              "hover:border-primary/40 hover:bg-primary/5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary/30",
              isMenuOpen && "border-primary/50 bg-primary/10 ring-1 ring-primary/20",
              props.className // <-- Relies on this for w-full (Swarm) vs w-auto (Chat)
            )}
            disabled={props.disabled}
          />
        }
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <ProviderIcon 
            aria-hidden="true" 
            className={cn(
              "size-4 shrink-0 transition-all duration-300", 
              // Changed from text-primary to text-foreground to remove the blue light-up effect
              isMenuOpen ? "scale-110 text-foreground" : "text-muted-foreground/80 group-hover:text-foreground"
            )} 
          />
          {showZap && (
            <ZapIcon className="size-3.5 shrink-0 animate-pulse fill-amber-500 text-amber-500 drop-shadow-[0_0_8px_rgba(245,158,11,0.7)]" />
          )}
          <span className="truncate text-foreground/90 tracking-wide transition-colors group-hover:text-foreground">
            {selectedModelLabel}
          </span>
        </div>
        <ChevronDownIcon 
          aria-hidden="true" 
          className={cn(
            "size-4 shrink-0 text-muted-foreground/50 transition-transform duration-300 ease-in-out",
            // Changed from text-primary to text-foreground to keep it consistent
            isMenuOpen && "rotate-180 text-foreground"
          )} 
        />
      </MenuTrigger>
      
      <MenuPopup 
        align="start" 
        className="min-w-[240px] origin-top rounded-xl border-border/50 bg-background/95 p-1 shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
      >
        {AVAILABLE_PROVIDER_OPTIONS.map((option) => {
          const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value] || Box;
          const isDisabledByProviderLock =
            props.lockedProvider !== null && props.lockedProvider !== undefined && props.lockedProvider !== option.value;
            
          const dynamicOptions = modelOptionsByProvider[option.value as ProviderKind] ?? getModelOptions(option.value as any) ?? [];

          return (
            <MenuSub key={option.value}>
              <MenuSubTrigger 
                disabled={isDisabledByProviderLock} 
                className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-primary/10 hover:text-primary focus:bg-primary/10 focus:text-primary data-[state=open]:bg-primary/10 data-[state=open]:text-primary"
              >
                <OptionIcon aria-hidden="true" className="size-4 shrink-0 opacity-80" />
                <span className="font-medium">{option.label}</span>
              </MenuSubTrigger>
              <MenuSubPopup 
                className="[--available-height:min(24rem,70vh)] origin-top-left rounded-xl border-border/50 bg-background/95 p-1 shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
              >
                <MenuGroup>
                  <MenuRadioGroup
                    value={props.provider === option.value ? props.model : ""}
                    onValueChange={(value) => {
                      if (props.disabled || isDisabledByProviderLock || !value) return;
                      const resolvedModel = resolveModelForProviderPicker(
                        option.value as ProviderKind,
                        value,
                        dynamicOptions,
                      );
                      if (!resolvedModel) return;
                      props.onProviderModelChange(option.value as ProviderKind, resolvedModel as ModelSlug);
                      setIsMenuOpen(false);
                    }}
                  >
                    {dynamicOptions.map((modelOption) => {
                      const isFast = option.value === "codex" && shouldShowFastTierIcon(modelOption.slug, props.serviceTierSetting ?? "flex");
                      
                      return (
                        <MenuRadioItem
                          key={`${option.value}:${modelOption.slug}`}
                          value={modelOption.slug}
                          onClick={() => setIsMenuOpen(false)}
                          className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2.5 transition-colors hover:bg-primary/10 focus:bg-primary/10"
                        >
                          {isFast && <ZapIcon className="size-3.5 shrink-0 fill-amber-500 text-amber-500 drop-shadow-[0_0_6px_rgba(245,158,11,0.5)]" />}
                          <span className="truncate text-sm">{modelOption.name}</span>
                        </MenuRadioItem>
                      );
                    })}
                  </MenuRadioGroup>
                </MenuGroup>
              </MenuSubPopup>
            </MenuSub>
          );
        })}

        {UNAVAILABLE_PROVIDER_OPTIONS.length > 0 && <MenuSeparator className="my-1 opacity-50" />}
        {UNAVAILABLE_PROVIDER_OPTIONS.map((option) => {
          const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value] || Box;
          return (
            <MenuItem key={option.value} disabled className="flex items-center gap-3 px-2 py-2.5 opacity-50">
              <OptionIcon aria-hidden="true" className="size-4 shrink-0" />
              <span className="text-sm">{option.label}</span>
              <span className="ms-auto rounded bg-muted/50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                Soon
              </span>
            </MenuItem>
          );
        })}
        {COMING_SOON_PROVIDER_OPTIONS.map((option) => {
          const OptionIcon = option.icon;
          return (
            <MenuItem key={option.id} disabled className="flex items-center gap-3 px-2 py-2.5 opacity-50">
              <OptionIcon aria-hidden="true" className="size-4 shrink-0" />
              <span className="text-sm">{option.label}</span>
              <span className="ms-auto rounded bg-muted/50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                Soon
              </span>
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}
