/** Educational trading playbooks shown next to watchlist symbols. */

import { isFxSymbol } from "@/lib/format";

export type TradingProgram = {
  /** Short label shown in the table (e.g. Momentum RTH). */
  style: string;
  /** Session / when to engage. */
  session: string;
  /** 1–2 line playbook. */
  plan: string;
};

const US_RTH = "RTH 15:30–22:00 RO";
const EU_RTH = "EU 09:00–17:30 RO";
const CRYPTO_24 = "24/7 · focus overlap US";

const PROGRAMS: Record<string, TradingProgram> = {
  // Sudden-change candidates
  INLF: {
    style: "Penny · dilutie · extrem",
    session: US_RTH,
    plan: "Doar intraday, risc mic. Fade pe respingere la max zilei; fără overnight (warrant Series C, reverse split posibil). Nu media în jos.",
  },
  INO: {
    style: "Biotech catalyst spike",
    session: US_RTH,
    plan: "După +200% nu cumpăra la piață. Long doar pe pullback la VWAP care ține; stop sub min zilei; ia profit parțial rapid.",
  },
  CLRO: {
    style: "Spike & fade micro-cap",
    session: US_RTH,
    plan: "A respins max 7.40. Short pe retest VWAP/resp.; long doar pe reclaim al maximului după consolidare.",
  },
  EVGO: {
    style: "Gap-up squeeze",
    session: US_RTH,
    plan: "Range azi 1.77–1.95. Long pe break peste max cu volum; stop sub 1.77; fără chase în extensie.",
  },
  SPCX: {
    style: "Nou listat · lichid",
    session: US_RTH,
    plan: "Fără istoric: lucrează pe VWAP + max/min zilei. Long pe reclaim VWAP cu volum; stop sub min zilei; size mic.",
  },
  LITE: {
    style: "AI optic · volatil",
    session: US_RTH,
    plan: "Sell-off puternic azi. Short pe retest VWAP; long doar după bullish ABS + reclaim VWAP. ATR mare, size mic.",
  },
  MU: {
    style: "Memorie / AI",
    session: US_RTH,
    plan: "Corelat SOXL/SNDK. Long pe reclaim VWAP după flush; short pe respingere la POC. Aliniază sectorul.",
  },
  SNDK: {
    style: "Memorie NAND · preț mare",
    session: US_RTH,
    plan: "Mișcări largi; stop pe ATR, nu pe procent fix. Long pe reclaim POC; cut dacă sectorul cedează.",
  },
  MRVL: {
    style: "Semis AI custom",
    session: US_RTH,
    plan: "Slab sub VAL. Short pe retest VAL/VWAP; long doar pe reclaim al VWAP cu bullish ABS.",
  },
  WULF: {
    style: "Miner / AI-hosting momentum",
    session: US_RTH,
    plan: "Long doar pe pullback la VWAP în trend (nu pe maxim); stop sub VWAP/min 30m. Corelat CIFR/IREN/MARA — o singură poziție.",
  },
  CIFR: {
    style: "Miner / AI-hosting momentum",
    session: US_RTH,
    plan: "Long pe retest VWAP cu RVOL > 1.2; TP1 la maxim zi, TP2 extensie. Corelat WULF — nu dubla riscul.",
  },
  GRAB: {
    style: "Gap-fade",
    session: US_RTH,
    plan: "După gap-up care pierde VWAP: short pe retest VWAP, țintă umplere gap. Anulează dacă reclaim VWAP cu volum.",
  },
  PLUG: {
    style: "Low-price breakout",
    session: US_RTH,
    plan: "Range strâns; long doar pe break peste max zilei cu volum, stop sub range. Fără chase după extensie.",
  },
  // Speculative / high-vol
  SOFI: {
    style: "Momentum retail",
    session: US_RTH,
    plan: "Long doar pe breakout peste VAH + volum; stop sub POC zilei. Evită chase >+8% fără pullback la VWAP.",
  },
  CRWV: {
    style: "AI infra swing",
    session: US_RTH,
    plan: "Trend follow pe HVN; fade extensii >ATR zilnic spre VWAP. Bearish ABS pe volum mare = reduce size.",
  },
  QUBT: {
    style: "News / binary",
    session: US_RTH,
    plan: "Doar pe catalizator (comunicat/sector). Size mic; TP rapid ½ poziție; nu overnight fără plan.",
  },
  CRML: {
    style: "Commodity proxy",
    session: US_RTH,
    plan: "Mean-revert după spike: short/fade peste VAH dacă nu ține POC; long doar pe reclaim VWAP + volum.",
  },
  NNE: {
    style: "Narrative AI/nuc",
    session: US_RTH,
    plan: "High beta — size ½ vs large-cap. Entry pe pullback la VAL/VWAP, nu pe gap open.",
  },
  HUT: {
    style: "BTC proxy",
    session: `${US_RTH} + BTC`,
    plan: "Aliniază cu BTC 1h: long HUT doar dacă BTC > VWAP; cut dacă BTC rupe support-ul zilei.",
  },
  INOD: {
    style: "Earnings / LLM",
    session: US_RTH,
    plan: "Post-gap: așteaptă VA nouă. Long doar reclaim POC; short pe reject VAH după dump. Abs vechi ignorate.",
  },
  RKLB: {
    style: "Event / launch",
    session: US_RTH,
    plan: "Pre-anunț size mic; post-news trade VWAP reclaim. Evită overnight înainte de launch fără hedj.",
  },
  SPCE: {
    style: "Penny momentum",
    session: US_RTH,
    plan: "Scalp RVOL: long breakout 5m cu volum >1.8×; stop strâns sub micro-POC. Fără avg down.",
  },

  // High volume movers
  XP: {
    style: "Gap / EM risk",
    session: US_RTH,
    plan: "Post-crash: trade noul range. Fade bounce în POC vechi; long doar în VA nouă + bullish ABS.",
  },
  NU: {
    style: "EM fintech",
    session: US_RTH,
    plan: "Cu EWZ: short bias dacă preț > VAH pe dump day; long pe reclaim VWAP + flow BR stabil.",
  },
  EWZ: {
    style: "Country ETF",
    session: US_RTH,
    plan: "Proxy Brazil: trend follow pe 15m; mean-revert doar în VA. Confirmă cu NU/PBR.",
  },
  SOXL: {
    style: "3× semis levered",
    session: US_RTH,
    plan: "Doar intraday. Long pe bullish ABS + preț > VWAP; flatten înainte de close. Fără overnight.",
  },
  INTC: {
    style: "Large-cap mean/trend",
    session: US_RTH,
    plan: "POC = pivot: long reclaim POC/VWAP; short reject. Size normal; GEX pe expirații.",
  },

  // Core CFD / equity
  "NVDA.US": {
    style: "Mega-cap momentum",
    session: US_RTH,
    plan: "Trend pe 5/15m: long > VWAP + HVN hold; reduce pe bearish ABS. Verifică GEX weekly.",
  },
  "PTC.US": {
    style: "Software swing",
    session: US_RTH,
    plan: "Pullback la VAL/POC în uptrend; invalidare sub VAL sesiune. Size moderat.",
  },
  "ADSK.US": {
    style: "Software swing",
    session: US_RTH,
    plan: "Similar PTC: entry pe reclaim VWAP după dig; TP la VAH / prior high.",
  },
  "TSLA.US": {
    style: "High-beta momentum",
    session: US_RTH,
    plan: "RVOL + ABS: long breakout VAH; short fail VWAP. Evită open 15 min fără bias.",
  },
  "TER.US": {
    style: "Semi equipment",
    session: US_RTH,
    plan: "Corelat SOXL/NVDA. Long pe sector strength + reclaim POC; cut pe sector fail.",
  },
  "PH.US": {
    style: "Industrial swing",
    session: US_RTH,
    plan: "Trend calm: buy VAL în uptrend, sell VAH în range. Size normal.",
  },
  "EMR.US": {
    style: "Industrial swing",
    session: US_RTH,
    plan: "Cu PH/ROK: entry pe dig în VA; invalidare sub VAL zilei.",
  },
  "ROK.US": {
    style: "Industrial swing",
    session: US_RTH,
    plan: "Mean-revert în range VA; breakout doar cu volum + ABS confirm.",
  },
  "RRX.US": {
    style: "Industrial swing",
    session: US_RTH,
    plan: "Lichiditate medie — size redus. Trade POC retest; nu chase gap-uri.",
  },
  "MOGA.U": {
    style: "Aero / niche",
    session: US_RTH,
    plan: "Spread mai larg: limit orders, size mic. Focus VP levels, nu scalp agresiv.",
  },
  "SIE.DE": {
    style: "EU industrial",
    session: EU_RTH,
    plan: "Sesiune Europa: long reclaim VWAP Xetra; reduce înainte de US open dacă eșteți flat.",
  },
  "DSY.FR": {
    style: "EU software",
    session: EU_RTH,
    plan: "CAC hours: dig în VAL + bullish ABS; evit overlap US dacă ești deja în trade.",
  },

  // Crypto CFDs
  "BTC.US": {
    style: "Crypto trend",
    session: CRYPTO_24,
    plan: "Bias pe 1h/4h: long > VWAP HTX; size pe RVOL. Nu fight funding extremes.",
  },
  "ETH.US": {
    style: "Crypto trend",
    session: CRYPTO_24,
    plan: "Cu BTC: long doar dacă BTC ok; altfel fade. Entry pe VAL reclaim.",
  },
  "SOL.US": {
    style: "Alt momentum",
    session: CRYPTO_24,
    plan: "High beta vs BTC — size ½. Breakout 15m + volum; stop sub micro-POC.",
  },
  "XRP.US": {
    style: "News / flow",
    session: CRYPTO_24,
    plan: "Catalizatoare legale/ETF: scalp RVOL; flatten rapid pe reject HVN.",
  },
  "DOGE.US": {
    style: "Meme momentum",
    session: CRYPTO_24,
    plan: "Doar scalp; TP agresiv; fără overnight size mare.",
  },
  "ADA.US": {
    style: "Alt swing",
    session: CRYPTO_24,
    plan: "Trend follow moderat; entry dig VWAP; cut pe BTC dump.",
  },
  "BNB.US": {
    style: "Exchange proxy",
    session: CRYPTO_24,
    plan: "Corelat BTC; trade range VA; breakout cu confirm volum HTX.",
  },
  "AVAX.US": {
    style: "Alt momentum",
    session: CRYPTO_24,
    plan: "Size redus; long reclaim POC pe 15m; stop sub VAL.",
  },
  "LINK.US": {
    style: "Alt swing",
    session: CRYPTO_24,
    plan: "Swing 4h: buy VAL uptrend; avoid low-liquidity Asia open.",
  },
  "SUI.US": {
    style: "Alt momentum",
    session: CRYPTO_24,
    plan: "Volatil — scalp RVOL; fără avg down.",
  },

  // Indices / commodities
  USA500: {
    style: "Index trend/MR",
    session: US_RTH,
    plan: "ES proxy: long > VWAP / POC hold; short reject VAH. Core size.",
  },
  US100: {
    style: "Tech index",
    session: US_RTH,
    plan: "NQ: momentum pe open drive; fade extreme ATR. Aliniază NVDA/SOXL.",
  },
  US30: {
    style: "Blue-chip index",
    session: US_RTH,
    plan: "YM: mai lent — dig VAL; breakout doar cu volum futures.",
  },
  GER40: {
    style: "EU index",
    session: EU_RTH,
    plan: "DAX: trend EU morning; reduce înainte de US cash open.",
  },
  UK100: {
    style: "EU index",
    session: EU_RTH,
    plan: "FTSE: range/mean-revert des; breakout pe GBP news.",
  },
  FRA40: {
    style: "EU index",
    session: EU_RTH,
    plan: "CAC: trade VA; avoid lunch lull.",
  },
  JPN225: {
    style: "Asia index",
    session: "Asia 02:00–08:00 RO",
    plan: "Nikkei: sesiune Asia; flat înainte de EU dacă ești daytrade.",
  },
  EU50: {
    style: "EU basket",
    session: EU_RTH,
    plan: "SX5E: trend EU; confirm GER40/FRA40.",
  },
  AUS200: {
    style: "Asia index",
    session: "Asia 01:00–07:00 RO",
    plan: "ASX: Asia hours; size mic pe overlap EU.",
  },
  HK50: {
    style: "Asia index",
    session: "Asia 03:00–10:00 RO",
    plan: "HSI: volatil — stop largi relative, size redus.",
  },
  GOLD: {
    style: "Metal trend",
    session: "London + US",
    plan: "GC: long dig VAL pe DXY weak; short reclaim fail VWAP.",
  },
  XAUUSD: {
    style: "Metal · FX session",
    session: "London 09:00–13:00 + NY 15:00–19:00 RO",
    plan: "Preț GC futures. Long la VAL cu delta pozitiv când DXY slab; short la respingere sub VWAP. Volatil pe știri SUA.",
  },
  OIL: {
    style: "Energy trend",
    session: US_RTH,
    plan: "CL: news inventory — flatten pre-API/EIA; altfel trend VWAP.",
  },
};

const FALLBACK: TradingProgram = {
  style: "Discretionary",
  session: US_RTH,
  plan: "Definește bias pe VP (POC/VA); entry pe reclaim VWAP + ABS; stop dincolo de VAL/VAH; size pe ATR.",
};

/** Generic FX playbook, session picked from the currencies in the pair. */
function fxProgram(key: string): TradingProgram {
  const pair = key.replace(/=X|[\/\-_ ]/g, "");
  const has = (c: string) => pair.includes(c);
  let session = "London 09:00–13:00 + overlap NY 15:00–19:00 RO";
  if (has("AUD") || has("NZD")) {
    session = "Sydney/Tokyo 01:00–09:00 RO · repriză la overlap London";
  } else if (has("JPY")) {
    session = "Tokyo 02:00–09:00 + London/NY 10:00–19:00 RO";
  } else if (has("CAD")) {
    session = "NY 15:00–20:00 RO (petrol / date SUA)";
  }
  return {
    style: "FX · VP pe futures CME",
    session,
    plan: "Long/short la retest VAL/VAH/VWAP cu confirmare FP (delta + imbalance). Stop dincolo de VA; fără intrări cu 15 min înainte de știri high-impact.",
  };
}

export function getTradingProgram(symbol: string): TradingProgram {
  const key = symbol.trim().toUpperCase();
  if (PROGRAMS[key]) return PROGRAMS[key];

  // Soft matches for broker suffixes
  const base = key.replace(/\.(US|DE|FR|PA|NE)$/i, "");
  if (PROGRAMS[base]) return PROGRAMS[base];
  if (PROGRAMS[`${base}.US`]) return PROGRAMS[`${base}.US`];

  if (isFxSymbol(key)) return fxProgram(key);

  if (key.endsWith(".US") && /^(BTC|ETH|SOL|XRP|DOGE|ADA|BNB)/.test(base)) {
    return {
      style: "Crypto CFD",
      session: CRYPTO_24,
      plan: "Aliniază cu BTC; long > VWAP HTX; size pe volatilitate; fără overnight excesiv.",
    };
  }

  return FALLBACK;
}
