import { getDashboardOverview, getTopContent, getTopSounds, type DashboardOverview, type TopPerformer } from "../repositories/dashboard.repository.js";
import type { SafeUser } from "../types/auth.js";

export interface DashboardData extends DashboardOverview {
  topContent: TopPerformer[];
  topSounds: TopPerformer[];
}

export async function getDashboard(actor: SafeUser): Promise<DashboardData> {
  const [overview, topContent, topSounds] = await Promise.all([
    getDashboardOverview(actor.organizationId),
    getTopContent(actor.organizationId),
    getTopSounds(actor.organizationId),
  ]);
  return { ...overview, topContent, topSounds };
}
