import { useState, useEffect, useRef, type ReactNode } from "react";
import type { SwarmState, ThreadId } from "@t3tools/contracts";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { 
  TerminalSquare, 
  Activity, 
  Crown, 
  Hammer, 
  Eye, 
  Search, 
  CircleDot,
  Cpu
} from "lucide-react";

import { readNativeApi } from "~/nativeApi";
import { Card } from "../ui/card";
import { cn } from "../../lib/utils";

// Kept locally to avoid circular dependencies and ensure it works standalone
const ROLE_ICONS: Record<SwarmState["config"]["agents"][number]["role"], ReactNode> = {
  coordinator: <Crown className="size-3.5" />,
  builder: <Hammer className="size-3.5" />,
  reviewer: <Eye className="size-3.5" />,
  scout: <Search className="size-3.5" />,
};

const ROLE_COLORS: Record<SwarmState["config"]["agents"][number]["role"], string> = {
  coordinator: "#5b8bf7",
  builder: "#2dd4bf",
  reviewer: "#fbbf24",
  scout: "#34d399",
};

const TERMINAL_ROWS = 24;
const TERMINAL_COLS = 80;

function AgentTerminal({
  agent,
  swarm,
  threadId,
  cwd,
  isActive,
  onMakeActive,
}: {
  agent: SwarmState["config"]["agents"][number];
  swarm: SwarmState;
  threadId: ThreadId;
  cwd: string | null | undefined;
  isActive: boolean;
  onMakeActive: () => void;
}) {
  const api = readNativeApi();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Xterm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const initializedRef = useRef(false);

  const runtime = swarm.agents.find((a) => a.agentId === agent.id);
  const status = runtime?.status ?? "idle";
  const roleColor = ROLE_COLORS[agent.role] || "#94a3b8";
  const [agentSessionId, setAgentSessionId] = useState<string | null>(null);
  const lastSessionIdRef = useRef<string | null>(null);
  const sessionErrorLoggedRef = useRef(false);
  const runtimeUpdatedAt = runtime?.updatedAt;

  // Initialize Terminal
  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;

    const terminalId = `swarm-${agent.id}`;
    const terminalCwd = cwd ?? swarm.config.targetPath ?? "/";

    const terminal = new Xterm({
      rows: TERMINAL_ROWS,
      cols: TERMINAL_COLS,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      theme: {
        background: "#0c0e12", // Deep dark background
        foreground: "#cbd5e1", // Slate 300
        cursor: roleColor,
        selectionBackground: `${roleColor}40`, // 25% opacity
        black: "#1e293b",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#f8fafc",
      },
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    
    // Slight delay to ensure DOM is painted before fitting
    setTimeout(() => fitAddon.fit(), 10);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    initializedRef.current = true;

    terminal.onData((data) => {
      api?.terminal?.write({ threadId, terminalId, data });
    });

    terminal.onResize(({ cols, rows }) => {
      api?.terminal?.resize({ threadId, terminalId, cols, rows });
    });

    api?.terminal?.open({
      threadId,
      terminalId,
      cwd: terminalCwd,
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
    }).catch((err) => {
      terminal.writeln(`\x1b[31m[Error] Failed to open terminal: ${err}\x1b[0m`);
    });

    const unsubscribe = api?.terminal?.onEvent((event) => {
      if (event.threadId !== threadId || event.terminalId !== terminalId) return;

      if (event.type === "output") {
        terminal.write(event.data);
      } else if (event.type === "exited") {
        terminal.writeln(`\r\n\x1b[38;5;240m[Process exited]\x1b[0m`);
      } else if (event.type === "error") {
        terminal.writeln(`\r\n\x1b[31m[Error] ${event.message}\x1b[0m`);
      } else if (event.type === "started" || event.type === "restarted") {
        terminal.clear();
      }
    });

    return () => {
      unsubscribe?.();
      terminal.dispose();
      initializedRef.current = false;
    };
  }, [api, agent.id, threadId, cwd, swarm.config.targetPath, roleColor]);

  useEffect(() => {
    let isCancelled = false;
    if (!api?.server?.fetchSwarmSessions) return undefined;

    const refreshSession = async () => {
      try {
        const sessions = await api.server.fetchSwarmSessions({ threadId });
        if (isCancelled) return;
        const matching = sessions.find((entry) => entry.agentId === agent.id);
        if (isCancelled) return;
        setAgentSessionId(matching?.sessionId ?? null);
        sessionErrorLoggedRef.current = false;
      } catch (error) {
        if (isCancelled) return;
        if (!sessionErrorLoggedRef.current) {
          terminalRef.current?.writeln(
            `\r\n\x1b[31m[Error] Unable to load CLI session info for ${
              agent.name
            }: ${error instanceof Error ? error.message : String(error)}\x1b[0m`,
          );
          sessionErrorLoggedRef.current = true;
        }
      }
    };

    void refreshSession();
    return () => {
      isCancelled = true;
    };
  }, [api?.server, agent.id, agent.name, runtimeUpdatedAt, status, threadId]);

  useEffect(() => {
    if (!agentSessionId) return;
    const terminal = terminalRef.current;
    if (!terminal || lastSessionIdRef.current === agentSessionId) return;
    const command = `codex resume ${agentSessionId}\r`;
    terminal.write(command);
    if (api?.terminal?.write) {
      void api.terminal.write({
        threadId,
        terminalId: `swarm-${agent.id}`,
        data: command,
      });
    }
    lastSessionIdRef.current = agentSessionId;
  }, [api?.terminal, agent.id, agentSessionId, threadId]);

  // Handle Resize Observer to auto-fit terminal when container changes
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !fitAddonRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try { fitAddonRef.current?.fit(); } catch { /* ignore fit errors during unmount */ }
      });
    });

    resizeObserver.observe(el);
    return () => resizeObserver.disconnect();
  }, []);

  return (
    <Card
      onClick={onMakeActive}
      className={cn(
        "flex flex-col overflow-hidden border-border/50 bg-[#0c0e12] transition-all duration-300",
        isActive 
          ? "ring-1 ring-primary/50 shadow-lg shadow-primary/5" 
          : "opacity-60 hover:opacity-100 hover:ring-1 hover:ring-border cursor-pointer"
      )}
    >
      {/* Sleek Terminal Header */}
      <div className={cn(
        "flex items-center justify-between border-b px-3 py-2 transition-colors",
        isActive ? "border-primary/20 bg-primary/5" : "border-border/50 bg-muted/10"
      )}>
        <div className="flex items-center gap-2">
          <div className="flex size-6 items-center justify-center rounded-md bg-background shadow-sm ring-1 ring-border/50" style={{ color: roleColor }}>
            {ROLE_ICONS[agent.role]}
          </div>
          <span className="font-mono text-xs font-semibold text-slate-200 tracking-wide">
            {agent.name}
          </span>
        </div>
        
        <div className="flex items-center gap-2">
          <span className={cn(
            "flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wider",
            status === "running" ? "text-emerald-400" : "text-slate-500"
          )}>
            <CircleDot className={cn("size-2.5", status === "running" && "animate-pulse")} />
            {status}
          </span>
        </div>
      </div>

      {/* Terminal Viewport */}
      <div className="flex-1 p-2 relative min-h-[300px]">
        {/* If inactive, put an invisible overlay so dragging text doesn't mess up terminal selection */}
        {!isActive && <div className="absolute inset-0 z-10" />}
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </Card>
  );
}

export function SwarmTerminalsView({
  swarm,
  threadId,
  cwd,
}: {
  swarm: SwarmState;
  threadId: ThreadId;
  cwd?: string | null | undefined;
}) {
  const [activeAgentId, setActiveAgentId] = useState<string | null>(
    swarm.config.agents[0]?.id ?? null
  );

  // Ensure active agent is valid if the agent list changes
  useEffect(() => {
    if (activeAgentId && !swarm.config.agents.find(a => a.id === activeAgentId)) {
      setActiveAgentId(swarm.config.agents[0]?.id ?? null);
    }
  }, [swarm.config.agents, activeAgentId]);

  if (swarm.config.agents.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center bg-background/95 text-center opacity-60">
        <Cpu className="mb-4 size-10 text-muted-foreground/50" />
        <h3 className="font-mono text-sm font-semibold text-slate-300">No agents configured</h3>
        <p className="mt-1 text-xs text-slate-500">Terminals will appear here once agents are spun up.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-background/95 p-4 sm:p-5 gap-4">
      
      {/* Header & Segmented Tabs */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between shrink-0">
        <div className="flex items-center gap-2 text-foreground">
          <TerminalSquare className="size-5 text-primary" />
          <h2 className="text-sm font-semibold tracking-wide">Swarm Terminals</h2>
        </div>

        {/* Tab Scroller */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0 scrollbar-hide mask-edges">
          {swarm.config.agents.map((agent) => {
            const runtime = swarm.agents.find((a) => a.agentId === agent.id);
            const status = runtime?.status ?? "idle";
            const isActive = activeAgentId === agent.id;
            const roleColor = ROLE_COLORS[agent.role] || "#94a3b8";

            return (
              <button
                key={agent.id}
                onClick={() => setActiveAgentId(agent.id)}
                className={cn(
                  "group relative flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-xs transition-all duration-200",
                  isActive
                    ? "bg-background shadow-sm ring-1"
                    : "border-border/50 bg-muted/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                )}
                style={{
                  borderColor: isActive ? roleColor : undefined,
                  boxShadow: isActive ? `0 0 12px ${roleColor}15` : undefined,
                }}
              >
                <div 
                  className={cn("flex size-4 items-center justify-center rounded-full transition-colors", isActive ? "text-background" : "")}
                  style={{ backgroundColor: isActive ? roleColor : 'transparent', color: isActive ? '#000' : roleColor }}
                >
                  {ROLE_ICONS[agent.role]}
                </div>
                <span className={cn("font-medium tracking-tight", isActive ? "text-foreground" : "")}>
                  {agent.name}
                </span>
                {status === "running" && (
                  <Activity className={cn("size-3 animate-pulse", isActive ? "text-emerald-500" : "text-emerald-500/50")} />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Terminal Grid */}
      <div className="grid flex-1 min-h-0 gap-4 overflow-y-auto pb-2 grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 auto-rows-[minmax(350px,1fr)]">
        {swarm.config.agents.map((agent) => {
          const isActive = activeAgentId === agent.id;

          return (
            <AgentTerminal
              key={agent.id}
              agent={agent}
              swarm={swarm}
              threadId={threadId}
              cwd={cwd}
              isActive={isActive}
              onMakeActive={() => setActiveAgentId(agent.id)}
            />
          );
        })}
      </div>
    </div>
  );
}
