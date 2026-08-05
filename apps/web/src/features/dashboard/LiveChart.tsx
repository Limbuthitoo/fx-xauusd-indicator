import { createChart, type IChartApi, type ISeriesApi, type Logical, type LogicalRange, type SeriesMarker, type Time, type UTCTimestamp } from "lightweight-charts";
import { Maximize2, RefreshCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, apiWebSocketUrl } from "../../shared/api";

export type TwelveDataCandle = {
  timestampUtc: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
  spread?: number | null;
};

type IndicatorSnapshot = {
  latestPrice: number | null;
  latestTimestampUtc: string | null;
  spread: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  atr14: number | null;
  candleCount: number;
};

type TradeChartMarker = {
  id: string;
  type: "ENTRY" | "EXIT";
  time: string;
  direction: "LONG" | "SHORT";
  scenario?: string;
  outcome?: string;
  resultR?: number | string | null;
  text: string;
};

type FeedStatus = {
  provider: string;
  live: boolean;
  stale: boolean;
  testMode?: boolean;
  ageSeconds: number | null;
  testAgeSeconds?: number | null;
  persistRawCandles?: boolean;
  cachedCandles?: number;
  latestCandle?: {
    timestampUtc: string;
    receivedAt: string;
    source: string;
  } | null;
};

type LiveEvent =
  | { type: "connected"; sentAt: string }
  | {
      type: "candle";
      provider: string;
      symbol: string;
      timeframeMinutes: number;
      candle: TwelveDataCandle & { source?: string; receivedAt?: string };
      sentAt: string;
    };

export type ChartPriceLine = {
  title: string;
  price?: number | string | null;
  color: string;
};

export type TwelveDataChartProps = {
  symbol: string;
  timeframeMinutes: number;
  moduleCode?: string;
  moduleName?: string;
  session?: {
    session_start_at?: string | null;
    opening_range_end_at?: string | null;
    signal_window_end_at?: string | null;
  } | null;
  openingRange?: {
    high?: number | string | null;
    midpoint?: number | string | null;
    low?: number | string | null;
  } | null;
  orbRanges?: Array<{
    session_preset?: string | null;
    label?: string | null;
    shortLabel?: string | null;
    high?: number | string | null;
    midpoint?: number | string | null;
    low?: number | string | null;
    session_start_at?: string | null;
    opening_range_end_at?: string | null;
  }>;
  setup?: {
    module_code?: string | null;
    status?: string;
    direction?: string;
    detected_at?: string;
    scenario?: string;
    entry_price?: number | string | null;
    stop_price?: number | string | null;
    target_price?: number | string | null;
    scenario_flags?: any;
  } | null;
  priceLines?: ChartPriceLine[];
  showEma?: boolean;
  onMessage: (message: string) => void;
};

type PositionedOverlay = {
  id: string;
  label: string;
  tone: "session" | "sweep" | "fvg" | "orderBlock" | "bos" | "displacement" | "invalid" | "reward" | "entry" | "orbHigh" | "orbMid" | "orbLow";
  left: number;
  top: number;
  width: number;
  height: number;
};

const lineColors = {
  ema20: "#38bdf8",
  ema50: "#f0b429",
  ema200: "#a78bfa"
};

const CHART_BAR_SPACING = 2.5;
const CHART_RIGHT_OFFSET = 16;
const INITIAL_CHART_CANDLES = 300;
const OLDER_CANDLE_PAGE = 300;

export function TwelveDataChart({ symbol, timeframeMinutes, moduleCode = "orb_max_options", moduleName, session, openingRange, orbRanges = [], setup, priceLines, showEma = true, onMessage }: TwelveDataChartProps) {
  const chartCandleLimit = Math.ceil(7 * 24 * (60 / timeframeMinutes)) + 10;
  const activeSetup = !setup?.module_code || setup.module_code === moduleCode ? setup : null;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const ema20Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const ema50Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const ema200Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const priceLinesRef = useRef<Array<{ applyOptions: (options: { price: number }) => void }>>([]);
  const renderedCandlesRef = useRef<TwelveDataCandle[]>([]);
  const renderedShowEmaRef = useRef(showEma);
  const loadingOlderRef = useRef(false);
  const hasOlderCandlesRef = useRef(true);
  const pendingPrependCountRef = useRef(0);
  const didSetInitialRangeRef = useRef(false);
  const isApplyingProgrammaticRangeRef = useRef(false);
  const userAdjustedRangeRef = useRef(false);
  const visibleLogicalRangeRef = useRef<LogicalRange | null>(null);
  const lastChartInteractionAtRef = useRef(0);
  const barSpacingRef = useRef(CHART_BAR_SPACING);
  const [candles, setCandles] = useState<TwelveDataCandle[]>([]);
  const [indicators, setIndicators] = useState<IndicatorSnapshot | null>(null);
  const [tradeMarkers, setTradeMarkers] = useState<TradeChartMarker[]>([]);
  const [feedStatus, setFeedStatus] = useState<FeedStatus | null>(null);
  const [socketStatus, setSocketStatus] = useState("CONNECTING");
  const [chartLoading, setChartLoading] = useState(true);
  const [overlays, setOverlays] = useState<PositionedOverlay[]>([]);
  const orbRangeState = useMemo(
    () => moduleCode === "orb_max_options" ? module1OrbRangeState(openingRange, candles, session) : null,
    [moduleCode, openingRange, candles, session]
  );
  const effectiveOpeningRange = useMemo(
    () => moduleCode === "orb_max_options" ? orbRangeState?.range ?? openingRange : openingRange,
    [moduleCode, orbRangeState, openingRange]
  );
  const effectiveOrbRanges = useMemo(
    () => moduleCode === "orb_max_options" ? normalizeOrbRanges(orbRanges, effectiveOpeningRange) : [],
    [moduleCode, orbRanges, effectiveOpeningRange]
  );

  async function loadChartMetadata() {
    const [nextIndicators, nextTradeMarkers, nextFeedStatus] = await Promise.all([
      api<IndicatorSnapshot>(`/api/indicators/live?symbol=${symbol}&timeframeMinutes=${timeframeMinutes}`).catch(() => null),
      api<TradeChartMarker[]>(`/api/trades/chart-markers?symbol=${symbol}&moduleCode=${moduleCode}&limit=100`).catch(() => []),
      api<FeedStatus>(`/api/market-data/live/status?symbol=${symbol}&timeframeMinutes=${timeframeMinutes}`).catch(() => null)
    ]);
    if (nextIndicators) setIndicators(nextIndicators);
    setTradeMarkers(nextTradeMarkers);
    if (nextFeedStatus) setFeedStatus(nextFeedStatus);
  }

  async function loadInitialChartData() {
    setChartLoading(true);
    const initial = await api<TwelveDataCandle[]>(`/api/candles?symbol=${symbol}&timeframeMinutes=${timeframeMinutes}&limit=${INITIAL_CHART_CANDLES}`);
    setCandles(normalizeCandles(initial));
    hasOlderCandlesRef.current = initial.length >= INITIAL_CHART_CANDLES;
    setChartLoading(false);
    loadChartMetadata().catch(() => undefined);
    if (initial.length === 0) {
      onMessage(`${moduleName ?? moduleCode} has no stored ${timeframeMinutes}m candles yet. The scheduler will populate the shared feed without a chart-triggered Twelve Data call.`);
    }
  }

  async function reconcileRecentCandles() {
    const latestAt = renderedCandlesRef.current.at(-1)?.timestampUtc;
    if (!latestAt) return loadInitialChartData();
    const recent = await api<TwelveDataCandle[]>(`/api/candles?symbol=${symbol}&timeframeMinutes=${timeframeMinutes}&from=${encodeURIComponent(latestAt)}&limit=20`);
    if (recent.length > 0) {
      setCandles((previous) => normalizeCandles([...previous, ...recent]).slice(-chartCandleLimit));
    }
  }

  async function loadOlderCandles() {
    if (loadingOlderRef.current || !hasOlderCandlesRef.current) return;
    const current = renderedCandlesRef.current;
    if (current.length === 0 || current.length >= chartCandleLimit) {
      hasOlderCandlesRef.current = false;
      return;
    }
    loadingOlderRef.current = true;
    try {
      const oldestTime = new Date(current[0].timestampUtc).getTime() - 1;
      const older = await api<TwelveDataCandle[]>(`/api/candles?symbol=${symbol}&timeframeMinutes=${timeframeMinutes}&to=${encodeURIComponent(new Date(oldestTime).toISOString())}&limit=${OLDER_CANDLE_PAGE}`);
      if (older.length < OLDER_CANDLE_PAGE) hasOlderCandlesRef.current = false;
      setCandles((previous) => {
        const next = normalizeCandles([...older, ...previous]).slice(-chartCandleLimit);
        pendingPrependCountRef.current = Math.max(0, next.length - previous.length);
        return next;
      });
    } finally {
      loadingOlderRef.current = false;
    }
  }

  async function refreshChartData() {
    await Promise.all([reconcileRecentCandles(), loadChartMetadata()]);
  }

  useEffect(() => {
    setCandles([]);
    didSetInitialRangeRef.current = false;
    userAdjustedRangeRef.current = false;
    visibleLogicalRangeRef.current = null;
    renderedCandlesRef.current = [];
    hasOlderCandlesRef.current = true;
    loadInitialChartData().catch(() => {
      setChartLoading(false);
      onMessage("Chart data is unavailable. Confirm the API is running.");
    });
    const timer = window.setInterval(() => refreshChartData().catch(() => undefined), 60_000);
    return () => window.clearInterval(timer);
  }, [symbol, timeframeMinutes, moduleCode]);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer = 0;

    function connect() {
      if (stopped) return;
      setSocketStatus("CONNECTING");
      socket = new WebSocket(apiWebSocketUrl("/api/live/ws"));
      socket.onopen = () => setSocketStatus("LIVE SOCKET");
      socket.onmessage = (event) => {
        const payload = JSON.parse(event.data) as LiveEvent;
        if (payload.type !== "candle" || payload.symbol !== symbol || payload.timeframeMinutes !== timeframeMinutes) return;
        setCandles((previous) => normalizeCandles([...previous, payload.candle]).slice(-chartCandleLimit));
        setFeedStatus({
          provider: payload.provider,
          live: true,
          stale: false,
          ageSeconds: 0,
          persistRawCandles: payload.provider === "TWELVE_DATA" ? false : true,
          latestCandle: {
            timestampUtc: payload.candle.timestampUtc,
            receivedAt: payload.candle.receivedAt ?? payload.sentAt,
            source: payload.candle.source ?? payload.provider
          }
        });
      };
      socket.onerror = () => setSocketStatus("SOCKET ERROR");
      socket.onclose = () => {
        if (stopped) return;
        setSocketStatus("RECONNECTING");
        reconnectTimer = window.setTimeout(connect, 2_000);
      };
    }

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [symbol, timeframeMinutes]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: "#111512" },
        textColor: "#a9b8ae"
      },
      grid: {
        vertLines: { color: "#1f2822" },
        horzLines: { color: "#1f2822" }
      },
      rightPriceScale: {
        borderColor: "#2b342e"
      },
      timeScale: {
        borderColor: "#2b342e",
        timeVisible: true,
        secondsVisible: false,
        barSpacing: CHART_BAR_SPACING,
        minBarSpacing: 1,
        rightOffset: 12,
        fixLeftEdge: false,
        fixRightEdge: false
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true
      },
      crosshair: {
        mode: 1
      }
    });

    chartRef.current = chart;
    candleSeriesRef.current = chart.addCandlestickSeries({
      upColor: "#16a46c",
      downColor: "#e05252",
      borderUpColor: "#16a46c",
      borderDownColor: "#e05252",
      wickUpColor: "#16a46c",
      wickDownColor: "#e05252"
    });
    ema20Ref.current = chart.addLineSeries({ color: lineColors.ema20, lineWidth: 2, priceLineVisible: false });
    ema50Ref.current = chart.addLineSeries({ color: lineColors.ema50, lineWidth: 2, priceLineVisible: false });
    ema200Ref.current = chart.addLineSeries({ color: lineColors.ema200, lineWidth: 2, priceLineVisible: false });
    const markChartInteraction = () => {
      lastChartInteractionAtRef.current = Date.now();
    };
    container.addEventListener("wheel", markChartInteraction, { passive: true });
    container.addEventListener("pointerdown", markChartInteraction);
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      visibleLogicalRangeRef.current = range;
      const followsUserInteraction = Date.now() - lastChartInteractionAtRef.current < 1_500;
      if (didSetInitialRangeRef.current && !isApplyingProgrammaticRangeRef.current && range && followsUserInteraction) {
        userAdjustedRangeRef.current = true;
      }
      if (range && followsUserInteraction && Number(range.from) <= 25) {
        loadOlderCandles().catch(() => undefined);
      }
      window.requestAnimationFrame(() => refreshOverlays(renderedCandlesRef.current));
    });

    return () => {
      container.removeEventListener("wheel", markChartInteraction);
      container.removeEventListener("pointerdown", markChartInteraction);
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!candleSeriesRef.current || !ema20Ref.current || !ema50Ref.current || !ema200Ref.current) return;
    const cleanCandles = normalizeCandles(candles);
    const previouslyRendered = renderedCandlesRef.current;
    const chartCandles = cleanCandles.map((candle) => ({
      time: toChartTime(candle.timestampUtc),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close
    }));
    const replacesLatest = cleanCandles.length > 0
      && cleanCandles.length === previouslyRendered.length
      && cleanCandles.at(-1)?.timestampUtc === previouslyRendered.at(-1)?.timestampUtc
      && cleanCandles[0]?.timestampUtc === previouslyRendered[0]?.timestampUtc;
    const appendsLatest = cleanCandles.length === previouslyRendered.length + 1
      && cleanCandles.at(-2)?.timestampUtc === previouslyRendered.at(-1)?.timestampUtc;
    const indicatorModeChanged = renderedShowEmaRef.current !== showEma;
    const incremental = !indicatorModeChanged && (replacesLatest || appendsLatest);
    if (incremental) {
      const latestCandle = chartCandles.at(-1);
      if (latestCandle) candleSeriesRef.current.update(latestCandle);
      if (showEma) {
        updateLatestLinePoint(ema20Ref.current, emaSeries(cleanCandles, 20));
        updateLatestLinePoint(ema50Ref.current, emaSeries(cleanCandles, 50));
        updateLatestLinePoint(ema200Ref.current, emaSeries(cleanCandles, 200));
      }
    } else {
      const preservedRange = visibleLogicalRangeRef.current;
      candleSeriesRef.current.setData(chartCandles);
      ema20Ref.current.setData(showEma ? emaSeries(cleanCandles, 20) : []);
      ema50Ref.current.setData(showEma ? emaSeries(cleanCandles, 50) : []);
      ema200Ref.current.setData(showEma ? emaSeries(cleanCandles, 200) : []);
      const prepended = pendingPrependCountRef.current;
      if (prepended > 0 && preservedRange && userAdjustedRangeRef.current) {
        applyVisibleLogicalRange({
          from: (Number(preservedRange.from) + prepended) as Logical,
          to: (Number(preservedRange.to) + prepended) as Logical
        });
      }
      pendingPrependCountRef.current = 0;
    }
    renderedCandlesRef.current = cleanCandles;
    renderedShowEmaRef.current = showEma;
    candleSeriesRef.current.setMarkers(
      [...moduleEvidenceMarkers(activeSetup), ...validSetupMarker(activeSetup), ...paperTradeMarkers(tradeMarkers)]
        .sort((left, right) => Number(left.time) - Number(right.time))
    );
    if (cleanCandles.length > 0 && !didSetInitialRangeRef.current) {
      applyCompactLatestRange(cleanCandles.length);
      didSetInitialRangeRef.current = true;
    }
    window.requestAnimationFrame(() => refreshOverlays(cleanCandles));
  }, [candles, setup, tradeMarkers, showEma]);

  useEffect(() => {
    window.requestAnimationFrame(() => refreshOverlays(normalizeCandles(candles)));
  }, [activeSetup, session, moduleCode, effectiveOpeningRange, effectiveOrbRanges]);

  useEffect(() => {
    if (!candleSeriesRef.current) return;
    priceLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line as never));
    priceLinesRef.current = [];
    const defaultLines = [
      ...effectiveOrbRanges.flatMap((range, index) => sessionOrbPriceLines(range, index)),
      { title: "Entry", price: numberValue(activeSetup?.entry_price), color: "#16a46c" },
      { title: "Stop", price: numberValue(activeSetup?.stop_price), color: "#e05252" },
      { title: "Target", price: numberValue(activeSetup?.target_price), color: "#7c9cff" }
    ];
    const lines = moduleCode === "orb_max_options"
      ? defaultLines
      : priceLines?.length
        ? priceLines.map((line) => ({ ...line, price: numberValue(line.price) }))
        : defaultLines;
    for (const line of lines) {
      if (line.price == null) continue;
      priceLinesRef.current.push(
        candleSeriesRef.current.createPriceLine({
          price: line.price,
          color: line.color,
          lineWidth: 2,
          lineStyle: 2,
          axisLabelVisible: true,
          title: line.title
        })
      );
    }
  }, [effectiveOpeningRange, effectiveOrbRanges, activeSetup, priceLines, moduleCode]);

  const liveIndicators = useMemo(() => indicatorSnapshot(normalizeCandles(candles), indicators), [candles, indicators]);
  const latest = candles.at(-1);
  const trendBias = useMemo(() => {
    if (!liveIndicators?.ema20 || !liveIndicators.ema50) return "Waiting";
    if (liveIndicators.ema20 > liveIndicators.ema50) return "Bullish";
    if (liveIndicators.ema20 < liveIndicators.ema50) return "Bearish";
    return "Neutral";
  }, [liveIndicators]);
  const feedLabel = feedProviderName(feedStatus?.provider);
  const feedFreshness = feedStatus?.live ? "LIVE" : feedStatus?.testMode ? `TEST ${formatAge(feedStatus.testAgeSeconds)}` : feedStatus?.latestCandle ? `STALE ${formatAge(feedStatus.ageSeconds)}` : "NO LIVE CANDLES";
  const storageLabel = feedStatus?.provider === "TWELVE_DATA" && feedStatus?.persistRawCandles === false ? "Live memory" : "PostgreSQL cache";

  function zoom(multiplier: number) {
    lastChartInteractionAtRef.current = Date.now();
    userAdjustedRangeRef.current = true;
    const currentSpacing = chartRef.current?.timeScale().options().barSpacing ?? barSpacingRef.current;
    barSpacingRef.current = Math.min(18, Math.max(1, currentSpacing * multiplier));
    chartRef.current?.timeScale().applyOptions({ barSpacing: barSpacingRef.current });
  }

  function showLatestRange() {
    if (candles.length === 0) return;
    userAdjustedRangeRef.current = false;
    applyCompactLatestRange(candles.length);
  }

  function applyCompactLatestRange(candleCount: number) {
    if (!chartRef.current || candleCount === 0) return;
    const visibleBars = Math.min(INITIAL_CHART_CANDLES, candleCount);
    const lastIndex = candleCount - 1;
    applyVisibleLogicalRange({
      from: (lastIndex - visibleBars + 0.5) as Logical,
      to: (lastIndex + CHART_RIGHT_OFFSET) as Logical
    });
  }

  function applyVisibleLogicalRange(range: LogicalRange) {
    if (!chartRef.current) return;
    isApplyingProgrammaticRangeRef.current = true;
    chartRef.current.timeScale().setVisibleLogicalRange(range);
    window.setTimeout(() => {
      isApplyingProgrammaticRangeRef.current = false;
    }, 0);
  }

  function refreshOverlays(cleanCandles: TwelveDataCandle[]) {
    setOverlays(buildPositionedOverlays({
      candles: cleanCandles,
      moduleCode,
      session,
      openingRange: effectiveOpeningRange,
      orbRanges: effectiveOrbRanges,
      setup: activeSetup,
      chart: chartRef.current,
      series: candleSeriesRef.current,
      container: containerRef.current
    }));
  }

  return (
    <div className="live-chart-wrap">
      <div className="chart-toolbar">
        <div className="legend">
          {showEma ? (
            <>
              <span><i style={{ background: lineColors.ema20 }} />EMA 20</span>
              <span><i style={{ background: lineColors.ema50 }} />EMA 50</span>
              <span><i style={{ background: lineColors.ema200 }} />EMA 200</span>
            </>
          ) : (
            <>
              <span><i style={{ background: "#1f7a8c" }} />Recent ORB High</span>
              <span><i style={{ background: "#f0b429" }} />Recent ORB Mid</span>
              <span><i style={{ background: "#e05252" }} />Recent ORB Low</span>
            </>
          )}
        </div>
        <div className="chart-buttons">
          <button title="Zoom out" onClick={() => zoom(0.75)}><ZoomOut size={15} /></button>
          <button title="Zoom in" onClick={() => zoom(1.35)}><ZoomIn size={15} /></button>
          <button title="Show latest candles" onClick={showLatestRange}><Maximize2 size={15} /></button>
          <button title="Refresh chart" onClick={() => refreshChartData().catch(() => onMessage("Refresh failed."))}><RefreshCcw size={15} /></button>
        </div>
      </div>
      <div className="data-status">
        <span>Market feed</span>
        <strong>{feedLabel}</strong>
        <span>Storage</span>
        <strong>{storageLabel}</strong>
        <span>Status</span>
        <strong className={feedStatus?.live ? "good" : "warn"}>{feedFreshness}</strong>
        <span>Socket</span>
        <strong className={socketStatus === "LIVE SOCKET" ? "good" : "warn"}>{socketStatus}</strong>
        <span>Latest candle</span>
        <strong>{formatNepalTime(liveIndicators?.latestTimestampUtc)}</strong>
        {moduleCode === "orb_max_options" ? (
          <>
            <span>Signal logic</span>
            <strong>15M range / 5M trigger</strong>
            <span>ORB range</span>
            <strong className={orbRangeState?.range ? "good" : "warn"}>{orbRangeState?.label ?? "MISSING"}</strong>
            <span>ORB values</span>
            <strong>{effectiveOrbRanges.length > 0 ? effectiveOrbRanges.map((range) => `${range.shortLabel ?? "ORB"} ${format(numberValue(range.high))}/${format(numberValue(range.midpoint))}/${format(numberValue(range.low))}`).join(" | ") : `${orbRangeState?.candleCount ?? 0}/3 candles`}</strong>
          </>
        ) : null}
      </div>
      <div className="chart-stage">
        <div className="chart-canvas" ref={containerRef} />
        {chartLoading ? <div className="chart-loading-state"><span />Loading recent candles...</div> : null}
        <div className="chart-overlays" aria-hidden="true">
          {overlays.map((overlay) => (
            <div
              key={overlay.id}
              className={`chart-overlay-box ${overlay.tone}`}
              style={{
                left: overlay.left,
                top: overlay.top,
                width: overlay.width,
                height: overlay.height
              }}
            >
              <span>{overlay.label}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="indicator-strip">
        <Readout label="Price" value={latest?.close?.toFixed(2) ?? "--"} />
        <Readout label="EMA 20" value={format(liveIndicators?.ema20)} />
        <Readout label="EMA 50" value={format(liveIndicators?.ema50)} />
        <Readout label="EMA 200" value={format(liveIndicators?.ema200)} />
        <Readout label="ATR 14" value={format(liveIndicators?.atr14)} />
        <Readout label="Spread" value={format(liveIndicators?.spread)} />
        <Readout label="Bias" value={trendBias} />
        <Readout label="Candles" value={liveIndicators?.candleCount ?? 0} />
      </div>
    </div>
  );
}

export function LiveChart(props: TwelveDataChartProps) {
  return <TwelveDataChart {...props} />;
}

function feedProviderName(provider?: string) {
  if (provider === "TWELVE_DATA") return "Twelve Data";
  if (provider && provider !== "NONE") return provider;
  return "Waiting";
}

function Readout({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function toChartTime(timestamp: string): UTCTimestamp {
  return Math.floor(new Date(timestamp).getTime() / 1000) as UTCTimestamp;
}

function numberValue(value: unknown) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function module1OrbRangeState(
  openingRange: TwelveDataChartProps["openingRange"],
  candles: TwelveDataCandle[],
  session: TwelveDataChartProps["session"]
) {
  if (numberValue(openingRange?.high) != null && numberValue(openingRange?.low) != null) {
    return { source: "backend", label: "BACKEND", range: openingRange, candleCount: 3 };
  }
  const cleanCandles = normalizeCandles(candles);
  const sessionWindow = session?.session_start_at && session.opening_range_end_at
    ? { start: session.session_start_at, end: session.opening_range_end_at, source: "session" }
    : null;
  const directWindow = module1OrbWindowFromCandles(cleanCandles);
  const candidates = [sessionWindow, directWindow].filter(Boolean) as Array<{ start: string; end: string; source: string }>;
  if (candidates.length === 0) return { source: "missing", label: "NO WINDOW", range: openingRange, candleCount: 0 };
  let best = { window: candidates[0], rangeCandles: [] as TwelveDataCandle[] };
  for (const candidate of candidates) {
    const rangeCandles = module1RangeCandlesForWindow(cleanCandles, candidate.start, candidate.end);
    if (rangeCandles.length > best.rangeCandles.length) best = { window: candidate, rangeCandles };
    if (rangeCandles.length >= 3) break;
  }
  if (best.rangeCandles.length < 3) {
    return {
      source: best.window.source,
      label: `${best.window.source.toUpperCase()} ${best.rangeCandles.length}/3`,
      range: openingRange,
      candleCount: best.rangeCandles.length
    };
  }
  const high = Math.max(...best.rangeCandles.map((candle) => candle.high));
  const low = Math.min(...best.rangeCandles.map((candle) => candle.low));
  return {
    source: best.window.source,
    label: best.window.source === "session" ? "CHART FALLBACK" : "NY 09:15 FALLBACK",
    candleCount: best.rangeCandles.length,
    range: {
      high,
      low,
      midpoint: (high + low) / 2
    }
  };
}

function normalizeOrbRanges(
  ranges: NonNullable<TwelveDataChartProps["orbRanges"]>,
  fallback: TwelveDataChartProps["openingRange"]
) {
  const clean = ranges
    .map((range) => ({
      ...range,
      shortLabel: range.shortLabel ?? sessionShortLabel(range.session_preset),
      high: numberValue(range.high),
      midpoint: numberValue(range.midpoint),
      low: numberValue(range.low)
    }))
    .filter((range) => range.high != null && range.midpoint != null && range.low != null)
    .slice(0, 2);
  if (clean.length > 0) return clean;
  if (numberValue(fallback?.high) != null && numberValue(fallback?.midpoint) != null && numberValue(fallback?.low) != null) {
    return [{
      session_preset: "ORB_FALLBACK",
      label: "Current ORB",
      shortLabel: "ORB",
      high: numberValue(fallback?.high),
      midpoint: numberValue(fallback?.midpoint),
      low: numberValue(fallback?.low),
      session_start_at: null,
      opening_range_end_at: null
    }];
  }
  return [];
}

function sessionOrbPriceLines(range: ReturnType<typeof normalizeOrbRanges>[number], index: number) {
  const colors = index === 0
    ? { high: "#1f7a8c", mid: "#f0b429", low: "#e05252" }
    : { high: "#38bdf8", mid: "#d9a520", low: "#ff7a7a" };
  const label = range.shortLabel ?? "ORB";
  return [
    { title: `${label} ORB High`, price: numberValue(range.high), color: colors.high },
    { title: `${label} ORB Mid`, price: numberValue(range.midpoint), color: colors.mid },
    { title: `${label} ORB Low`, price: numberValue(range.low), color: colors.low }
  ];
}

function sessionShortLabel(preset?: string | null) {
  if (preset === "SYDNEY_ORB") return "SY";
  if (preset === "TOKYO_ORB") return "TY";
  if (preset === "LONDON_ORB") return "LN";
  if (preset === "NEW_YORK_ORB" || preset === "NY_0915" || preset === "NY_0930") return "NY";
  return "ORB";
}

function module1RangeCandlesForWindow(candles: TwelveDataCandle[], startAt: string, endAt: string) {
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const strict = candles.filter((candle) => {
    const time = new Date(candle.timestampUtc).getTime();
    return time >= start && time < end;
  }).slice(0, 3);
  if (strict.length >= 3) return strict;
  return candles.filter((candle) => new Date(candle.timestampUtc).getTime() >= start).slice(0, 3);
}

function module1OrbWindowFromCandles(candles: TwelveDataCandle[]) {
  const latest = candles.at(-1);
  if (!latest) return null;
  const sessionDate = newYorkDateForTimestamp(latest.timestampUtc);
  const start = zonedDateTimeToUtc(sessionDate, "09:15", "America/New_York");
  const end = zonedDateTimeToUtc(sessionDate, "09:30", "America/New_York");
  return { start, end, source: "ny0915" };
}

function newYorkDateForTimestamp(timestampUtc: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestampUtc));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function zonedDateTimeToUtc(date: string, hhmm: string, timeZone: string) {
  const [hour, minute] = hhmm.split(":").map(Number);
  const utcGuess = new Date(`${date}T${hhmm}:00.000Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(utcGuess);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const zonedAsUtc = Date.UTC(Number(lookup.year), Number(lookup.month) - 1, Number(lookup.day), Number(lookup.hour), Number(lookup.minute), Number(lookup.second));
  const [year, month, day] = date.split("-").map(Number);
  const wantedAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  return new Date(utcGuess.getTime() + (wantedAsUtc - zonedAsUtc)).toISOString();
}

function format(value: number | null | undefined) {
  return value == null ? "--" : value.toFixed(2);
}

function formatNepalTime(value?: string | null) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kathmandu",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short"
  }).format(new Date(value));
}

function formatAge(seconds: number | null | undefined) {
  if (seconds == null) return "--";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function normalizeCandles(candles: TwelveDataCandle[]) {
  const byTime = new Map<number, TwelveDataCandle>();
  for (const candle of candles) {
    byTime.set(toChartTime(candle.timestampUtc), candle);
  }
  return [...byTime.values()].sort((left, right) => toChartTime(left.timestampUtc) - toChartTime(right.timestampUtc));
}

function emaSeries(candles: TwelveDataCandle[], period: number) {
  if (candles.length < period) return [];
  const multiplier = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((sum, candle) => sum + candle.close, 0) / period;
  const data = [{ time: toChartTime(candles[period - 1].timestampUtc), value: ema }];
  for (const candle of candles.slice(period)) {
    ema = candle.close * multiplier + ema * (1 - multiplier);
    data.push({ time: toChartTime(candle.timestampUtc), value: ema });
  }
  return data;
}

function updateLatestLinePoint(series: ISeriesApi<"Line">, data: Array<{ time: UTCTimestamp; value: number }>) {
  const latest = data.at(-1);
  if (latest) series.update(latest);
}

function indicatorSnapshot(candles: TwelveDataCandle[], fallback: IndicatorSnapshot | null): IndicatorSnapshot {
  const latest = candles.at(-1);
  if (!latest) {
    return fallback ?? {
      latestPrice: null,
      latestTimestampUtc: null,
      spread: null,
      ema20: null,
      ema50: null,
      ema200: null,
      atr14: null,
      candleCount: 0
    };
  }
  return {
    latestPrice: latest.close,
    latestTimestampUtc: latest.timestampUtc,
    spread: latest.spread ?? fallback?.spread ?? null,
    ema20: latestEma(candles, 20) ?? fallback?.ema20 ?? null,
    ema50: latestEma(candles, 50) ?? fallback?.ema50 ?? null,
    ema200: latestEma(candles, 200) ?? fallback?.ema200 ?? null,
    atr14: latestAtr(candles, 14) ?? fallback?.atr14 ?? null,
    candleCount: candles.length
  };
}

function latestEma(candles: TwelveDataCandle[], period: number) {
  const series = emaSeries(candles, period);
  return series.at(-1)?.value ?? null;
}

function latestAtr(candles: TwelveDataCandle[], period: number) {
  if (candles.length <= period) return null;
  const trueRanges = candles.slice(1).map((candle, index) => {
    const previousClose = candles[index].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
  const recent = trueRanges.slice(-period);
  return recent.reduce((sum, value) => sum + value, 0) / period;
}

function validSetupMarker(setup: TwelveDataChartProps["setup"]): SeriesMarker<Time>[] {
  if (!setup?.detected_at || !setup.direction) return [];
  const isLong = setup.direction === "LONG";
  const isValid =
    setup.status === "LONG SETUP READY" ||
    setup.status === "SHORT SETUP READY" ||
    setup.status === "PAPER_TRADE_OPENED";
  if (!isValid) return [];
  return [
    {
      time: toChartTime(setup.detected_at),
      position: isLong ? "belowBar" : "aboveBar",
      color: isLong ? "#16a46c" : "#e05252",
      shape: isLong ? "arrowUp" : "arrowDown",
      text: `${isLong ? "BUY" : "SELL"} ${setup.scenario ? setup.scenario.replaceAll("_", " ") : "ORB"}`
    }
  ];
}

function moduleEvidenceMarkers(setup: TwelveDataChartProps["setup"]): SeriesMarker<Time>[] {
  if (!setup?.scenario_flags) return [];
  const flags = setup.scenario_flags;
  const direction = setup.direction;
  const isLong = direction === "LONG";
  const markers: SeriesMarker<Time>[] = [];
  if (setup.module_code !== "high_probability_strategy_2") return [];
  const sweepTime = flags.sweep?.closedBackAt ?? flags.sweep?.sweptAt;
  const confirmedEntry = flags.mandatoryChecklistMatched === true || ["LONG SETUP READY", "SHORT SETUP READY", "PAPER_TRADE_OPENED", "TRADE_PLANNED"].includes(String(setup.status));
  const labelPrefix = confirmedEntry ? "M2" : "M2 Candidate";
  if (sweepTime) {
    markers.push({
      time: toChartTime(sweepTime),
      position: isLong ? "belowBar" : "aboveBar",
      color: "#f0b429",
      shape: "circle",
      text: `${labelPrefix} Sweep`
    });
  }
  const displacementTime = flags.displacement?.candle?.timestampUtc;
  if (displacementTime) {
    markers.push({
      time: toChartTime(displacementTime),
      position: isLong ? "belowBar" : "aboveBar",
      color: "#38bdf8",
      shape: isLong ? "arrowUp" : "arrowDown",
      text: `${labelPrefix} Displacement`
    });
  }
  const bosTime = flags.bos?.candle?.timestampUtc;
  if (bosTime) {
    markers.push({
      time: toChartTime(bosTime),
      position: isLong ? "belowBar" : "aboveBar",
      color: "#a78bfa",
      shape: "square",
      text: `${labelPrefix} BOS`
    });
  }
  const zoneTime = flags.entryZone?.createdAt;
  if (zoneTime) {
    markers.push({
      time: toChartTime(zoneTime),
      position: isLong ? "belowBar" : "aboveBar",
      color: "#7c9cff",
      shape: "circle",
      text: flags.entryZone?.kind === "ORDER_BLOCK" ? `${labelPrefix} OB` : `${labelPrefix} FVG`
    });
  }
  return markers;
}

function paperTradeMarkers(markers: TradeChartMarker[]): SeriesMarker<Time>[] {
  return markers.map((marker) => {
    const isShort = marker.direction === "SHORT";
    if (marker.type === "ENTRY") {
      return {
        time: toChartTime(marker.time),
        position: isShort ? "aboveBar" : "belowBar",
        color: isShort ? "#e05252" : "#16a46c",
        shape: isShort ? "arrowDown" : "arrowUp",
        text: marker.text
      };
    }
    return {
      time: toChartTime(marker.time),
      position: marker.outcome === "WIN" ? "belowBar" : "aboveBar",
      color: marker.outcome === "WIN" ? "#7c9cff" : "#f0b429",
      shape: "circle",
      text: marker.text
    };
  });
}

function buildPositionedOverlays(input: {
  candles: TwelveDataCandle[];
  moduleCode: string;
  session?: TwelveDataChartProps["session"];
  openingRange?: TwelveDataChartProps["openingRange"];
  orbRanges?: ReturnType<typeof normalizeOrbRanges>;
  setup?: TwelveDataChartProps["setup"];
  chart: IChartApi | null;
  series: ISeriesApi<"Candlestick"> | null;
  container: HTMLDivElement | null;
}): PositionedOverlay[] {
  if (!input.chart || !input.series || !input.container || input.candles.length === 0) return [];
  const overlays: PositionedOverlay[] = [];
  const latestTime = input.candles.at(-1)?.timestampUtc;
  const priceToCoordinate = (price: unknown) => {
    const parsed = numberValue(price);
    if (parsed == null) return null;
    const coordinate = (input.series as any).priceToCoordinate(parsed);
    return typeof coordinate === "number" && Number.isFinite(coordinate) ? coordinate : null;
  };
  const timeToCoordinate = (timestamp?: string | null) => {
    if (!timestamp) return null;
    const coordinate = input.chart?.timeScale().timeToCoordinate(toChartTime(timestamp));
    return typeof coordinate === "number" && Number.isFinite(coordinate) ? coordinate : null;
  };
  const addBox = (id: string, label: string, tone: PositionedOverlay["tone"], startAt: string | null | undefined, endAt: string | null | undefined, low: unknown, high: unknown) => {
    const leftCoordinate = timeToCoordinate(startAt);
    const rightCoordinate = timeToCoordinate(endAt);
    const lowCoordinate = priceToCoordinate(low);
    const highCoordinate = priceToCoordinate(high);
    if (leftCoordinate == null || rightCoordinate == null || lowCoordinate == null || highCoordinate == null) return;
    const left = Math.max(0, Math.min(leftCoordinate, rightCoordinate));
    const right = Math.min(input.container!.clientWidth, Math.max(leftCoordinate, rightCoordinate));
    const top = Math.max(0, Math.min(lowCoordinate, highCoordinate));
    const bottom = Math.min(input.container!.clientHeight, Math.max(lowCoordinate, highCoordinate));
    if (right - left < 2 || bottom - top < 2) return;
    overlays.push({ id, label, tone, left, top, width: right - left, height: bottom - top });
  };
  const addHorizontalLine = (id: string, label: string, tone: PositionedOverlay["tone"], price: unknown) => {
    const coordinate = priceToCoordinate(price);
    if (coordinate == null) return;
    if (coordinate < 0 || coordinate > input.container!.clientHeight) return;
    overlays.push({
      id,
      label,
      tone,
      left: 0,
      top: Math.max(0, coordinate - 1),
      width: input.container!.clientWidth,
      height: 2
    });
  };

  const visibleCandles = input.candles.filter((candle) => {
    const x = timeToCoordinate(candle.timestampUtc);
    return x != null && x >= 0 && x <= input.container!.clientWidth;
  });
  const sessionHigh = Math.max(...(visibleCandles.length ? visibleCandles : input.candles).map((candle) => candle.high));
  const sessionLow = Math.min(...(visibleCandles.length ? visibleCandles : input.candles).map((candle) => candle.low));
  if (input.moduleCode === "orb_max_options") {
    const ranges = input.orbRanges?.length ? input.orbRanges : normalizeOrbRanges([], input.openingRange);
    ranges.forEach((range, index) => {
      const prefix = range.shortLabel ?? "ORB";
      addHorizontalLine(`${prefix.toLowerCase()}-orb-high-${index}`, `${prefix} ORB High`, "orbHigh", range.high);
      addHorizontalLine(`${prefix.toLowerCase()}-orb-mid-${index}`, `${prefix} ORB Mid`, "orbMid", range.midpoint);
      addHorizontalLine(`${prefix.toLowerCase()}-orb-low-${index}`, `${prefix} ORB Low`, "orbLow", range.low);
    });
    return overlays;
  }
  if (input.moduleCode === "high_probability_strategy_2" && input.session?.session_start_at && input.session?.signal_window_end_at) {
    addBox("ny-session", "New York", "session", input.session.session_start_at, input.session.signal_window_end_at, sessionLow, sessionHigh);
  }

  if (input.setup?.module_code !== "high_probability_strategy_2" || !input.setup.scenario_flags) return overlays;
  const flags = input.setup.scenario_flags;
  const evidenceEnd = input.setup.detected_at ?? latestTime;
  const zone = flags.entryZone;
  if (zone?.low != null && zone?.high != null) {
    addBox(
      `entry-zone-${zone.kind ?? "zone"}`,
      zone.kind === "ORDER_BLOCK" ? "Order Block" : "FVG",
      zone.kind === "ORDER_BLOCK" ? "orderBlock" : "fvg",
      zone.createdAt ?? flags.displacement?.candle?.timestampUtc,
      evidenceEnd,
      zone.low,
      zone.high
    );
  }

  const sweep = flags.sweep;
  const sweepLevel = numberValue(sweep?.level?.price);
  if (sweepLevel != null) {
    const pad = Math.max(0.18, (sessionHigh - sessionLow) * 0.006);
    addBox(
      "swept-liquidity",
      "Swept Liquidity",
      "sweep",
      sweep.sweptAt ?? sweep.candle?.timestampUtc,
      sweep.closedBackAt ?? flags.displacement?.candle?.timestampUtc ?? evidenceEnd,
      sweepLevel - pad,
      sweepLevel + pad
    );
  }

  const displacement = flags.displacement?.candle;
  if (displacement?.timestampUtc) {
    addBox("module2-displacement", "Displacement", "displacement", displacement.timestampUtc, flags.bos?.candle?.timestampUtc ?? evidenceEnd, displacement.low, displacement.high);
  }

  const bos = flags.bos;
  if (bos?.candle?.timestampUtc && bos?.level != null) {
    const pad = Math.max(0.18, (sessionHigh - sessionLow) * 0.006);
    addBox("module2-bos", "BOS / CHoCH", "bos", bos.candle.timestampUtc, evidenceEnd, Number(bos.level) - pad, Number(bos.level) + pad);
  }

  const invalidation = flags.invalidation;
  if (invalidation?.time && zone?.low != null && zone?.high != null) {
    addBox("module2-invalid", "Invalidated", "invalid", invalidation.time, evidenceEnd, zone.low, zone.high);
  }

  return overlays;
}

function addMinutes(timestamp: string | null | undefined, minutes: number) {
  if (!timestamp) return null;
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(time + minutes * 60_000).toISOString();
}
