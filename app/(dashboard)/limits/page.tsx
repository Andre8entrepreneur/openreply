"use client";

/**
 * Sending Limits
 *
 * Per-account dials on DM send volume, so a self-hoster can throttle below
 * Instagram's own caps on purpose — the thing a hosted tool like ManyChat
 * does for you behind a paywall, here as a page you configure yourself.
 *
 * Two independent caps per account:
 * - Hourly: a ceiling on top of Meta's own 750/hour private-reply limit
 *   (lib/utils/rate-limiter.ts). Can only go lower than 750, never higher.
 * - Daily: optional, user-only — no cap unless you set one. Applies to every
 *   kind of DM this account sends (private replies, button-tap reveals, and
 *   DM-triggered replies), since total daily volume is what mainly drives a
 *   new or small account's ban risk, not any single API call's own cap.
 *
 * Both are rolling windows (past hour / past 24h), not aligned to the clock.
 */

import { useEffect, useState } from "react";

interface AccountLimits {
  id: string;
  username: string;
  provider: "META" | "ZERNIO";
  hourlyDmLimit: number;
  dailyDmLimit: number | null;
  hourlyUsed: number;
  dailyUsed: number;
  trend: { date: string; count: number }[];
}

interface LimitsResponse {
  accounts: AccountLimits[];
  metaHourlyCap: number;
  canManage: boolean;
}

function meterColor(fraction: number): string {
  if (fraction >= 0.9) return "bg-error";
  if (fraction >= 0.7) return "bg-warning";
  return "bg-accent";
}

function Meter({
  label,
  used,
  limit,
  hint,
}: {
  label: string;
  used: number;
  limit: number | null;
  hint?: string;
}) {
  const fraction = limit ? Math.min(used / limit, 1) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {label}
        </span>
        <span className="text-sm font-medium text-foreground">
          {used.toLocaleString()}
          {limit !== null && (
            <span className="text-muted"> / {limit.toLocaleString()}</span>
          )}
        </span>
      </div>
      <div className="mt-2 h-2 w-full rounded-full bg-surface-hover overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] ${
            limit ? meterColor(fraction) : "bg-zinc-300"
          }`}
          style={{ width: limit ? `${Math.max(fraction * 100, used > 0 ? 2 : 0)}%` : "0%" }}
        />
      </div>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function Sparkline({ trend }: { trend: { date: string; count: number }[] }) {
  const max = Math.max(...trend.map((d) => d.count), 1);
  return (
    <div className="flex items-end gap-1 h-12">
      {trend.map((day) => (
        <div
          key={day.date}
          className="min-w-0 flex-1 h-full flex flex-col items-center justify-end gap-1"
          title={`${day.date}: ${day.count} sent`}
        >
          <div className="w-full flex items-end" style={{ height: "100%" }}>
            <div
              className="w-full rounded-sm bg-accent/70 min-h-[2px]"
              style={{ height: `${Math.max((day.count / max) * 100, day.count > 0 ? 6 : 0)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function AccountLimitCard({
  account,
  metaHourlyCap,
  canManage,
  onSave,
}: {
  account: AccountLimits;
  metaHourlyCap: number;
  canManage: boolean;
  onSave: (id: string, hourlyDmLimit: number, dailyDmLimit: number | null) => Promise<string | null>;
}) {
  const [hourly, setHourly] = useState(String(account.hourlyDmLimit));
  const [dailyEnabled, setDailyEnabled] = useState(account.dailyDmLimit !== null);
  const [daily, setDaily] = useState(
    account.dailyDmLimit !== null ? String(account.dailyDmLimit) : ""
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty =
    Number(hourly) !== account.hourlyDmLimit ||
    (dailyEnabled ? Number(daily) : null) !== account.dailyDmLimit;

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    const hourlyNum = Math.min(metaHourlyCap, Math.max(1, Math.round(Number(hourly) || 0)));
    const dailyNum = dailyEnabled ? Math.max(1, Math.round(Number(daily) || 0)) : null;
    const result = await onSave(account.id, hourlyNum, dailyNum);
    setSaving(false);
    if (result) {
      setError(result);
    } else {
      setHourly(String(hourlyNum));
      setDaily(dailyNum !== null ? String(dailyNum) : "");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  const hourlyNearCap = account.hourlyUsed / account.hourlyDmLimit >= 0.9;
  const dailyNearCap =
    account.dailyDmLimit !== null && account.dailyUsed / account.dailyDmLimit >= 0.9;

  return (
    <div className="panel rounded p-4 sm:p-6 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">@{account.username}</p>
          <p className="text-xs text-muted mt-0.5">
            {account.provider === "ZERNIO" ? "Connected via Zernio" : "Direct Meta connection"}
          </p>
        </div>
        {(hourlyNearCap || dailyNearCap) && (
          <span className="shrink-0 rounded-full bg-warning/10 px-3 py-1 text-xs font-medium text-warning">
            Near limit
          </span>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Meter
          label="This hour"
          used={account.hourlyUsed}
          limit={account.hourlyDmLimit}
          hint={`Meta's hard cap is ${metaHourlyCap}/hour for private replies — this account is set below that.`}
        />
        <Meter
          label="Last 24 hours"
          used={account.dailyUsed}
          limit={account.dailyDmLimit}
          hint={
            account.dailyDmLimit === null
              ? "No daily cap set — only the hourly limit applies."
              : "Covers every DM this account sends, not just comment replies."
          }
        />
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
          7-day sent volume
        </p>
        <Sparkline trend={account.trend} />
      </div>

      <div className="border-t border-border pt-4 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-xs font-medium text-foreground">Hourly limit</span>
          <input
            type="number"
            min={1}
            max={metaHourlyCap}
            value={hourly}
            disabled={!canManage}
            onChange={(e) => setHourly(e.target.value)}
            className="rounded border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40 disabled:opacity-50"
          />
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="flex items-center justify-between text-xs font-medium text-foreground">
            Daily limit
            <button
              type="button"
              disabled={!canManage}
              onClick={() => setDailyEnabled((v) => !v)}
              className="text-xs font-normal text-accent hover:underline disabled:opacity-50"
            >
              {dailyEnabled ? "Remove cap" : "Set a cap"}
            </button>
          </span>
          <input
            type="number"
            min={1}
            placeholder="No cap"
            value={daily}
            disabled={!canManage || !dailyEnabled}
            onChange={(e) => setDaily(e.target.value)}
            className="rounded border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40 disabled:opacity-50 disabled:placeholder:text-muted"
          />
        </label>

        {canManage && (
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            className="h-fit rounded bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? "Saving..." : saved ? "Saved" : "Save"}
          </button>
        )}
      </div>
      {error && <p className="text-sm text-error">{error}</p>}
    </div>
  );
}

export default function SendingLimitsPage() {
  const [data, setData] = useState<LimitsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  function load() {
    fetch("/api/instagram/accounts/limits")
      .then((r) => r.json())
      .then((res) => {
        if (res.success) setData(res.data);
      })
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleSave(
    instagramAccountId: string,
    hourlyDmLimit: number,
    dailyDmLimit: number | null
  ): Promise<string | null> {
    const res = await fetch("/api/instagram/accounts/limits", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instagramAccountId, hourlyDmLimit, dailyDmLimit }),
    });
    const payload = await res.json();
    if (!payload.success) return payload.error ?? "Could not save";
    load();
    return null;
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {[...Array(2)].map((_, i) => (
          <div key={i} className="panel rounded p-6 h-64 animate-pulse" />
        ))}
      </div>
    );
  }

  const accounts = data?.accounts ?? [];

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Sending Limits</h1>
        <p className="text-sm text-muted mt-1">
          Set how many DMs each connected account is allowed to send, so you stay
          comfortably under Instagram&apos;s caps instead of right at the edge of them.
        </p>
      </div>

      <div className="panel rounded p-4 sm:p-6 text-sm text-muted space-y-2">
        <p>
          <span className="font-medium text-foreground">Meta&apos;s own hard cap</span> is{" "}
          {data?.metaHourlyCap ?? 750} private replies per hour, per account — OpenReply
          already enforces that regardless of what&apos;s set below.
        </p>
        <p>
          A conservative starting point for a <span className="font-medium text-foreground">new or small account</span>:
          keep the daily limit low (50–150) for the first couple of weeks, then raise it
          gradually as it sends without errors. Established accounts with a steady history
          can usually run closer to the hourly cap.
        </p>
      </div>

      {accounts.length === 0 ? (
        <div className="panel rounded p-8 text-center">
          <p className="text-sm text-muted">No Instagram accounts connected yet.</p>
          <a
            href="/settings"
            className="mt-3 inline-block text-sm text-accent hover:underline"
          >
            Connect an account
          </a>
        </div>
      ) : (
        <div className="space-y-6">
          {accounts.map((account) => (
            <AccountLimitCard
              key={account.id}
              account={account}
              metaHourlyCap={data?.metaHourlyCap ?? 750}
              canManage={data?.canManage ?? false}
              onSave={handleSave}
            />
          ))}
        </div>
      )}
    </div>
  );
}
