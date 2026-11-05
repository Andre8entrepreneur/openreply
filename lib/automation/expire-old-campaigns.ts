import { prisma } from "@/lib/db/client";
import { getMediaTimestamp } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";

/**
 * Campaign auto-expiry.
 *
 * A campaign bound to one specific post is switched off once that post is
 * older than CAMPAIGN_MAX_POST_AGE_DAYS (default 30). "Any post" and
 * still-pending "next reel" campaigns have no single post, so they never
 * expire. A campaign the owner switches back on keeps its autoExpiredAt
 * stamp and is not switched off again.
 *
 * Runs once a day from /api/cron/expire-old-campaigns: one Graph API call per
 * active post campaign, no Redis.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function maxPostAgeDays(): number {
  const days = Number(process.env.CAMPAIGN_MAX_POST_AGE_DAYS ?? 30);
  return Number.isFinite(days) && days > 0 ? days : 30;
}

/** True when a post published at `timestamp` is past the expiry window. */
export function isPostExpired(
  timestamp: string,
  now: Date,
  maxAgeDays = maxPostAgeDays()
): boolean {
  const publishedMs = Date.parse(timestamp);
  if (Number.isNaN(publishedMs)) return false;
  return now.getTime() - publishedMs > maxAgeDays * DAY_MS;
}

export type ExpireOldCampaignsResult = {
  checked: number;
  expired: number;
  failed: number;
};

export async function expireOldCampaigns(
  now = new Date()
): Promise<ExpireOldCampaignsResult> {
  const campaigns = await prisma.automation.findMany({
    where: {
      isActive: true,
      autoExpiredAt: null,
      matchAnyPost: false,
      pendingNextReel: false,
      postId: { not: null },
    },
    select: {
      id: true,
      name: true,
      postId: true,
      instagramAccount: { select: { provider: true, accessToken: true } },
    },
  });

  // Campaigns can share a post; look each post up once.
  const publishedAt = new Map<string, string | null>();
  let expired = 0;
  let failed = 0;

  for (const campaign of campaigns) {
    const account = campaign.instagramAccount;
    // Only Meta-connected accounts can be looked up directly by media id.
    if (!campaign.postId || account.provider !== "META" || !account.accessToken)
      continue;

    let timestamp = publishedAt.get(campaign.postId);
    if (timestamp === undefined) {
      try {
        timestamp = await getMediaTimestamp(
          decryptToken(account.accessToken),
          campaign.postId
        );
      } catch (error) {
        // Leave the campaign alone when Instagram can't tell us the post age.
        timestamp = null;
        failed += 1;
        console.error(
          "[expire-old-campaigns] post lookup failed",
          campaign.id,
          error instanceof Error ? error.message : error
        );
      }
      publishedAt.set(campaign.postId, timestamp);
    }
    if (!timestamp || !isPostExpired(timestamp, now)) continue;

    await prisma.automation.update({
      where: { id: campaign.id },
      data: { isActive: false, autoExpiredAt: now },
    });
    expired += 1;
    console.log(
      `[expire-old-campaigns] switched off "${campaign.name}" (post from ${timestamp})`
    );
  }

  return { checked: campaigns.length, expired, failed };
}
