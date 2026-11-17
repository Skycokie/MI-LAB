"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { Scale, Trash2 } from "lucide-react";
import {
  apiUrl,
  fetchJson,
  putJson,
  type BasisItem,
  type BasisPreview,
} from "@/lib/api";

const PRESETS = [
  "GOLD",
  "US100",
  "USA500",
  "US30",
  "GER40",
  "UK100",
  "OIL",
  "BRENT",
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "BTC.US",
];

function fmtOffset(v: number): string {
  const abs = Math.abs(v);
  const dp = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return `${v > 0 ? "+" : ""}${v.toFixed(dp)}`;
}

export default function BasisBoard() {
  const [items, setItems] = useState<BasisItem[]>([]);
  const [symbol, setSymbol] = useState("GOLD");
  const [preview, setPreview] = useState<BasisPreview | null>(null);
  const [xtb, setXtb] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const res = await fetchJson<{ items: BasisItem[] }>("/api/basis");
      setItems(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  async function readPrice(e?: FormEvent) {
    e?.preventDefault();
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    setPreview(null);
    try {
      setPreview(
        await fetchJson<BasisPreview>(
          `/api/basis/${encodeURIComponent(sym)}/preview`,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const value = Number(xtb.replace(",", "."));
    if (!preview || !Number.isFinite(value) || value <= 0) {
      setError("Introdu prețul XTB (număr pozitiv).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await putJson<{ offset: number; symbol: string }>(
        `/api/basis/${encodeURIComponent(preview.symbol)}`,
        { xtb_price: value },
      );
      setSaved(`${res.symbol}: offset ${fmtOffset(res.offset)} salvat`);
      setXtb("");
      setPreview(null);
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(label: string) {
    setError(null);
    try {
      await fetch(apiUrl(`/api/basis/${encodeURIComponent(label)}`), {
        method: "DELETE",
      });
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-zinc-100">
          <Scale className="h-5 w-5 text-amber-400" />
          Calibrare XTB
        </h2>
        <p className="mt-1 max-w-3xl text-xs text-zinc-500">
          XTB nu mai are API de date. Feed-urile noastre (futures pentru aur,
          indici, petrol) diferă cu câteva puncte de CFD-ul XTB. Introdu prețul
          XTB la ora ultimei bare; offset-ul se aplică automat pe VP, VWAP,
          footprint, absorbție, forecast și cotații. Recalibrează zilnic: baza
          se schimbă (roll, carry).
        </p>
      </div>

      <form
        onSubmit={readPrice}
        className="space-y-3 rounded border border-zinc-800 bg-black p-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[11px] uppercase tracking-wider text-zinc-500">
            1 · Simbol
          </label>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            spellCheck={false}
            className="w-32 rounded border border-zinc-700 bg-black px-3 py-1.5 font-mono text-sm text-amber-400 outline-none focus:border-amber-500"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-amber-500 hover:text-amber-400 disabled:opacity-50"
          >
            Citește prețul din app
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setSymbol(p)}
              className={`rounded px-2 py-1 font-mono text-[11px] transition ${
                symbol === p
                  ? "bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/40"
                  : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        {preview && (
          <div className="space-y-3 border-t border-zinc-800 pt-3">
            <p className="text-sm text-zinc-300">
              Ultima bară 5m ({preview.source}):{" "}
              <span className="font-mono text-amber-400">
                {preview.bar_time}
              </span>{" "}
              ora RO · închidere{" "}
              <span className="font-mono text-amber-400">
                {preview.app_price}
              </span>
              {preview.current_offset !== 0 && (
                <span className="ml-2 text-xs text-zinc-500">
                  (preț brut, fără offset-ul curent{" "}
                  {fmtOffset(preview.current_offset)})
                </span>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-[11px] uppercase tracking-wider text-zinc-500">
                2 · Preț XTB la {preview.bar_time.slice(-5)} (închiderea
                lumânării de 5 min)
              </label>
              <input
                value={xtb}
                onChange={(e) => setXtb(e.target.value)}
                inputMode="decimal"
                placeholder="ex. 4094.1"
                className="w-36 rounded border border-zinc-700 bg-black px-3 py-1.5 font-mono text-sm text-amber-400 outline-none placeholder:text-zinc-700 focus:border-amber-500"
              />
              <button
                type="button"
                onClick={save}
                disabled={busy}
                className="rounded bg-amber-500 px-3 py-1.5 text-xs font-semibold text-black transition hover:bg-amber-400 disabled:opacity-50"
              >
                Salvează offset
              </button>
            </div>
            <p className="text-[11px] text-zinc-600">
              Datele Yahoo sunt întârziate ~15 min: compară cu lumânarea XTB de
              la aceeași oră, nu cu prețul live, altfel offset-ul include
              mișcarea pieței.
            </p>
          </div>
        )}
      </form>

      {error && (
        <p className="rounded border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
          {error}
        </p>
      )}
      {saved && (
        <p className="rounded border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
          {saved}
        </p>
      )}

      <div className="overflow-x-auto rounded border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wider text-zinc-500">
              <th className="px-3 py-2">Simbol</th>
              <th className="px-3 py-2 text-right">Offset (XTB − app)</th>
              <th className="px-3 py-2 text-right">App</th>
              <th className="px-3 py-2 text-right">XTB</th>
              <th className="px-3 py-2">Bară (RO)</th>
              <th className="px-3 py-2 text-right">Vârstă</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-zinc-500">
                  Nicio calibrare salvată. Prețurile din app sunt cele brute
                  (futures / spot Yahoo).
                </td>
              </tr>
            )}
            {items.map((it) => {
              const stale = it.age_hours > 24;
              return (
                <tr key={it.yahoo_symbol} className="border-b border-zinc-900">
                  <td className="px-3 py-2 font-mono text-zinc-100">
                    {it.label ?? it.yahoo_symbol}
                    <span className="ml-2 text-[10px] text-zinc-600">
                      {it.yahoo_symbol}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-amber-400">
                    {fmtOffset(it.offset)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-400">
                    {it.app_price ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-400">
                    {it.xtb_price ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                    {it.bar_time ?? "—"}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-mono text-xs ${
                      stale ? "text-rose-400" : "text-zinc-500"
                    }`}
                  >
                    {it.age_hours < 1
                      ? "<1 h"
                      : `${Math.round(it.age_hours)} h`}
                    {stale && " · recalibrează"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => remove(it.label ?? it.yahoo_symbol)}
                      title="Șterge calibrarea"
                      className="rounded p-1.5 text-zinc-600 hover:bg-red-500/10 hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
