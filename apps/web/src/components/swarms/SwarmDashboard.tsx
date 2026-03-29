import { SwarmDashboardV2, type SwarmDashboardProps } from "./SwarmDashboardV2";

export type { SwarmDashboardProps } from "./SwarmDashboardV2";

export function SwarmDashboard(props: SwarmDashboardProps) {
  return <SwarmDashboardV2 {...props} />;
}
