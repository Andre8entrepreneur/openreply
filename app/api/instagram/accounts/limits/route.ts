import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";
import {
  getCurrentDMCount,
  getCurrentDailyDMCount,
  RATE_LIMIT_MAX,
} from "@/lib/utils/rate-limiter";

export const runtime = "nodejs";

/**
 * Sending-limits dashboard data: every connected account's configured hourly
 * and daily caps, alongside how much of each bucket is used right now (read
 * straight from the same Redis counters the worker enforces against, so the
 * dashboard can never show a number the worker disagrees with) plus a 7-day
 * sent-DM trend for context.
 */
export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId: context.workspaceId },
    orderBy: { connectedAt: "desc" },
    select: {
      id: true,
      username: true,
      instagramId: true,
      provider: true,
      hourlyDmLimit: true,
      dailyDmLimit: true,
    },
  });

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const trendDays = 7;
  const trendByDay = await Promise.all(
    Array.from({ length: trendDays }, (_, i) => trendDays - 1 - i).map(
      async (daysAgo) => {
        const dayStart = new Date(todayStart);
        dayStart.setDate(dayStart.getDate() - daysAgo);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const rows = await prisma.dmLog.groupBy({
          by: ["instagramAccountId"],
          where: {
            workspaceId: context.workspaceId,
            status: "SENT",
            createdAt: { gte: dayStart, lt: dayEnd },
          },
          _count: { _all: true },
        });

        return {
          date: dayStart.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          }),
          counts: Object.fromEntries(
            rows.map((row) => [row.instagramAccountId, row._count._all])
          ) as Record<string, number>,
        };
      }
    )
  );

  const data = await Promise.all(
    accounts.map(async (account) => {
      const [hourlyUsed, dailyUsed] = await Promise.all([
        getCurrentDMCount(account.instagramId),
        getCurrentDailyDMCount(account.instagramId),
      ]);

      return {
        id: account.id,
        username: account.username,
        provider: account.provider,
        hourlyDmLimit: account.hourlyDmLimit,
        dailyDmLimit: account.dailyDmLimit,
        hourlyUsed,
        dailyUsed,
        trend: trendByDay.map((day) => ({
          date: day.date,
          count: day.counts[account.id] ?? 0,
        })),
      };
    })
  );

  return NextResponse.json({
    success: true,
    data: {
      accounts: data,
      metaHourlyCap: RATE_LIMIT_MAX,
      canManage: canManageWorkspace(context.role),
    },
  });
}

function clampInt(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export async function PATCH(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can change sending limits" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const instagramAccountId =
    typeof body.instagramAccountId === "string" ? body.instagramAccountId : null;
  if (!instagramAccountId) {
    return NextResponse.json(
      { success: false, error: "instagramAccountId is required" },
      { status: 400 }
    );
  }

  // Never let the hourly cap exceed what Meta itself enforces — raising it
  // past RATE_LIMIT_MAX wouldn't send any faster, just mislead the dashboard.
  const hourlyDmLimit = clampInt(body.hourlyDmLimit, 1, RATE_LIMIT_MAX);
  if (hourlyDmLimit === null) {
    return NextResponse.json(
      { success: false, error: "hourlyDmLimit must be a number between 1 and " + RATE_LIMIT_MAX },
      { status: 400 }
    );
  }

  // dailyDmLimit is optional — null/omitted clears the cap entirely.
  let dailyDmLimit: number | null = null;
  if (body.dailyDmLimit !== null && body.dailyDmLimit !== undefined && body.dailyDmLimit !== "") {
    dailyDmLimit = clampInt(body.dailyDmLimit, 1, 100_000);
    if (dailyDmLimit === null) {
      return NextResponse.json(
        { success: false, error: "dailyDmLimit must be a positive number, or omitted for no cap" },
        { status: 400 }
      );
    }
  }

  const { count } = await prisma.instagramAccount.updateMany({
    where: { id: instagramAccountId, workspaceId: context.workspaceId },
    data: { hourlyDmLimit, dailyDmLimit },
  });

  if (count === 0) {
    return NextResponse.json(
      { success: false, error: "Account not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    success: true,
    data: { instagramAccountId, hourlyDmLimit, dailyDmLimit },
  });
}
