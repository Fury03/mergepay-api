import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  feeStats: vi.fn(),
}));

vi.mock("../src/db", () => ({
  prisma: { $queryRaw: h.queryRaw },
}));

vi.mock("../src/services/network", () => ({
  getFeeStats: h.feeStats,
}));

import { buildApp } from "../src/app";
import { clearReadinessCache } from "../src/services/health";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  clearReadinessCache();
  h.queryRaw.mockResolvedValue([{ 1: 1 }]);
  h.feeStats.mockResolvedValue({ minAcceptedFee: 100 });
  // checkAnchor reads process.env live at call time; unset it here (after
  // config's own startup validation already ran) so readiness reports the
  // anchor check as "disabled" instead of making a real network call.
  vi.stubEnv("ANCHOR_HOME_DOMAIN", "");
  if (!app) app = await buildApp();
});

describe("health routes", () => {
  it("returns liveness without checking dependencies", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      timestamp: expect.any(String),
    });
    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(h.feeStats).not.toHaveBeenCalled();
  });

  it("returns ready when database and Stellar are available", async () => {
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      checks: { database: "up", stellar: "up", anchor: "disabled" },
    });
  });

  it("returns not ready when the database is unavailable", async () => {
    h.queryRaw.mockRejectedValueOnce(new Error("password=secret SQL error"));

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      checks: { database: "down" },
    });
    expect(JSON.stringify(response.json())).not.toContain("password");
    expect(JSON.stringify(response.json())).not.toContain("SQL");
  });

  it("returns not ready when Stellar times out", async () => {
    h.feeStats.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({}), 2_000))
    );

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      checks: { stellar: "down" },
    });
  }, 3_000);

  it("returns not ready when the database check times out", async () => {
    h.queryRaw.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve([{ 1: 1 }]), 2_000))
    );

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      checks: { database: "down" },
    });
  }, 3_000);

  it("does not leak connection-string details when the database fails", async () => {
    h.queryRaw.mockRejectedValueOnce(
      new Error(
        "connect ECONNREFUSED postgresql://user:secret@db.internal:5432/mergepay"
      )
    );

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      checks: { database: "down" },
    });
    const body = JSON.stringify(response.json());
    expect(body).not.toContain("postgresql://");
    expect(body).not.toContain("db.internal");
    expect(body).not.toContain("secret");
  });

  it("serves health probes without authentication", async () => {
    // No Authorization header at all: health routes are outside the auth
    // plugin and application business authorization, so a probe never 401s.
    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);

    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect([200, 503]).toContain(ready.statusCode);
  });
});
