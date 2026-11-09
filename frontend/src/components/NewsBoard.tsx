"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Newspaper } from "lucide-react";
import { fetchJson, withRefresh, type NewsItem, type NewsResponse } from "@/lib/api";
import { useLab } from "@/context/LabContext";

function fmtAge(iso: string | null): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h`;
  return new Date(ts).toLocaleDateString("ro-RO", {
    day: "2-digit",
    month: "2-digit",
  });
}

function sentimentClass(s: string | null): string {
  const v = (s ?? "").toLowerCase();
  if (v.startsWith("pos") || v === "bullish")
    return "border-emerald-800/60 bg-emerald-950/40 text-emerald-400";
  if (v.startsWith("neg") || v === "bearish")
    return "border-rose-800/60 bg-rose-950/40 text-rose-400";
  return "border-zinc-700 bg-zinc-900 text-zinc-400";
}

function providerLabel(p: string | null | undefined): string {
  if (p === "financial-datasets") return "Financial Datasets";
  if (p === "alpaca") return "Alpaca News";
  return p ?? "—";
}

export default function NewsBoard() {
  const { activeSymbol, refreshKey } = useLab();
  const symbol = activeSymbol.toUpperCase();
  const [data, setData] = useState<NewsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const requestKey = `${symbol}|${refreshKey}`;

  useEffect(() => {
    let cancelled = false;
    fetchJson<NewsResponse>(
      withRefresh(`/api/news/${encodeURIComponent(symbol)}?limit=25`, refreshKey),
    )
      .then((json) => {
        if (cancelled) return;
        setData(json);
        setError(null);
        setFetchedFor(requestKey);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setData(null);
        setFetchedFor(requestKey);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, refreshKey, requestKey]);

  const loading = fetchedFor !== requestKey;
  const items: NewsItem[] = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-zinc-100">
            <Newspaper className="h-5 w-5 text-amber-400" />
            Știri · <span className="font-mono text-amber-400">{symbol}</span>
          </h2>
          <p className="text-xs text-zinc-500">
            {data?.available && data.provider
              ? `Sursă: ${providerLabel(data.provider)} · ${data.count ?? items.length} articole`
              : "Financial Datasets · fallback Alpaca News"}
          </p>
        </div>
        {data?.proxy_note && (
          <p className="rounded border border-zinc-800 bg-black px-2 py-1 text-[11px] text-zinc-500">
            {data.proxy_note}
          </p>
        )}
      </div>

      {loading && <p className="text-sm text-zinc-500">Se încarcă…</p>}

      {error && (
        <p className="rounded border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
          {error}
        </p>
      )}

      {!loading && data && !data.available && (
        <p className="rounded border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-sm text-amber-300">
          {data.message}
        </p>
      )}

      {!loading && data?.available && items.length === 0 && (
        <p className="text-sm text-zinc-500">
          Nicio știre găsită pentru {data.symbol}.
          {data.errors && data.errors.length > 0 && (
            <span className="block text-xs text-rose-400">
              {data.errors.join(" · ")}
            </span>
          )}
        </p>
      )}

      {!loading && data?.available && data.errors && data.errors.length > 0 && items.length > 0 && (
        <p className="text-[11px] text-zinc-600">
          Furnizor indisponibil, am folosit fallback: {data.errors.join(" · ")}
        </p>
      )}

      <ul className="divide-y divide-zinc-900 rounded border border-zinc-800">
        {items.map((n, i) => (
          <li key={`${n.url ?? n.title}-${i}`} className="px-3 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {n.url ? (
                  <a
                    href={n.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-start gap-1.5 text-sm font-medium text-zinc-100 hover:text-amber-400"
                  >
                    <span>{n.title}</span>
                    <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 opacity-60" />
                  </a>
                ) : (
                  <span className="text-sm font-medium text-zinc-100">{n.title}</span>
                )}
                {n.summary && (
                  <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{n.summary}</p>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-zinc-600">
                  {n.source && <span>{n.source}</span>}
                  {n.author && <span>· {n.author}</span>}
                  {n.tickers.length > 0 && (
                    <span className="font-mono">{n.tickers.slice(0, 4).join(" ")}</span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className="font-mono text-[11px] text-zinc-500">
                  {fmtAge(n.published_at)}
                </span>
                {n.sentiment && (
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${sentimentClass(n.sentiment)}`}
                  >
                    {n.sentiment}
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
