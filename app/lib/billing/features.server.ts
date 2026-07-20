import type { Channel, Plan } from "@prisma/client";

export type ChannelAccess =
  { allowed: true } | { allowed: false; reason: string };

/** Phase 6 replaces these permissive defaults with plan-specific gates. */
export function channelAccessForPlan(
  _plan: Plan,
  _channel: Channel,
): ChannelAccess {
  return { allowed: true };
}
