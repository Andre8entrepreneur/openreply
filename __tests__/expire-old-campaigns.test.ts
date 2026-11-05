import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
const update = vi.fn();
const getMediaTimestamp = vi.fn();

vi.mock("@/lib/db/client", () => ({
  prisma: { automation: { findMany, update } },
}));
vi.mock("@/lib/meta/client", () => ({ getMediaTimestamp }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (t: string) => `dec:${t}` }));

const { expireOldCampaigns, isPostExpired } = await import(
  "../lib/automation/expire-old-campaigns"
);

const NOW = new Date("2026-11-05T12:00:00Z");
const metaAccount = { provider: "META", accessToken: "tok" };

describe("isPostExpired", () => {
  it("is false at exactly 30 days and true just after", () => {
    expect(isPostExpired("2026-10-06T12:00:00Z", NOW, 30)).toBe(false);
    expect(isPostExpired("2026-10-06T11:59:00Z", NOW, 30)).toBe(true);
  });

  it("never expires on an unreadable timestamp", () => {
    expect(isPostExpired("not a date", NOW, 30)).toBe(false);
  });
});

describe("expireOldCampaigns", () => {
  beforeEach(() => {
    findMany.mockReset();
    update.mockReset();
    getMediaTimestamp.mockReset();
  });

  it("only queries active, never-expired, single-post campaigns", async () => {
    findMany.mockResolvedValue([]);
    await expireOldCampaigns(NOW);
    expect(findMany.mock.calls[0][0].where).toEqual({
      isActive: true,
      autoExpiredAt: null,
      matchAnyPost: false,
      pendingNextReel: false,
      postId: { not: null },
    });
  });

  it("switches off campaigns on old posts and keeps recent ones", async () => {
    findMany.mockResolvedValue([
      { id: "old", name: "Old", postId: "p1", instagramAccount: metaAccount },
      { id: "new", name: "New", postId: "p2", instagramAccount: metaAccount },
    ]);
    getMediaTimestamp.mockImplementation(async (_t: string, id: string) =>
      id === "p1" ? "2026-09-01T00:00:00Z" : "2026-11-01T00:00:00Z"
    );

    const result = await expireOldCampaigns(NOW);

    expect(result).toEqual({ checked: 2, expired: 1, failed: 0 });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "old" },
      data: { isActive: false, autoExpiredAt: NOW },
    });
    expect(getMediaTimestamp).toHaveBeenCalledWith("dec:tok", "p1");
  });

  it("looks up a shared post once and leaves campaigns alone on lookup failure", async () => {
    findMany.mockResolvedValue([
      { id: "a", name: "A", postId: "p1", instagramAccount: metaAccount },
      { id: "b", name: "B", postId: "p1", instagramAccount: metaAccount },
    ]);
    getMediaTimestamp.mockRejectedValue(new Error("Meta 100"));

    const result = await expireOldCampaigns(NOW);

    expect(getMediaTimestamp).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 2, expired: 0, failed: 1 });
  });
});
