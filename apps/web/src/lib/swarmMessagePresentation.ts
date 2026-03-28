export function getSwarmMessageRouteLabel(input: {
  sender: "agent" | "operator";
  senderName: string;
  targetAgentId: string | null;
  getAgentName: (id: string) => string;
}): string {
  if (input.targetAgentId) {
    return `${input.senderName} -> ${input.getAgentName(input.targetAgentId)}`;
  }
  if (input.sender === "operator") {
    return `${input.senderName} -> All Agents`;
  }
  return `${input.senderName} output`;
}
