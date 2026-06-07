import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";
import { useSettings } from "../hooks/useSettings";
import { type AppModelOption, getAppModelOptionsForInstance } from "../modelSelection";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { useServerKeybindings, useServerProviders } from "../rpc/serverState";
import { cn } from "../lib/utils";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";

export function ModelPicker(props: {
  provider: ProviderDriverKind | string;
  providerInstanceId?: ProviderInstanceId | string | undefined;
  model: string;
  onProviderModelChange: (
    provider: ProviderDriverKind,
    model: string,
    providerInstanceId?: ProviderInstanceId,
  ) => void;
  className?: string;
}) {
  const providers = useServerProviders();
  const keybindings = useServerKeybindings();
  const settings = useSettings();

  const instanceEntries = useMemo<ReadonlyArray<ProviderInstanceEntry>>(
    () => sortProviderInstanceEntries(deriveProviderInstanceEntries(providers)),
    [providers],
  );
  const activeEntry = useMemo(() => {
    const providerInstanceId = props.providerInstanceId;
    if (providerInstanceId) {
      const exact = instanceEntries.find((entry) => entry.instanceId === providerInstanceId);
      if (exact) return exact;
    }

    const provider = String(props.provider);
    return (
      instanceEntries.find(
        (entry) => entry.driverKind === provider && entry.enabled && entry.isAvailable,
      ) ??
      instanceEntries.find((entry) => entry.driverKind === provider) ??
      instanceEntries.find((entry) => entry.enabled && entry.isAvailable) ??
      instanceEntries[0] ??
      null
    );
  }, [instanceEntries, props.provider, props.providerInstanceId]);

  const modelOptionsByInstance = useMemo<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  >(() => {
    const out = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
    for (const entry of instanceEntries) {
      out.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry));
    }
    return out;
  }, [instanceEntries, settings]);

  const activeInstanceId =
    activeEntry?.instanceId ?? (String(props.provider) as ProviderInstanceId);
  const activeOptions = modelOptionsByInstance.get(activeInstanceId) ?? [];
  const selectedModel = activeOptions.some((option) => option.slug === props.model)
    ? props.model
    : (activeOptions[0]?.slug ?? props.model);

  useEffect(() => {
    if (!activeEntry || selectedModel.length === 0 || selectedModel === props.model) return;
    props.onProviderModelChange(activeEntry.driverKind, selectedModel, activeEntry.instanceId);
  }, [activeEntry, props, selectedModel]);

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    const entry = instanceEntries.find((candidate) => candidate.instanceId === instanceId);
    if (!entry) return;
    props.onProviderModelChange(entry.driverKind, model, instanceId);
  };

  return (
    <div className={props.className}>
      <ProviderModelPicker
        activeInstanceId={activeInstanceId}
        model={selectedModel}
        lockedProvider={null}
        instanceEntries={instanceEntries}
        keybindings={keybindings}
        modelOptionsByInstance={modelOptionsByInstance}
        triggerVariant="outline"
        triggerClassName={cn("h-9 w-full max-w-none bg-background", props.className)}
        onInstanceModelChange={handleInstanceModelChange}
      />
    </div>
  );
}
