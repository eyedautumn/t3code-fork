import { useMemo, useState } from "react";
import type { SwarmState, ThreadId } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

type SwarmConversationPanelProps = {
  threadId: ThreadId;
  swarm: SwarmState;
  onSend: (text: string, targetAgentId: string | null) => Promise<void> | void;
};

export function SwarmConversationPanel({ threadId, swarm, onSend }: SwarmConversationPanelProps) {
  const [message, setMessage] = useState("");
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null);

  const agentOptions = useMemo(
    () =>
      swarm.config.agents.map((agent) => ({
        id: agent.id,
        label: `${agent.name} (${agent.role})`,
      })),
    [swarm.config.agents],
  );

  const sortedMessages = useMemo(
    () => swarm.messages.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [swarm.messages],
  );

  const handleSend = () => {
    if (!message.trim()) return;
    onSend(message.trim(), targetAgentId);
    setMessage("");
  };

  return (
    <Card className="border border-primary/20 bg-muted/5" data-thread-id={threadId}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm">Agent messages</CardTitle>
        <div className="flex items-center gap-2">
          <Select
            value={targetAgentId ?? "broadcast"}
            onValueChange={(value) => setTargetAgentId(value === "broadcast" ? null : value)}
          >
            <SelectTrigger className="h-8 w-48">
              <SelectValue placeholder="Broadcast" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="broadcast">Broadcast</SelectItem>
              {agentOptions.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border border-border/50 p-2 text-xs">
          {sortedMessages.length === 0 && (
            <p className="text-muted-foreground/70">No agent messages yet.</p>
          )}
          {sortedMessages.map((entry) => (
            <div
              key={entry.id}
              className="rounded-md bg-background/60 p-2 ring-1 ring-border/50 backdrop-blur-sm"
            >
              <div className="flex items-center justify-between text-[11px] text-muted-foreground/80">
                <span>
                  {entry.sender === "operator"
                    ? "Operator"
                    : swarm.config.agents.find((agent) => agent.id === entry.senderAgentId)?.name ??
                      "Agent"}
                  {entry.targetAgentId
                    ? ` → ${
                        swarm.config.agents.find((agent) => agent.id === entry.targetAgentId)?.name ??
                        "All"
                      }`
                    : ""}
                </span>
                <span>{new Date(entry.createdAt).toLocaleTimeString()}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-foreground">{entry.text}</p>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Send a note to the swarm…"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                handleSend();
              }
            }}
          />
          <Button onClick={handleSend} disabled={!message.trim()}>
            Send
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
