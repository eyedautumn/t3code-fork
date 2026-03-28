import type { SwarmDashboardProps } from "./SwarmDashboardV1";
import { SwarmDashboardV1 } from "./SwarmDashboardV1";
import { SwarmDashboardV2 } from "./SwarmDashboardV2";

export function SwarmDashboard({ useExperimentalV2 = false, ...props }: SwarmDashboardProps) {
  return useExperimentalV2 ? <SwarmDashboardV2 {...props} /> : <SwarmDashboardV1 {...props} />;
}
