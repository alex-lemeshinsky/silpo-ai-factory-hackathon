import { DraftDashboard } from "@/components/autopilot/draft-dashboard";
import { getServerEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const { DATA_MODE: mode } = getServerEnv();

  return (
    <DraftDashboard
      phase={{ kind: "pending", status: "syncing", mode }}
      cartContext={null}
      loyaltyBonusAvailable={null}
      cart={null}
    />
  );
}
