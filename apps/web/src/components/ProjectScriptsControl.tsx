import type {
  ProjectScript,
  ProjectScriptIcon,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  BugIcon,
  ChevronDownIcon,
  FlaskConicalIcon,
  HammerIcon,
  ListChecksIcon,
  PlayIcon,
  PlusIcon,
  SettingsIcon,
  WrenchIcon,
  Keyboard,
  TerminalSquare,
  Rocket,
  LogOut,
  XSquare,
  FolderOpen,
  FileCode2,
  Workflow,
  MousePointerClick,
} from "lucide-react";
import React, { type FormEvent, type KeyboardEvent, useCallback, useMemo, useState } from "react";

import {
  keybindingValueForCommand,
  decodeProjectScriptKeybindingRule,
} from "~/lib/projectScriptKeybindings";
import {
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
} from "~/projectScripts";
import { shortcutLabelForCommand } from "~/keybindings";
import { cn, isMacPlatform } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Group, GroupSeparator } from "./ui/group";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "./ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";

const SCRIPT_ICONS: Array<{ id: ProjectScriptIcon; label: string }> = [
  { id: "play", label: "Play" },
  { id: "test", label: "Test" },
  { id: "lint", label: "Lint" },
  { id: "configure", label: "Configure" },
  { id: "build", label: "Build" },
  { id: "debug", label: "Debug" },
];

function ScriptIcon({
  icon,
  className = "size-3.5",
}: {
  icon: ProjectScriptIcon;
  className?: string;
}) {
  if (icon === "test") return <FlaskConicalIcon className={className} />;
  if (icon === "lint") return <ListChecksIcon className={className} />;
  if (icon === "configure") return <WrenchIcon className={className} />;
  if (icon === "build") return <HammerIcon className={className} />;
  if (icon === "debug") return <BugIcon className={className} />;
  return <PlayIcon className={className} />;
}

export interface NewProjectScriptInput {
  name: string;
  command: string;
  icon: ProjectScriptIcon;
  runOnWorktreeCreate: boolean;
  keybinding: string | null;
}

export type ProjectScriptAfterAction = "close-terminal" | "quit-app" | "launch-app";
export type ProjectScriptLaunchMode = "direct-path" | "folder-prefix";

const AFTER_ACTION_OPTIONS: Array<{
  id: ProjectScriptAfterAction;
  label: string;
  icon: React.ReactNode;
  desc: string;
}> = [
  {
    id: "close-terminal",
    label: "Close Terminal",
    icon: <XSquare className="size-4" />,
    desc: "Auto-close when finished.",
  },
  {
    id: "quit-app",
    label: "Quit T3 Code",
    icon: <LogOut className="size-4" />,
    desc: "Exit after processing.",
  },
  {
    id: "launch-app",
    label: "Launch App",
    icon: <Rocket className="size-4" />,
    desc: "Open an executable.",
  },
];

interface ProjectScriptsControlProps {
  scripts: ProjectScript[];
  keybindings: ResolvedKeybindingsConfig;
  preferredScriptId?: string | null;
  afterActions: ProjectScriptAfterAction[];
  afterActionAppPath: string | null;
  afterActionLaunchMode: ProjectScriptLaunchMode;
  afterActionLaunchFolder: string | null;
  afterActionLaunchPrefix: string;
  onAfterActionsChange: (value: ProjectScriptAfterAction[]) => void;
  onAfterActionAppPathChange: (value: string | null) => void;
  onAfterActionLaunchModeChange: (value: ProjectScriptLaunchMode) => void;
  onAfterActionLaunchFolderChange: (value: string | null) => void;
  onAfterActionLaunchPrefixChange: (value: string) => void;
  onRunScript: (script: ProjectScript) => void;
  onAddScript: (input: NewProjectScriptInput) => Promise<void> | void;
  onUpdateScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void> | void;
  onDeleteScript: (scriptId: string) => Promise<void> | void;
}

function normalizeShortcutKeyToken(key: string): string | null {
  const normalized = key.toLowerCase();
  if (
    normalized === "meta" ||
    normalized === "control" ||
    normalized === "ctrl" ||
    normalized === "shift" ||
    normalized === "alt" ||
    normalized === "option"
  ) {
    return null;
  }
  if (normalized === " ") return "space";
  if (normalized === "escape") return "esc";
  if (normalized === "arrowup") return "arrowup";
  if (normalized === "arrowdown") return "arrowdown";
  if (normalized === "arrowleft") return "arrowleft";
  if (normalized === "arrowright") return "arrowright";
  if (normalized.length === 1) return normalized;
  if (normalized.startsWith("f") && normalized.length <= 3) return normalized;
  if (normalized === "enter" || normalized === "tab" || normalized === "backspace") {
    return normalized;
  }
  if (normalized === "delete" || normalized === "home" || normalized === "end") {
    return normalized;
  }
  if (normalized === "pageup" || normalized === "pagedown") return normalized;
  return null;
}

function keybindingFromEvent(event: KeyboardEvent<HTMLInputElement>): string | null {
  const keyToken = normalizeShortcutKeyToken(event.key);
  if (!keyToken) return null;

  const parts: string[] = [];
  if (isMacPlatform(navigator.platform)) {
    if (event.metaKey) parts.push("mod");
    if (event.ctrlKey) parts.push("ctrl");
  } else {
    if (event.ctrlKey) parts.push("mod");
    if (event.metaKey) parts.push("meta");
  }
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (parts.length === 0) {
    return null;
  }
  parts.push(keyToken);
  return parts.join("+");
}

export default function ProjectScriptsControl({
  scripts,
  keybindings,
  preferredScriptId = null,
  afterActions,
  afterActionAppPath,
  afterActionLaunchMode,
  afterActionLaunchFolder,
  afterActionLaunchPrefix,
  onAfterActionsChange,
  onAfterActionAppPathChange,
  onAfterActionLaunchModeChange,
  onAfterActionLaunchFolderChange,
  onAfterActionLaunchPrefixChange,
  onRunScript,
  onAddScript,
  onUpdateScript,
  onDeleteScript,
}: ProjectScriptsControlProps) {
  const addScriptFormId = React.useId();
  const [editingScriptId, setEditingScriptId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [icon, setIcon] = useState<ProjectScriptIcon>("play");
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(false);
  const [keybinding, setKeybinding] = useState("");
  const [manualKeybindingEntry, setManualKeybindingEntry] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const primaryScript = useMemo(() => {
    if (preferredScriptId) {
      const preferred = scripts.find((script) => script.id === preferredScriptId);
      if (preferred) return preferred;
    }
    return primaryProjectScript(scripts);
  }, [preferredScriptId, scripts]);
  const isEditing = editingScriptId !== null;

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (manualKeybindingEntry) return;
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      setKeybinding("");
      return;
    }
    const next = keybindingFromEvent(event);
    if (!next) return;
    setKeybinding(next);
  };

  const submitAddScript = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (trimmedName.length === 0) {
      setValidationError("Name is required.");
      return;
    }
    if (trimmedCommand.length === 0) {
      setValidationError("Command is required.");
      return;
    }

    setValidationError(null);
    try {
      const scriptIdForValidation =
        editingScriptId ??
        nextProjectScriptId(
          trimmedName,
          scripts.map((script) => script.id),
        );
      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding,
        command: commandForProjectScript(scriptIdForValidation),
      });
      const payload = {
        name: trimmedName,
        command: trimmedCommand,
        icon,
        runOnWorktreeCreate,
        keybinding: keybindingRule?.key ?? null,
      } satisfies NewProjectScriptInput;
      if (editingScriptId) {
        await onUpdateScript(editingScriptId, payload);
      } else {
        await onAddScript(payload);
      }
      setDialogOpen(false);
      setIconPickerOpen(false);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : "Failed to save action.");
    }
  };

  const openAddDialog = () => {
    setEditingScriptId(null);
    setName("");
    setCommand("");
    setIcon("play");
    setIconPickerOpen(false);
    setRunOnWorktreeCreate(false);
    setKeybinding("");
    setManualKeybindingEntry(false);
    setValidationError(null);
    setDialogOpen(true);
  };

  const openEditDialog = (script: ProjectScript) => {
    setEditingScriptId(script.id);
    setName(script.name);
    setCommand(script.command);
    setIcon(script.icon);
    setIconPickerOpen(false);
    setRunOnWorktreeCreate(script.runOnWorktreeCreate);
    setKeybinding(keybindingValueForCommand(keybindings, commandForProjectScript(script.id)) ?? "");
    setValidationError(null);
    setDialogOpen(true);
  };

  const confirmDeleteScript = useCallback(() => {
    if (!editingScriptId) return;
    setDeleteConfirmOpen(false);
    setDialogOpen(false);
    void onDeleteScript(editingScriptId);
  }, [editingScriptId, onDeleteScript]);

  const pickAfterActionExecutable = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Desktop app required",
        description: "Executable launching is only available in the desktop app.",
      });
      return;
    }
    try {
      const selectedPath = await api.dialogs.pickExecutable();
      if (!selectedPath) return;
      onAfterActionAppPathChange(selectedPath);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to select app",
        description: error instanceof Error ? error.message : "Unknown picker error.",
      });
    }
  }, [onAfterActionAppPathChange]);

  const pickAfterActionFolder = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Desktop app required",
        description: "Completion app auto-detect is only available in the desktop app.",
      });
      return;
    }
    try {
      const selectedPath = await api.dialogs.pickFolder();
      if (!selectedPath) return;
      onAfterActionLaunchFolderChange(selectedPath);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to select folder",
        description: error instanceof Error ? error.message : "Unknown picker error.",
      });
    }
  }, [onAfterActionLaunchFolderChange]);

  const toggleAfterAction = useCallback(
    (id: ProjectScriptAfterAction) => {
      if (afterActions.includes(id)) {
        onAfterActionsChange(afterActions.filter((value) => value !== id));
      } else {
        onAfterActionsChange([...afterActions, id]);
      }
    },
    [afterActions, onAfterActionsChange],
  );

  return (
    <>
      {primaryScript ? (
        <Group aria-label="Project scripts">
          <Button
            size="xs"
            variant="outline"
            onClick={() => onRunScript(primaryScript)}
            title={`Run ${primaryScript.name}`}
            className="gap-2 px-3"
          >
            <ScriptIcon icon={primaryScript.icon} />
            <span className="sr-only @sm/header-actions:not-sr-only font-medium">
              {primaryScript.name}
            </span>
          </Button>
          <GroupSeparator className="hidden @sm/header-actions:block" />
          <Menu highlightItemOnHover={false}>
            <MenuTrigger
              render={<Button size="icon-xs" variant="outline" aria-label="Script actions" />}
            >
              <ChevronDownIcon className="size-3.5 opacity-70" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-[200px] rounded-xl p-1 shadow-xl">
              {scripts.map((script) => {
                const shortcutLabel = shortcutLabelForCommand(
                  keybindings,
                  commandForProjectScript(script.id),
                );
                return (
                  <MenuItem
                    key={script.id}
                    className="group relative flex items-center gap-3 rounded-md px-2 py-2 cursor-pointer hover:bg-muted focus:bg-muted"
                    onClick={() => onRunScript(script)}
                  >
                    <ScriptIcon
                      icon={script.icon}
                      className="size-4 text-muted-foreground group-hover:text-foreground"
                    />
                    <span className="flex-1 truncate font-medium">
                      {script.runOnWorktreeCreate ? `${script.name} (Setup)` : script.name}
                    </span>

                    <div className="flex items-center justify-end gap-1 min-w-[40px]">
                      {shortcutLabel && (
                        <MenuShortcut className="transition-opacity group-hover:opacity-0">
                          {shortcutLabel}
                        </MenuShortcut>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="absolute right-2 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-background/80"
                        aria-label={`Edit ${script.name}`}
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          openEditDialog(script);
                        }}
                      >
                        <SettingsIcon className="size-3.5 text-muted-foreground" />
                      </Button>
                    </div>
                  </MenuItem>
                );
              })}
              <div className="my-1 h-px bg-border/50" />
              <MenuItem
                className="group flex items-center gap-3 rounded-md px-2 py-2 cursor-pointer hover:bg-primary/10 hover:text-primary"
                onClick={openAddDialog}
              >
                <PlusIcon className="size-4" />
                <span className="font-medium">Add new action</span>
              </MenuItem>
            </MenuPopup>
          </Menu>
        </Group>
      ) : (
        <Button size="xs" variant="outline" onClick={openAddDialog} className="gap-2 px-3">
          <PlusIcon className="size-3.5" />
          <span className="sr-only @sm/header-actions:not-sr-only font-medium">Add action</span>
        </Button>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setIconPickerOpen(false);
        }}
        onOpenChangeComplete={(open) => {
          if (open) return;
          setEditingScriptId(null);
          setName("");
          setCommand("");
          setIcon("play");
          setRunOnWorktreeCreate(false);
          setKeybinding("");
          setManualKeybindingEntry(false);
          setValidationError(null);
        }}
      >
        <DialogPopup className="sm:max-w-2xl p-0 overflow-hidden bg-background/95 backdrop-blur-xl border-border/50 shadow-2xl">
          <DialogHeader className="px-6 py-5 border-b border-border/40 bg-muted/10">
            <DialogTitle className="text-xl flex items-center gap-2">
              <TerminalSquare className="size-5 text-primary" />
              {isEditing ? "Edit Action" : "Create Action"}
            </DialogTitle>
            <DialogDescription className="mt-1.5">
              Define a project-scoped command to execute quickly via the top bar or a custom
              keybinding.
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="p-0">
            <form
              id={addScriptFormId}
              className="flex flex-col max-h-[70vh] overflow-y-auto px-6 py-5 gap-6"
              onSubmit={submitAddScript}
            >
              {/* SECTION: Identity & Command */}
              <div className="space-y-4 rounded-xl border border-border/50 bg-muted/5 p-4 shadow-sm">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground/80 uppercase tracking-wider">
                  <Workflow className="size-4 text-primary/70" /> Configuration
                </div>

                <div className="space-y-2">
                  <Label htmlFor="script-name" className="text-xs text-muted-foreground">
                    Action Name
                  </Label>
                  <div className="flex h-10 items-center overflow-hidden rounded-lg border border-border/60 bg-background focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary/50 transition-all shadow-sm">
                    <Popover onOpenChange={setIconPickerOpen} open={iconPickerOpen}>
                      <PopoverTrigger
                        render={
                          <button
                            type="button"
                            className="flex h-full w-10 shrink-0 items-center justify-center border-r border-border/50 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                          />
                        }
                      >
                        <ScriptIcon icon={icon} className="size-4.5" />
                      </PopoverTrigger>
                      <PopoverPopup
                        align="start"
                        className="w-64 p-2 rounded-xl shadow-xl border-border/50"
                      >
                        <div className="grid grid-cols-3 gap-1.5">
                          {SCRIPT_ICONS.map((entry) => (
                            <button
                              key={entry.id}
                              type="button"
                              className={cn(
                                "flex flex-col items-center gap-2 rounded-lg p-2.5 text-xs font-medium transition-all duration-200",
                                entry.id === icon
                                  ? "bg-primary text-primary-foreground shadow-md"
                                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
                              )}
                              onClick={() => {
                                setIcon(entry.id);
                                setIconPickerOpen(false);
                              }}
                            >
                              <ScriptIcon icon={entry.id} className="size-4" />
                              {entry.label}
                            </button>
                          ))}
                        </div>
                      </PopoverPopup>
                    </Popover>
                    <Input
                      id="script-name"
                      autoFocus
                      placeholder="e.g. Build Project"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="h-full flex-1 border-0 bg-transparent px-3 text-sm leading-none shadow-none focus-visible:ring-0"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="script-command" className="text-xs text-muted-foreground">
                    Terminal Command
                  </Label>
                  <Textarea
                    id="script-command"
                    placeholder="npm run dev"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    className="min-h-[80px] p-3 resize-y font-mono text-sm bg-background border-border/60 shadow-sm focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:border-primary/50 leading-relaxed"
                  />
                </div>
              </div>

              {/* SECTION: Triggers */}
              <div className="space-y-4 rounded-xl border border-border/50 bg-muted/5 p-4 shadow-sm">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground/80 uppercase tracking-wider">
                  <MousePointerClick className="size-4 text-primary/70" /> Triggers
                </div>

                <div className="grid gap-5 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="script-keybinding" className="text-xs text-muted-foreground">
                      Keyboard Shortcut
                    </Label>
                    <div className="relative flex h-10 items-center">
                      <Keyboard
                        className={cn(
                          "absolute left-3 size-4 text-muted-foreground z-10",
                          !manualKeybindingEntry && !keybinding ? "animate-pulse text-primary" : "",
                        )}
                      />
                      <Input
                        id="script-keybinding"
                        placeholder={
                          manualKeybindingEntry ? "Type binding..." : "Press shortcut keys..."
                        }
                        value={keybinding}
                        readOnly={!manualKeybindingEntry}
                        onKeyDown={captureKeybinding}
                        onChange={(e) => setKeybinding(e.target.value)}
                        className={cn(
                          "h-full w-full pl-9 font-mono text-sm leading-none shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:border-primary/50",
                          !manualKeybindingEntry
                            ? "bg-muted/30 focus-visible:bg-background"
                            : "bg-background",
                        )}
                      />
                    </div>
                    <div className="flex items-center justify-between px-1">
                      <span className="text-[10px] text-muted-foreground opacity-80">
                        Use{" "}
                        <kbd className="font-sans border rounded px-1 text-[9px]">Backspace</kbd> to
                        clear
                      </span>
                      <button
                        type="button"
                        onClick={() => setManualKeybindingEntry((v) => !v)}
                        className="text-[10px] font-medium text-primary hover:underline underline-offset-2"
                      >
                        {manualKeybindingEntry ? "Switch to Record Mode" : "Type Manually instead"}
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-col">
                    <Label className="text-xs text-muted-foreground mb-2">Options</Label>
                    <label className="flex h-10 items-center justify-between gap-3 rounded-lg border border-border/60 bg-background px-4 text-sm shadow-sm cursor-pointer hover:border-border transition-colors">
                      <span className="font-medium text-foreground/90 leading-none">
                        Run on worktree creation
                      </span>
                      <Switch
                        checked={runOnWorktreeCreate}
                        onCheckedChange={(checked) => setRunOnWorktreeCreate(Boolean(checked))}
                      />
                    </label>
                  </div>
                </div>
              </div>

              {/* SECTION: Post Completion */}
              <div className="space-y-4 rounded-xl border border-border/50 bg-muted/5 p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground/80 uppercase tracking-wider">
                    <Rocket className="size-4 text-primary/70" /> Completion Sequence
                  </div>
                  {afterActions.length > 0 && (
                    <span className="rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-bold tracking-widest uppercase">
                      {afterActions.length} Active
                    </span>
                  )}
                </div>

                <p className="text-xs text-muted-foreground">
                  Select the actions to trigger automatically when this command completes.
                </p>

                <div className="grid gap-3 sm:grid-cols-3">
                  {AFTER_ACTION_OPTIONS.map((option) => {
                    const selectedIndex = afterActions.indexOf(option.id);
                    const isSelected = selectedIndex >= 0;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => toggleAfterAction(option.id)}
                        className={cn(
                          "relative flex flex-col gap-2 rounded-xl border p-3 text-left transition-all duration-200",
                          isSelected
                            ? "border-primary/50 bg-primary/[0.03] shadow-[0_0_15px_rgba(var(--primary),0.1)] ring-1 ring-primary/20"
                            : "border-border/50 bg-background hover:border-foreground/20 hover:bg-muted/30",
                        )}
                      >
                        <div className="flex items-center justify-between w-full">
                          <div
                            className={cn(
                              "rounded-md p-1.5",
                              isSelected
                                ? "bg-primary text-primary-foreground shadow-sm"
                                : "bg-muted text-muted-foreground",
                            )}
                          >
                            {option.icon}
                          </div>
                          {isSelected && (
                            <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground shadow-sm">
                              {selectedIndex + 1}
                            </span>
                          )}
                        </div>
                        <div>
                          <div
                            className={cn(
                              "text-sm font-semibold",
                              isSelected ? "text-primary" : "text-foreground",
                            )}
                          >
                            {option.label}
                          </div>
                          <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                            {option.desc}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Inline Launch App Config */}
                {afterActions.includes("launch-app") && (
                  <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-4 animate-in slide-in-from-top-2 fade-in duration-300">
                    <Label className="text-xs font-semibold text-primary uppercase tracking-wider">
                      Launch Configuration
                    </Label>

                    <div className="mt-3 flex items-center gap-2 rounded-md bg-background/50 p-1 ring-1 ring-border/50 w-fit">
                      <Button
                        type="button"
                        size="xs"
                        variant={afterActionLaunchMode === "direct-path" ? "secondary" : "ghost"}
                        onClick={() => onAfterActionLaunchModeChange("direct-path")}
                        className="h-7 text-xs rounded-sm"
                      >
                        Direct Executable
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant={afterActionLaunchMode === "folder-prefix" ? "secondary" : "ghost"}
                        onClick={() => onAfterActionLaunchModeChange("folder-prefix")}
                        className="h-7 text-xs rounded-sm"
                      >
                        Dynamic Folder
                      </Button>
                    </div>

                    {afterActionLaunchMode === "direct-path" ? (
                      <div className="mt-4 space-y-2">
                        <Label
                          htmlFor="after-action-app-path"
                          className="text-xs text-muted-foreground"
                        >
                          Application Path
                        </Label>
                        <div className="flex items-center gap-2">
                          <div className="relative flex h-10 flex-1 items-center">
                            <FileCode2 className="absolute left-3 size-4 text-muted-foreground z-10" />
                            <Input
                              id="after-action-app-path"
                              value={afterActionAppPath ?? ""}
                              placeholder="e.g. /Applications/MyApp.app"
                              onChange={(e) =>
                                onAfterActionAppPathChange(e.target.value.trim() || null)
                              }
                              className="h-full w-full pl-9 text-sm leading-none bg-background shadow-sm focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:border-primary/50"
                            />
                          </div>
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={pickAfterActionExecutable}
                            className="h-10 shrink-0"
                          >
                            Browse
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-4 grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label
                            htmlFor="after-action-launch-folder"
                            className="text-xs text-muted-foreground"
                          >
                            Build Output Directory
                          </Label>
                          <div className="flex items-center gap-2">
                            <div className="relative flex h-10 flex-1 items-center">
                              <FolderOpen className="absolute left-3 size-4 text-muted-foreground z-10" />
                              <Input
                                id="after-action-launch-folder"
                                value={afterActionLaunchFolder ?? ""}
                                placeholder="/dist"
                                onChange={(e) =>
                                  onAfterActionLaunchFolderChange(e.target.value.trim() || null)
                                }
                                className="h-full w-full pl-9 text-sm leading-none bg-background shadow-sm focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:border-primary/50"
                              />
                            </div>
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={pickAfterActionFolder}
                              className="h-10 shrink-0"
                            >
                              Browse
                            </Button>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label
                            htmlFor="after-action-launch-prefix"
                            className="text-xs text-muted-foreground"
                          >
                            File Prefix
                          </Label>
                          <div className="flex h-10 items-center">
                            <Input
                              id="after-action-launch-prefix"
                              value={afterActionLaunchPrefix}
                              placeholder="app-v1.0-"
                              onChange={(e) =>
                                onAfterActionLaunchPrefixChange(e.target.value.trimStart())
                              }
                              className="h-full w-full px-3 text-sm leading-none bg-background shadow-sm focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:border-primary/50"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {validationError && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive font-medium animate-in fade-in">
                  {validationError}
                </div>
              )}
            </form>
          </DialogPanel>

          <DialogFooter className="px-6 py-4 border-t border-border/40 bg-muted/10 flex items-center justify-between">
            {isEditing ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                Delete Action
              </Button>
            ) : (
              <div />
            )}

            <div className="flex items-center gap-3">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button form={addScriptFormId} type="submit" className="shadow-sm">
                {isEditing ? "Save Changes" : "Create Action"}
              </Button>
            </div>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This action will be permanently removed. You can always recreate it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={confirmDeleteScript}>
              Delete Action
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
