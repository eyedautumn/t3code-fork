import type { SwarmAgentRole } from "@t3tools/contracts";

export const ROLE_COLORS: Record<SwarmAgentRole, string> = {
  coordinator: "#ffffff",
  builder: "#a1a1aa",
  reviewer: "#eab308",
  scout: "#22c55e",
};

const clampAlpha = (value: number) => Math.min(1, Math.max(0, value));

export function colorWithAlpha(hex: string, alpha: number): string {
  const normalized = hex.replace(/^#/, "");
  const alphaHex = Math.round(clampAlpha(alpha) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${normalized}${alphaHex}`;
}
