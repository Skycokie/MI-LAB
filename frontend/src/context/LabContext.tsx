"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type LabTab =
  | "watch"
  | "crypto"
  | "indices"
  | "forex"
  | "signals"
  | "scanner"
  | "alerts"
  | "news"
  | "basis"
  | "smc"
  | "gex"
  | "cot"
  | "vp"
  | "fp"
  | "forecast";
export type OpenTarget = "gex" | "vp" | "fp" | "smc" | "forecast" | "news";

type LabContextValue = {
  activeSymbol: string;
  setActiveSymbol: (symbol: string) => void;
  tab: LabTab;
  setTab: (tab: LabTab) => void;
  refreshKey: number;
  bumpRefresh: () => void;
  openSymbol: (symbol: string, target: OpenTarget) => void;
};

const LabContext = createContext<LabContextValue | null>(null);

export function LabProvider({ children }: { children: ReactNode }) {
  const [activeSymbol, setActiveSymbolState] = useState("US100");
  const [tab, setTab] = useState<LabTab>("watch");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const qSym = params.get("symbol")?.trim().toUpperCase();
    const qTab = params.get("tab")?.trim().toLowerCase() as LabTab | undefined;
    if (qSym) setActiveSymbolState(qSym);
    if (
      qTab &&
      [
        "watch",
        "crypto",
        "indices",
        "forex",
        "signals",
        "scanner",
        "alerts",
        "news",
        "basis",
        "smc",
        "gex",
        "cot",
        "vp",
        "fp",
        "forecast",
      ].includes(qTab)
    ) {
      setTab(qTab);
    }
  }, []);

  const setActiveSymbol = useCallback((symbol: string) => {
    const next = symbol.trim().toUpperCase();
    if (next) setActiveSymbolState(next);
  }, []);

  const bumpRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const openSymbol = useCallback((symbol: string, target: OpenTarget) => {
    const next = symbol.trim().toUpperCase();
    if (!next) return;
    setActiveSymbolState(next);
    setTab(target);
  }, []);

  const value = useMemo(
    () => ({
      activeSymbol,
      setActiveSymbol,
      tab,
      setTab,
      refreshKey,
      bumpRefresh,
      openSymbol,
    }),
    [activeSymbol, setActiveSymbol, tab, refreshKey, bumpRefresh, openSymbol],
  );

  return <LabContext.Provider value={value}>{children}</LabContext.Provider>;
}

export function useLab(): LabContextValue {
  const ctx = useContext(LabContext);
  if (!ctx) {
    throw new Error("useLab must be used within LabProvider");
  }
  return ctx;
}
