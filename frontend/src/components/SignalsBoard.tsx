"use client";

import { useEffect, useState } from "react";
import { BarChart3, Grid3x3, Layers } from "lucide-react";
import {
  postJson,
  type WatchlistSignalsResponse,
  type WatchSignal,
} from "@/lib/api";
import { loadWatchlist, watchlistSymbols } from "@/lib/watchlist";
import { useLab } from "@/context/LabContext";

function fmtTime(unix: number | null): string {
  if (unix == null) return "—";
  const d = new Date(unix * 1000);
  return d.toLocaleString("en-GB", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtVol(n: number): string {
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

export default function SignalsBoard() {
  const { refreshKey, openSymbol } = useLab();
  const [signals, setSignals] = useState<WatchSignal[]>([]);
  const [errors, setErrors] = useState<WatchlistSignalsResponse["errors"]>([]);
  const [meta, setMeta] = useState<{ scanned: number; interval: string } | null>(
    null,
  );
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"ALL" | "BULLISH" | "BEARISH">("ALL");

  const requestKey = `signals|${refreshKey}`;

  useEffect(() => {
    let cancelled = false;
    const symbols = watchlistSymbols(loadWatchlist());
    if (symbols.length === 0) {
      // Defer empty state via microtask-equivalent: set in then of a resolved promise
      Promise.resolve().then(() => {
        if (cancelled) return;
        setSignals([]);
        setErrors([]);
        setMeta(null);
        setError(null);
        setFetchedFor(requestKey);
      });
      return () => {
        cancelled = true;
      };
    }

    postJson<WatchlistSignalsResponse>("/api/watchlist/signals", {
      symbols,
      interval: "15m",
      limit_per: 5,
      refresh: refreshKey > 0,
    })
      .then((res) => {
        if (cancelled) return;
        setSignals(res.signals);
        setErrors(res.errors);
        setMeta({ scanned: res.scanned, interval: res.interval });
        setError(null);
        setFetchedFor(requestKey);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setFetchedFor(requestKey);
      });

    return () => {
      cancelled = true;
    };
  }, [refreshKey, requestKey]);

  const loading = fetchedFor !== requestKey;

  const filtered = signals.filter((s) => {
    if (filter === "BULLISH") return s.absorption_type === "BULLISH_ABSORPTION";
    if (filter === "BEARISH") return s.absorption_type === "BEARISH_ABSORPTION";
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">
            Absorption signals
          </h2>
          <p className="text-xs text-zinc-500">
            Across your saved CFD watchlist
            {meta ? ` · ${meta.scanned} scanned · ${meta.interval}` : ""} ·
            estimated order flow
          </p>
        </div>
        <div className="flex gap-1 rounded border border-zinc-800 p-0.5 text-xs">
          {(
            [
              ["ALL", "All"],
              ["BULLISH", "Bullish"],
              ["BEARISH", "Bearish"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={`rounded px-3 py-1.5 ${
                filter === id
                  ? "bg-amber-500/15 text-amber-400"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex h-40 items-center justify-center text-sm text-zinc-500">
          Scanning watchlist for absorption…
        </div>
      )}

      {error && (
        <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="rounded border border-zinc-800 bg-zinc-950 p-8 text-center text-sm text-zinc-500">
          No absorption signals on the current watchlist window.
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-950 text-[11px] uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-3 py-2.5 font-medium">When</th>
                <th className="px-3 py-2.5 font-medium">Symbol</th>
                <th className="px-3 py-2.5 font-medium">Type</th>
                <th className="px-3 py-2.5 font-medium">Close</th>
                <th className="px-3 py-2.5 font-medium">Volume</th>
                <th className="px-3 py-2.5 font-medium">Delta</th>
                <th className="px-3 py-2.5 font-medium">Open</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => {
                const bull = s.absorption_type === "BULLISH_ABSORPTION";
                return (
                  <tr
                    key={`${s.symbol}-${s.time}-${i}`}
                    className="border-b border-zinc-900/80 hover:bg-zinc-900/50"
                  >
                    <td className="px-3 py-2.5 font-mono text-xs text-zinc-400">
                      {fmtTime(s.time)}
                    </td>
                    <td className="px-3 py-2.5 font-mono font-semibold text-amber-400">
                      {s.symbol}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-flex rounded px-2 py-0.5 text-[11px] font-medium ${
                          bull
                            ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30"
                            : "bg-red-500/15 text-red-300 ring-1 ring-red-500/30"
                        }`}
                      >
                        {bull ? "Bullish ABS" : "Bearish ABS"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-zinc-200">
                      {s.close}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-zinc-400">
                      {fmtVol(s.volume)}
                    </td>
                    <td
                      className={`px-3 py-2.5 font-mono ${
                        s.delta >= 0 ? "text-emerald-400" : "text-red-400"
                      }`}
                    >
                      {s.delta >= 0 ? "+" : ""}
                      {fmtVol(s.delta)}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        <Mini
                          label="GEX"
                          icon={BarChart3}
                          onClick={() => openSymbol(s.symbol, "gex")}
                        />
                        <Mini
                          label="VP"
                          icon={Layers}
                          onClick={() => openSymbol(s.symbol, "vp")}
                        />
                        <Mini
                          label="FP"
                          icon={Grid3x3}
                          onClick={() => openSymbol(s.symbol, "fp")}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {errors.length > 0 && (
        <p className="text-[11px] text-zinc-600">
          Scan errors: {errors.map((e) => e.symbol).join(", ")}
        </p>
      )}
    </div>
  );
}

function Mini({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: typeof BarChart3;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 hover:border-amber-500/50 hover:text-amber-400"
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  );
}
