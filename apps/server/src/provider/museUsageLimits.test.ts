import { describe, expect, it } from "vite-plus/test";

import { isMuseSubscriptionUsage, museUsageToLimits } from "./museUsageLimits.ts";

describe("museUsageToLimits", () => {
  it("maps 5-hour + weekly windows with reset timestamps", () => {
    expect(
      museUsageToLimits({
        observedAtMs: Date.parse("2026-10-06T12:00:00.000Z"),
        tier: "pro",
        weekly: { usedPercent: 18.4, resetsAtMs: Date.parse("2026-10-13T12:00:00.000Z") },
        window: {
          usedPercent: 54,
          resetsAtMs: Date.parse("2026-10-06T17:00:00.000Z"),
          windowDurationMins: 300,
        },
      }),
    ).toEqual({
      checkedAt: "2026-10-06T12:00:00.000Z",
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "5-hour",
          usedPercent: 54,
          resetsAt: "2026-10-06T17:00:00.000Z",
          windowDurationMins: 300,
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 18.4,
          resetsAt: "2026-10-13T12:00:00.000Z",
        },
      ],
    });
  });

  it("clamps values above 100% so they never violate the T3 contract", () => {
    const limits = museUsageToLimits({
      observedAtMs: Date.parse("2026-10-06T12:00:00.000Z"),
      tier: "pro",
      weekly: { usedPercent: 142.7, resetsAtMs: Date.parse("2026-10-13T12:00:00.000Z") },
      window: {
        usedPercent: 118.2,
        resetsAtMs: Date.parse("2026-10-06T17:00:00.000Z"),
        windowDurationMins: 300,
      },
    });
    expect(limits.windows.map((window) => window.usedPercent)).toEqual([100, 100]);
  });

  it("validates the subscription payload shape", () => {
    expect(
      isMuseSubscriptionUsage({
        observedAtMs: 1,
        weekly: { usedPercent: 1, resetsAtMs: 2 },
        window: { usedPercent: 3, resetsAtMs: 4, windowDurationMins: 300 },
      }),
    ).toBe(true);
    expect(isMuseSubscriptionUsage({})).toBe(false);
    expect(isMuseSubscriptionUsage(null)).toBe(false);
  });
});
