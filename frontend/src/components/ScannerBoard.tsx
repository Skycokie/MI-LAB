"use client";

import { FormEvent, useEffect, useState } from "react";
import { BarChart3, Grid3x3, Layers, Radar } from "lucide-react";
import {
  fetchJson,
  withRefresh,
  type MomentumHit,
  type MomentumScanResponse,
} from "@/lib/api";
import { useLab } from "@/context/LabContext";

function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtVol(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export default function ScannerBoard() {
  const { refreshKey, openSymbol } = useLab();
  const [minGap, setMinGap] = useState(3);
  const [minRvol, setMinRvol] = useState(2);
  const [minPrice, setMinPrice] = useState(5);
  const [maxPrice, setMaxPrice] = useState(100);
  const [applied, setApplied] = useState({
    minGap: 3,
    minRvol: 2,
    minPrice: 5,
    maxPrice: 100,
  });

  const [hits, setHits] = useState<MomentumHit[]>([]);
  const [meta, setMeta] = useState<{
    scanned: number;
    universe: number;
    asOf: string;
  } | null>(null);
  const [errors, setErrors] = useState<MomentumScanResponse["errors"]>([]);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requestKey = [
    applied.minGap,
    applied.minRvol,
    applied.minPrice,
    applied.maxPrice,
    refreshKey,
  ].join("|");

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({
      min_gap: String(applied.minGap),
      min_rvol: String(applied.minRvol),
      min_price: String(applied.minPrice),
      max_price: String(applied.maxPrice),
    });
    const path = withRefresh(`/api/scanner/momentum?${qs}`, refreshKey);

    fetchJson<MomentumScanResponse>(path)
      .then((res) => {
        if (cancelled) return;
        setHits(res.hits);
        setErrors(res.errors);
        setMeta({
          scanned: res.scanned,
          universe: res.universe_size,
          asOf: res.as_of,
        });
        setError(null);
        setFetchedFor(requestKey);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setHits([]);
        setFetchedFor(requestKey);
      });

    return () => {
      cancelled = true;
    };
  }, [applied, refreshKey, requestKey]);

  const loading = fetchedFor !== requestKey;

  function onApply(e: FormEvent) {
    e.preventDefault();
    setApplied({
      minGap,
      minRvol,
      minPrice,
      maxPrice,
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-zinc-100">
            <Radar className="h-5 w-5 text-amber-400" />
            US Momentum Scanner
          </h2>
          <p className="text-xs text-zinc-500">
            Liquid universe · gap + relative volume ·{" "}
            <span className="text-amber-500/90">Yahoo delayed ~15m</span>
            {meta
              ? ` · ${meta.scanned}/${meta.universe} scanned · ${hits.length} hits`
              : ""}
          </p>
        </div>
        <form
          onSubmit={onApply}
          className="flex flex-wrap items-end gap-2 text-xs"
        >
          <FilterField
            label="Min |gap| %"
            value={minGap}
            onChange={setMinGap}
            step={0.5}
          />
          <FilterField
            label="Min RVOL"
            value={minRvol}
            onChange={setMinRvol}
            step={0.25}
          />
          <FilterField
            label="Min $"
            value={minPrice}
            onChange={setMinPrice}
            step={1}
          />
          <FilterField
            label="Max $"
            value={maxPrice}
            onChange={setMaxPrice}
            step={1}
          />
          <button
            type="submit"
            className="rounded border border-zinc-700 bg-black px-3 py-1.5 font-medium text-zinc-300 hover:border-amber-500 hover:text-amber-400"
          >
            Scan
          </button>
        </form>
      </div>

      {error && (
        <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-zinc-800 bg-zinc-950 text-[11px] uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="px-3 py-2.5 font-medium">Symbol</th>
              <th className="px-3 py-2.5 font-medium">Price</th>
              <th className="px-3 py-2.5 font-medium">Gap</th>
              <th className="px-3 py-2.5 font-medium">RVOL</th>
              <th className="px-3 py-2.5 font-medium">Volume</th>
              <th className="px-3 py-2.5 font-medium">Open</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-10 text-center text-sm text-zinc-500"
                >
                  Scanning universe…
                </td>
              </tr>
            )}
            {!loading && hits.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-10 text-center text-sm text-zinc-500"
                >
                  No hits for current filters. Lower min gap / RVOL or widen
                  price range.
                </td>
              </tr>
            )}
            {!loading &&
              hits.map((h) => {
                const up = h.gap_pct >= 0;
                return (
                  <tr
                    key={h.symbol}
                    className="border-b border-zinc-900/80 hover:bg-zinc-900/50"
                  >
                    <td className="px-3 py-2.5">
                      <div className="font-mono font-semibold text-amber-400">
                        {h.symbol}
                      </div>
                      <div className="truncate text-[10px] text-zinc-600">
                        {h.name || "—"}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-zinc-200">
                      {h.price}
                    </td>
                    <td className="px-3 py-2.5 font-mono">
                      <span
                        className={up ? "text-emerald-400" : "text-red-400"}
                      >
                        {fmtPct(h.gap_pct)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-zinc-200">
                      {h.rvol.toFixed(2)}×
                    </td>
                    <td className="px-3 py-2.5 font-mono text-zinc-400">
                      {fmtVol(h.volume)}
                      <span className="text-zinc-600">
                        {" "}
                        / avg {fmtVol(h.avg_volume)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        <OpenBtn
                          label="GEX"
                          icon={BarChart3}
                          onClick={() => openSymbol(h.symbol, "gex")}
                        />
                        <OpenBtn
                          label="VP"
                          icon={Layers}
                          onClick={() => openSymbol(h.symbol, "vp")}
                        />
                        <OpenBtn
                          label="FP"
                          icon={Grid3x3}
                          onClick={() => openSymbol(h.symbol, "fp")}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      {errors.length > 0 && (
        <p className="text-[11px] text-zinc-600">
          {errors.length} symbols failed to fetch (Yahoo rate / missing data).
        </p>
      )}
    </div>
  );
}

function FilterField({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step: number;
}) {
  return (
    <label className="flex flex-col gap-1 text-zinc-500">
      <span className="text-[10px] uppercase tracking-wider">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-20 rounded border border-zinc-700 bg-black px-2 py-1.5 font-mono text-amber-400 outline-none focus:border-amber-500"
      />
    </label>
  );
}

function OpenBtn({
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
      className="inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-[10px] font-medium text-zinc-400 hover:border-amber-500/50 hover:text-amber-400"
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  );
}
