/**
 * museUsageLimits — map Muse MSP subscription usage into T3 usage windows.
 *
 * Muse `usage/read` returns approximately:
 *   { observedAtMs, tier, weekly: { usedPercent, resetsAtMs },
 *     window: { usedPercent, resetsAtMs, windowDurationMins } }
 * Muse explicitly allows values above 100%; T3's ServerProviderUsageWindow
 * contract is capped at 100, so clamp at the boundary (raw preserved by caller
 * if needed).
 *
 * @module provider/museUsageLimits
 */
import type { ServerProviderUsageLimits } from "@t3tools/contracts";

import { clampPercent, makeUsageLimits } from "./providerUsageLimits.ts";

export interface MuseSubscriptionUsage {
  readonly observedAtMs: number;
  readonly tier?: string;
  readonly weekly: {
    readonly usedPercent: number;
    readonly resetsAtMs: number;
  };
  readonly window: {
    readonly usedPercent: number;
    readonly resetsAtMs: number;
    readonly windowDurationMins: number;
  };
}

export function museUsageToLimits(usage: MuseSubscriptionUsage): ServerProviderUsageLimits {
  const checkedAt = new Date(usage.observedAtMs).toISOString();
  return makeUsageLimits({
    checkedAt,
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "5-hour",
        usedPercent: clampPercent(usage.window.usedPercent),
        resetsAt: new Date(usage.window.resetsAtMs).toISOString(),
        windowDurationMins: usage.window.windowDurationMins,
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: clampPercent(usage.weekly.usedPercent),
        resetsAt: new Date(usage.weekly.resetsAtMs).toISOString(),
      },
    ],
  });
}

export function isMuseSubscriptionUsage(value: unknown): value is MuseSubscriptionUsage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const weekly = record.weekly as Record<string, unknown> | undefined;
  const window = record.window as Record<string, unknown> | undefined;
  return (
    typeof record.observedAtMs === "number" &&
    typeof weekly?.usedPercent === "number" &&
    typeof weekly?.resetsAtMs === "number" &&
    typeof window?.usedPercent === "number" &&
    typeof window?.resetsAtMs === "number" &&
    typeof window?.windowDurationMins === "number"
  );
}
