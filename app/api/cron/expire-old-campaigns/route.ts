import { NextRequest, NextResponse } from "next/server";
import { expireOldCampaigns } from "@/lib/automation/expire-old-campaigns";

/**
 * Switches off campaigns whose post is older than the expiry window
 * (CAMPAIGN_MAX_POST_AGE_DAYS, default 30). Runs once a day (see vercel.json).
 */

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const result = await expireOldCampaigns();

  return NextResponse.json({ success: true, data: result });
}
