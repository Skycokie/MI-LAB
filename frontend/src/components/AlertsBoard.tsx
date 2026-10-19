"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCheck,
  BarChart3,
  Grid3x3,
  Layers,
  Sparkles,
  ShieldAlert,
} from "lucide-react";
import {
  fetchJson,
  postJson,
  withRefresh,
  type AlertsListResponse,
  type AlertsRiskResponse,
  type LabAlert,
} from "@/lib/api";
import { useLab, type OpenTarget } from "@/context/LabContext";

function fmtTime(ts: number): string {
  try {
    return new Date(ts * 1000).toLocaleString("ro-RO", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function severityClass(s: string): string {
  if (s === "critical") return "text-rose-400 border-rose-800/60 bg-rose-950/40";
  if (s === "warn") return "text-amber-400 border-amber-800/60 bg-amber-950/30";
  return "text-sky-400 border-sky-800/60 bg-sky-950/30";
}

function OpenBtn({
  label,
  target,
  symbol,
}: {
  label: string;
  target: OpenTarget;
  symbol: string;
}) {
  const { openSymbol } = useLab();
  return (
    <button
      type="button"
      onClick={() => openSymbol(symbol, target)}
      className="inline-flex items-center gap-1 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-amber-500 hover:text-amber-400"
    >
      {label}
    </button>
  );
}

export default function AlertsBoard() {
  const { refreshKey } = useLab();
  const [alerts, setAlerts] = useState<LabAlert[]>([]);
  const [unread, setUnread] = useState(0);
  const [risk, setRisk] = useState<AlertsRiskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const requestKey = `alerts|${refreshKey}`;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        if (refreshKey > 0) {
          setScanning(true);
          await postJson("/api/alerts/run", {});
        }
        const [list, riskRes] = await Promise.all([
          fetchJson<AlertsListResponse>(
            withRefresh("/api/alerts?limit=100", refreshKey),
          ),
          fetchJson<AlertsRiskResponse>("/api/alerts/risk"),
        ]);
        if (cancelled) return;
        setAlerts(list.alerts);
        setUnread(list.unread);
        setRisk(riskRes);
        setError(null);
        setFetchedFor(requestKey);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setFetchedFor(requestKey);
      } finally {
        if (!cancelled) setScanning(false);
      }
    }

    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshKey, requestKey]);

  async function markAllRead() {
    try {
      const res = await postJson<{ unread: number }>("/api/alerts/mark-read", {
        all: true,
      });
      setUnread(res.unread);
      setAlerts((prev) => prev.map((a) => ({ ...a, read: true })));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const loading = fetchedFor !== requestKey;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-zinc-100">
            <Bell className="h-5 w-5 text-amber-400" />
            Alerte Watchlist
            {unread > 0 && (
              <span className="rounded-full bg-amber-500 px-2 py-0.5 text-xs font-bold text-black">
                {unread}
              </span>
            )}
          </h2>
          <p className="text-xs text-zinc-500">
            Breakout 20z · RVOL×2 · RSI · move 3%/30m · news · risk Alpaca Paper
            {scanning ? " · scanning…" : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void markAllRead()}
          disabled={unread === 0}
          className="inline-flex items-center gap-1.5 rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-amber-500 hover:text-amber-400 disabled:opacity-40"
        >
          <CheckCheck className="h-3.5 w-3.5" />
          Mark all read
        </button>
      </div>

      {/* Risk panel */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <h3 className="mb-3 inline-flex items-center gap-2 text-sm font-medium text-zinc-200">
          <ShieldAlert className="h-4 w-4 text-rose-400" />
          Risk check (Alpaca Paper)
        </h3>
        {!risk ? (
          <p className="text-xs text-zinc-600">Loading risk…</p>
        ) : !risk.available ? (
          <p className="text-xs text-zinc-500">
            {risk.message || "Risk indisponibil"}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Equity" value={`$${risk.account.equity.toLocaleString()}`} />
              <Stat
                label="Margin used"
                value={`${risk.account.margin_used_pct.toFixed(1)}%`}
              />
              <Stat
                label="Day P/L"
                value={`${risk.account.day_pl_pct >= 0 ? "+" : ""}${risk.account.day_pl_pct.toFixed(2)}%`}
              />
              <Stat
                label="Fără stop-loss"
                value={String(risk.positions_without_stop_count)}
                warn={risk.positions_without_stop_count > 0}
              />
            </div>
            {risk.positions_without_stop_count > 0 && (
              <ul className="space-y-1 text-xs text-rose-300/90">
                {risk.positions_without_stop.map((p) => (
                  <li key={p.symbol}>
                    {p.symbol}: qty {p.qty} · MV ${p.market_value.toFixed(0)} ·{" "}
                    {p.unrealized_plpc.toFixed(2)}% — fără stop
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {loading && (
        <p className="text-sm text-zinc-500">Loading alerts…</p>
      )}
      {error && (
        <p className="text-sm text-rose-400">{error}</p>
      )}

      {!loading && alerts.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-12 text-zinc-600">
          <AlertTriangle className="h-8 w-8 opacity-40" />
          <p className="text-sm">Nicio alertă încă. Sync watchlist + Refresh.</p>
        </div>
      )}

      <ul className="space-y-2">
        {alerts.map((a) => (
          <li
            key={a.id}
            className={`rounded-lg border px-3 py-2.5 ${severityClass(a.severity)} ${
              a.read ? "opacity-60" : ""
            }`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{a.symbol}</span>
                  <span className="rounded border border-current/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                    {a.rule}
                  </span>
                  <span className="text-[10px] opacity-70">{fmtTime(a.created_at)}</span>
                  {!a.read && (
                    <span className="rounded bg-amber-500/90 px-1 text-[9px] font-bold text-black">
                      NEW
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-zinc-200">{a.message}</p>
              </div>
              <div className="flex flex-wrap gap-1">
                <OpenBtn label="GEX" target="gex" symbol={a.symbol} />
                <OpenBtn label="VP" target="vp" symbol={a.symbol} />
                <OpenBtn label="FP" target="fp" symbol={a.symbol} />
                <OpenBtn label="FC" target="forecast" symbol={a.symbol} />
              </div>
            </div>
            <div className="mt-1.5 flex gap-2 text-[10px] text-zinc-600">
              <BarChart3 className="h-3 w-3" />
              <Layers className="h-3 w-3" />
              <Grid3x3 className="h-3 w-3" />
              <Sparkles className="h-3 w-3" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</p>
      <p
        className={`font-mono text-sm ${warn ? "text-rose-400" : "text-zinc-200"}`}
      >
        {value}
      </p>
    </div>
  );
}
