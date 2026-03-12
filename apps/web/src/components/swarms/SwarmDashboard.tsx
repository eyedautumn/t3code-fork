import type { SwarmState, ThreadId } from "@t3tools/contracts";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Separator } from "../ui/separator";
import { cn } from "../../lib/utils";
import { SwarmConversationPanel } from "./SwarmConversationPanel";

type SwarmDashboardProps = {
  threadId: ThreadId;
  swarm: SwarmState;
  onSendMessage: (text: string, targetAgentId: string | null) => Promise<void> | void;
};

type Connector = {
  from: { x: number; y: number; id: string };
  to: { x: number; y: number; id: string };
};

const STATUS_COLOR: Record<SwarmState["agents"][number]["status"], string> = {
  idle: "bg-muted text-foreground",
  starting: "bg-amber-500/20 text-amber-200",
  running: "bg-sky-500/20 text-sky-100",
  ready: "bg-emerald-500/20 text-emerald-100",
  blocked: "bg-red-500/20 text-red-100",
  completed: "bg-emerald-600/20 text-emerald-50",
  stopped: "bg-muted text-muted-foreground",
  error: "bg-red-600/20 text-red-100",
};

export function SwarmDashboard({ threadId, swarm, onSendMessage }: SwarmDashboardProps) {
  const pyramidRows = RANK_ORDER
    .map((role) => ({
      role,
      agents: swarm.config.agents.filter((agent) => agent.role === role),
    }))
    .filter((row) => row.agents.length > 0);

  const connectors = buildConnectors(pyramidRows);

  return (
    <div className="space-y-4 border-b border-border/70 bg-muted/5 px-3 py-3 sm:px-5 sm:py-4">
      <div className="flex flex-col gap-4 xl:flex-row">
        <Card className="relative flex-1 overflow-hidden border-primary/40 bg-gradient-to-br from-background/70 via-background to-primary/5">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(99,102,241,0.08),transparent_35%),radial-gradient(circle_at_80%_10%,rgba(34,197,94,0.06),transparent_30%),radial-gradient(circle_at_50%_90%,rgba(14,165,233,0.06),transparent_35%)]" />
          <CardHeader className="relative z-10 pb-2 sm:pb-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-sm uppercase tracking-[0.08em] text-muted-foreground">
                  Swarm command view
                </CardTitle>
                <div className="text-lg font-semibold text-foreground">{swarm.config.name}</div>
                <p className="text-sm text-muted-foreground/80">{swarm.config.mission}</p>
              </div>
              <Badge className="bg-primary/15 text-primary">Swarm page</Badge>
            </div>
          </CardHeader>
          <CardContent className="relative z-10">
            <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-background/60 px-3 py-4 shadow-inner">
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="pointer-events-none absolute inset-0 h-full w-full opacity-70"
              >
                {connectors.map((line) => (
                  <line
                    key={`${line.from.id}-${line.to.id}-${line.from.x}-${line.to.x}-${line.from.y}-${line.to.y}`}
                    x1={line.from.x}
                    y1={line.from.y}
                    x2={line.to.x}
                    y2={line.to.y}
                    stroke="url(#swarm-line)"
                    strokeWidth={0.4}
                    strokeLinecap="round"
                    opacity={0.7}
                  />
                ))}
                <defs>
                  <linearGradient id="swarm-line" x1="0" x2="1" y1="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.55" />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0.15" />
                  </linearGradient>
                </defs>
              </svg>

              <div className="relative flex flex-col gap-6">
                {pyramidRows.length === 0 ? (
                  <div className="rounded-lg border border-border/70 bg-background/60 px-4 py-6 text-center text-sm text-muted-foreground">
                    Swarm agents will appear here once configured.
                  </div>
                ) : (
                  pyramidRows.map((row, rowIndex) => (
                    <div
                      key={row.role}
                      className="flex flex-wrap items-center justify-center gap-3"
                      style={{ marginTop: rowIndex === 0 ? 0 : -6 }}
                    >
                      {row.agents.map((agent) => {
                        const runtime = swarm.agents.find((entry) => entry.agentId === agent.id);
                        return (
                          <div
                            key={agent.id}
                            className={cn(
                              "relative w-[210px] min-w-[190px] max-w-[230px] overflow-hidden rounded-xl border shadow-sm transition-transform duration-150 hover:-translate-y-0.5",
                              ROLE_STYLES[agent.role].card,
                            )}
                          >
                            <div
                              className="absolute inset-0 opacity-60"
                              style={{
                                background:
                                  "radial-gradient(circle at 20% 20%, rgba(255,255,255,0.08), transparent 35%),radial-gradient(circle at 80% 10%, rgba(255,255,255,0.08), transparent 35%)",
                              }}
                            />
                            <div className="relative space-y-1 px-4 py-3">
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-sm font-semibold text-foreground">{agent.name}</div>
                                <Badge className={cn("capitalize", STATUS_COLOR[runtime?.status ?? "idle"])}>
                                  {runtime?.status ?? "idle"}
                                </Badge>
                              </div>
                              <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground/80">
                                {agent.role}
                              </div>
                              <div className="text-xs text-muted-foreground">{agent.model ?? "Model TBD"}</div>
                              <div className="mt-2 flex items-center gap-2 text-[11px] text-primary/90">
                                <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
                                {ROLE_STYLES[agent.role].tagline}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </div>
          </CardContent>
        </Card>
        <div className="xl:w-96">
          <SwarmConversationPanel
            threadId={threadId}
            swarm={swarm}
            onSend={onSendMessage}
          />
        </div>
      </div>
      <Separator />
    </div>
  );
}

type PyramidRows = Array<{
  role: SwarmState["config"]["agents"][number]["role"];
  agents: SwarmState["config"]["agents"];
}>;

const RANK_ORDER: SwarmState["config"]["agents"][number]["role"][] = [
  "coordinator",
  "reviewer",
  "builder",
  "scout",
];

const ROLE_STYLES: Record<
  SwarmState["config"]["agents"][number]["role"],
  { card: string; tagline: string }
> = {
  coordinator: {
    card: "border-primary/50 bg-primary/10",
    tagline: "Directs strategy & unlocks decisions",
  },
  reviewer: {
    card: "border-amber-400/40 bg-amber-400/10",
    tagline: "Guards quality & signals risks",
  },
  builder: {
    card: "border-emerald-400/40 bg-emerald-400/10",
    tagline: "Builds increments & ships code",
  },
  scout: {
    card: "border-sky-400/40 bg-sky-400/10",
    tagline: "Scans unknowns & reports findings",
  },
};

function buildConnectors(rows: PyramidRows): Connector[] {
  if (rows.length <= 1) return [];

  const yStep = rows.length > 1 ? 100 / (rows.length - 1) : 100;

  const connectors: Connector[] = [];

  rows.forEach((row, rowIndex) => {
    const nextRow = rows[rowIndex + 1];
    if (!nextRow) return;

    row.agents.forEach((agent, agentIndex) => {
      const fromX = ((agentIndex + 1) / (row.agents.length + 1)) * 100;
      const fromY = rowIndex * yStep;

      nextRow.agents.forEach((nextAgent, nextIndex) => {
        const toX = ((nextIndex + 1) / (nextRow.agents.length + 1)) * 100;
        const toY = (rowIndex + 1) * yStep;

        connectors.push({
          from: { x: fromX, y: fromY, id: agent.id },
          to: { x: toX, y: toY, id: nextAgent.id },
        });
      });
    });
  });

  return connectors;
}
