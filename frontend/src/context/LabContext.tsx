"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type LabTab =
  | "watch"
  | "signals"
  | "scanner"
  | "alerts"
  | "gex"
  | "cot"
  | "vp"
  | "fp"
  | "forecast";
export type OpenTarget = "gex" | "vp" | "fp" | "forecast";

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
  const [activeSymbol, setActiveSymbolState] = useState("SPY");
  const [tab, setTab] = useState<LabTab>("watch");
  const [refreshKey, setRefreshKey] = useState(0);

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
