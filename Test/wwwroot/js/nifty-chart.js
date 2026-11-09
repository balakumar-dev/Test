/**
 * nifty-chart.js  –  NIFTY 50 live signal dashboard
 *
 * Left  chart : NIFTY 50 candlestick (index) — sweep / confirmation / BUY-SELL markers
 * Right chart : Option OHLC candlestick — entry marker, stop-loss exit marker, entry price line
 * Bottom      : Trade information panel + day-wise paper P&L table
 *
 * Sequential trade logic:
 *   • Only ONE active option trade at a time (enforced on the backend).
 *   • Each BUY/SELL signal is entered in chronological order.
 *   • Stop-loss = NIFTY 50 confirmation-candle Low (BUY) or High (SELL).
 *   • After SL hit, the right chart keeps showing the closed trade;
 *     next unprocessed signal opens Trade #2, etc.
 *
 * Polls /Nifty/GetSignalData every 30 s.
 * Polls /Nifty/GetOptionChart?symbol=... when an option symbol is active.
 * Polls /Nifty/GetPaperTrades every 30 s.
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const SIGNAL_URL = '/Nifty/GetSignalData';
const PNL_URL    = '/Nifty/GetPaperTrades';
const REFRESH_MS = 30_000;

const COLOR_UP    = '#26a69a';
const COLOR_DOWN  = '#ef5350';
const COLOR_PDH   = '#ef5350';
const COLOR_PDL   = '#26a69a';
const COLOR_PDC   = '#ffc107';
const COLOR_ORH   = '#a78bfa';
const COLOR_ORL   = '#60a5fa';
const COLOR_BG    = '#16181f';
const COLOR_GRID  = 'rgba(255,255,255,0.06)';
const COLOR_TEXT  = '#aaaaaa';

const TRADE_STATUS_ACTIVE   = 'Active';
const TRADE_STATUS_SL       = 'StoppedOut';
const TRADE_STATUS_EOD      = 'ClosedEOD';

// ─── NIFTY chart state ────────────────────────────────────────────────────────
let lwChart      = null;
let candleSeries = null;
const priceLineMap = {};
let previousClose = null;

// ─── Option chart state ───────────────────────────────────────────────────────
let optChart         = null;
let optCandleSeries  = null;
let optEntryLine     = null;
let optSlLine        = null;   // red SL line on option chart
let _lastOptSymbol   = null;   // track symbol changes

// ─── DOM ready ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initChart();
    initOptionChart();
    refresh();
    setInterval(refresh, REFRESH_MS);
});

// ─── NIFTY candlestick chart ──────────────────────────────────────────────────
function initChart() {
    const container = document.getElementById('chartContainer');
    if (!container) return;

    lwChart = LightweightCharts.createChart(container, {
        width:  container.clientWidth,
        height: container.clientHeight,
        layout: {
            background: { type: 'solid', color: COLOR_BG },
            textColor:  COLOR_TEXT,
            fontSize:   12
        },
        grid: {
            vertLines: { color: COLOR_GRID },
            horzLines: { color: COLOR_GRID }
        },
        rightPriceScale: {
            borderColor:  '#2a2d3a',
            scaleMargins: { top: 0.1, bottom: 0.1 }
        },
        timeScale: {
            borderColor:    '#2a2d3a',
            timeVisible:    true,
            secondsVisible: false,
            rightOffset:    5,
            barSpacing:     8,
            minBarSpacing:  4
        },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        handleScroll: { mouseWheel: true, pressedMouseMove: true },
        handleScale:  { mouseWheel: true, pinch: true }
    });

    candleSeries = lwChart.addCandlestickSeries({
        upColor:         COLOR_UP,
        downColor:       COLOR_DOWN,
        borderUpColor:   COLOR_UP,
        borderDownColor: COLOR_DOWN,
        wickUpColor:     COLOR_UP,
        wickDownColor:   COLOR_DOWN
    });

    new ResizeObserver(() => {
        if (lwChart && container)
            lwChart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    }).observe(container);
}

// ─── Option candlestick chart ─────────────────────────────────────────────────
function initOptionChart() {
    const container = document.getElementById('optChartContainer');
    if (!container) return;

    optChart = LightweightCharts.createChart(container, {
        width:  container.clientWidth,
        height: container.clientHeight,
        layout: {
            background: { type: 'solid', color: COLOR_BG },
            textColor:  COLOR_TEXT,
            fontSize:   11
        },
        grid: {
            vertLines: { color: COLOR_GRID },
            horzLines: { color: COLOR_GRID }
        },
        rightPriceScale: {
            borderColor:  '#2a2d3a',
            scaleMargins: { top: 0.1, bottom: 0.05 }
        },
        timeScale: {
            borderColor:    '#2a2d3a',
            timeVisible:    true,
            secondsVisible: false,
            rightOffset:    3,
            barSpacing:     8
        },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        handleScroll: { mouseWheel: true, pressedMouseMove: true },
        handleScale:  { mouseWheel: true, pinch: true }
    });

    optCandleSeries = optChart.addCandlestickSeries({
        upColor:         COLOR_UP,
        downColor:       COLOR_DOWN,
        borderUpColor:   COLOR_UP,
        borderDownColor: COLOR_DOWN,
        wickUpColor:     COLOR_UP,
        wickDownColor:   COLOR_DOWN
    });

    new ResizeObserver(() => {
        if (optChart && container)
            optChart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    }).observe(container);
}

// ─── Main refresh loop ────────────────────────────────────────────────────────
async function refresh() {
    pulseRefreshDot();
    try {
        const resp = await fetch(SIGNAL_URL, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        if (!data.success) {
            showError(data.errorMessage || 'Market data unavailable.');
            return;
        }

        hideError();
        hideLoading();

        updateChart(data);
        updateStatsBar(data);
        updateCurrentPrice(data.currentPrice, data.previousDayClose);
        updateSignalStrip(data);

        setText('lastUpdated', new Date().toLocaleTimeString('en-IN', { hour12: false }));

        // Right chart: option OHLC + trade markers
        await refreshOptionChart(data);

        // P&L table
        await refreshPnl();

    } catch (err) {
        console.error('Refresh error:', err);
        showError('Could not reach the server. Will retry in 30 s.');
    }
}

// ─── NIFTY index chart update ─────────────────────────────────────────────────
function updateChart(data) {
    if (!candleSeries) return;

    const candles = (data.candles || []).map(c => ({
        time:  toDisplayTime(c.time),
        open:  c.open,
        high:  c.high,
        low:   c.low,
        close: c.close
    }));
    if (candles.length > 0) candleSeries.setData(candles);

    updatePriceLine('pdh', data.previousDayHigh,  COLOR_PDH, 'PDH',  LightweightCharts.LineStyle.Solid);
    updatePriceLine('pdc', data.previousDayClose, COLOR_PDC, 'PDC',  LightweightCharts.LineStyle.Dashed);
    updatePriceLine('pdl', data.previousDayLow,   COLOR_PDL, 'PDL',  LightweightCharts.LineStyle.Solid);

    if (data.openingRangeReady) {
        updatePriceLine('orh', data.openingRangeHigh, COLOR_ORH, 'ORH', LightweightCharts.LineStyle.Dashed);
        updatePriceLine('orl', data.openingRangeLow,  COLOR_ORL, 'ORL', LightweightCharts.LineStyle.Dashed);
        const orLegend = document.getElementById('orLegend');
        if (orLegend) orLegend.style.display = '';
    }

    updateMarkers(data.markers || []);
    lwChart.timeScale().fitContent();
}

function updatePriceLine(id, price, color, title, lineStyle) {
    if (!price || price === 0) return;
    const opts = { price, color, lineWidth: 1.5, lineStyle, axisLabelVisible: true, title };
    if (priceLineMap[id]) {
        priceLineMap[id].applyOptions(opts);
    } else {
        priceLineMap[id] = candleSeries.createPriceLine(opts);
    }
}

function updateMarkers(markers) {
    if (!candleSeries || !markers.length) return;
    candleSeries.setMarkers(markers.map(mk => ({
        time:     mk.time,
        position: mk.position || 'aboveBar',
        color:    mk.color    || '#ffffff',
        shape:    mk.shape    || 'circle',
        text:     mk.text     || ''
    })));
}

// ─── Stats bar ────────────────────────────────────────────────────────────────
function updateStatsBar(data) {
    setText('statPDH',      fmt(data.previousDayHigh));
    setText('statPDC',      fmt(data.previousDayClose));
    setText('statPDL',      fmt(data.previousDayLow));
    setText('statCDH',      fmt(data.currentDayHigh));
    setText('statCDL',      fmt(data.currentDayLow));
    setText('statPrevDate', data.previousTradingDate || '—');
    setText('statExpiry',   data.expiryDate || data.expiry || '—');
    setText('statSignals',  `${data.signalsToday} / ${data.maxSignalsPerDay}`);
}

// ─── Current price ────────────────────────────────────────────────────────────
function updateCurrentPrice(price, pdClose) {
    const priceEl  = document.getElementById('currentPrice');
    const changeEl = document.getElementById('priceChange');
    if (!priceEl) return;
    priceEl.textContent = fmt(price);
    if (pdClose && pdClose > 0) {
        const diff = price - pdClose;
        const pct  = (diff / pdClose) * 100;
        const sign = diff >= 0 ? '+' : '';
        changeEl.textContent = `${sign}${fmt(diff)} (${sign}${pct.toFixed(2)}%)`;
        changeEl.className   = `nifty-price-change ${diff >= 0 ? 'text-success' : 'text-danger'}`;
    }
    if (previousClose !== null && price !== previousClose) {
        priceEl.classList.remove('price-flash-up', 'price-flash-down');
        void priceEl.offsetWidth;
        priceEl.classList.add(price >= previousClose ? 'price-flash-up' : 'price-flash-down');
    }
    previousClose = price;
}

// ─── Signal info strip ────────────────────────────────────────────────────────
function updateSignalStrip(data) {
    const bias     = (data.dailyBias || 'Neutral').toLowerCase();
    const biasText = (data.dailyBias || 'Neutral').toUpperCase();

    const badge = document.getElementById('biasBadge');
    if (badge) {
        badge.textContent = biasText;
        badge.className   = `bias-badge bias-${bias}`;
    }

    const ssBias = document.getElementById('ssBias');
    if (ssBias) {
        ssBias.textContent = biasText;
        ssBias.className   = `ss-val ss-bias-${bias}`;
    }

    setText('ssState',         data.statusMessage  || '—');
    setText('ssLastEvent',     data.lastEvent       || '—');
    setText('ssLastEventTime', data.lastEventTime ? '⏱ ' + data.lastEventTime : '');
    setText('ssNextCond',      data.nextCondition   || '—');

    const wrap = document.getElementById('ssSignalWrap');
    if (data.activeSignal && wrap) {
        wrap.classList.remove('d-none');
        const isBuy = (data.activeSignal.type === 'Buy' || data.activeSignal.type === 0);
        const badge2 = document.getElementById('ssSignalBadge');
        const entry  = document.getElementById('ssSignalEntry');
        if (badge2) {
            badge2.textContent = isBuy ? '🟢 BUY' : '🔴 SELL';
            badge2.className   = `ss-signal-badge ${isBuy ? 'ss-signal-buy' : 'ss-signal-sell'}`;
        }
        if (entry) entry.textContent = `@ ${fmt(data.activeSignal.entryPrice)}  ${data.activeSignal.time}`;
    } else if (wrap) {
        wrap.classList.add('d-none');
    }
}

// ─── Option chart (right) ─────────────────────────────────────────────────────
async function refreshOptionChart(signalData) {
    const trade  = signalData?.activePaperTrade || null;  // last trade (active or closed)
    const optSym = signalData?.optionSymbol || trade?.optionSymbol || null;

    updateOptTradeStrip(trade, signalData?.currentPrice);

    const ph = document.getElementById('optChartPlaceholder');
    const ct = document.getElementById('optChartContainer');

    // Update expiry badge in right chart header
    const expiryText = signalData?.expiryDate ? `Expiry: ${signalData.expiryDate}` : (signalData?.expiry ? `Expiry: ${signalData.expiry}` : '');
    setText('optChartExpiry', expiryText);

    if (!optSym) {
        if (ph) ph.style.display = 'flex';
        if (ct) ct.style.display = 'none';
        setText('optChartSymbol', 'Waiting for signal…');
        setText('optChartTitle',  'Option Premium');
        return;
    }

    if (ph) ph.style.display = 'none';
    if (ct) ct.style.display = 'block';

    // ── Reset price lines when symbol changes (new trade) ─────────────────────
    if (optSym !== _lastOptSymbol) {
        if (optEntryLine && optCandleSeries) {
            try { optCandleSeries.removePriceLine(optEntryLine); } catch (_) {}
            optEntryLine = null;
        }
        if (optSlLine && optCandleSeries) {
            try { optCandleSeries.removePriceLine(optSlLine); } catch (_) {}
            optSlLine = null;
        }
        _lastOptSymbol = optSym;
    }

    // Update header
    const isBuy = trade?.signalType === 'Buy';
    const statusLabel = trade ? tradeStatusLabel(trade.status) : '';
    setText('optChartTitle',
        (isBuy ? '🟢 Short PUT' : trade ? '🔴 Short CALL' : 'Option Premium') + statusLabel);
    setText('optChartSymbol', optSym);

    // Fetch OHLC candle data
    try {
        const resp = await fetch(`/Nifty/GetOptionChart?symbol=${encodeURIComponent(optSym)}`,
            { cache: 'no-store' });
        if (!resp.ok) return;
        const json = await resp.json();
        if (!json.success || !json.candles?.length) return;

        // Map to candlestick data using option OHLC
        const candleData = json.candles
            .filter(c => c.time && c.close > 0)
            .map(c => ({
                time:  toDisplayTime(c.time),
                open:  c.open  || c.close,
                high:  c.high  || c.close,
                low:   c.low   || c.close,
                close: c.close
            }));

        if (candleData.length > 0 && optCandleSeries) {
            optCandleSeries.setData(candleData);
        }

        if (!optCandleSeries) { optChart?.timeScale().fitContent(); return; }

        // ── Entry price line (blue dashed) ─────────────────────────────────────
        if (trade?.entryPremium > 0) {
            const entryOpts = {
                price:            trade.entryPremium,
                color:            '#58a6ff',
                lineWidth:        1,
                lineStyle:        LightweightCharts.LineStyle.Dashed,
                axisLabelVisible: true,
                title:            'Entry'
            };
            if (optEntryLine) optEntryLine.applyOptions(entryOpts);
            else              optEntryLine = optCandleSeries.createPriceLine(entryOpts);
        }

        // ── SL line (red solid) — option HIGH at sweep-candle time ─────────────
        if (trade?.slPremium > 0) {
            const slOpts = {
                price:            trade.slPremium,
                color:            '#ef5350',
                lineWidth:        2,
                lineStyle:        LightweightCharts.LineStyle.Solid,
                axisLabelVisible: true,
                title:            `SL ${fmt(trade.slPremium)}`
            };
            if (optSlLine) optSlLine.applyOptions(slOpts);
            else           optSlLine = optCandleSeries.createPriceLine(slOpts);
        } else if (optSlLine) {
            try { optCandleSeries.removePriceLine(optSlLine); } catch (_) {}
            optSlLine = null;
        }

        // ── Chart markers ──────────────────────────────────────────────────────
        const markers = [];

        if (trade?.entryTimestampFakeUtc > 0) {
            markers.push({
                time:     trade.entryTimestampFakeUtc,
                position: 'belowBar',
                color:    '#26a69a',
                shape:    'arrowUp',
                text:     `Entry ₹${(trade.entryPremium || 0).toFixed(2)}`
            });
        }

        if (trade?.status === TRADE_STATUS_SL && trade.exitTimestampFakeUtc > 0) {
            markers.push({
                time:     trade.exitTimestampFakeUtc,
                position: 'aboveBar',
                color:    '#ef5350',
                shape:    'arrowDown',
                text:     'SL Hit'
            });
        }

        if (markers.length > 0) optCandleSeries.setMarkers(markers);

        optChart?.timeScale().fitContent();

    } catch (err) {
        console.error('Option chart fetch error:', err);
    }
}

function updateOptTradeStrip(trade, niftyPrice) {
    const strip = document.getElementById('optTradeInfo');
    if (!strip) return;

    if (!trade) {
        strip.style.display = 'none';
        return;
    }

    strip.style.display = 'flex';

    setText('optEntry',   fmt(trade.entryPremium));
    setText('optCurrent', fmt(trade.isClosed ? trade.exitPremium : trade.currentPremium));

    // P&L
    const pnl   = trade.pnl ?? 0;
    const pnlEl = document.getElementById('optPnl');
    if (pnlEl) {
        const sign = pnl >= 0 ? '+' : '';
        pnlEl.textContent = `${sign}₹${Math.abs(pnl).toFixed(0)}`;
        pnlEl.className   = `opt-trade-val ${pnl >= 0 ? 'opt-profit' : 'opt-loss'}`;
    }

    // Status
    const statEl = document.getElementById('optStatus');
    if (statEl) {
        if (trade.status === TRADE_STATUS_SL) {
            statEl.textContent = '🛑 Stopped Out';
            statEl.className   = 'opt-trade-val opt-stopped';
        } else if (trade.status === TRADE_STATUS_EOD) {
            statEl.textContent = '✓ Closed (EOD)';
            statEl.className   = 'opt-trade-val opt-closed';
        } else {
            statEl.textContent = '● Active';
            statEl.className   = 'opt-trade-val opt-open';
        }
    }

    // SL badges
    const slEl = document.getElementById('optSL');
    if (slEl) {
        const niftySLText = trade.stopLossLevel > 0
            ? (trade.signalType === 'Buy'
                ? `NIFTY SL: ${fmt(trade.stopLossLevel)} (sweep)`
                : `NIFTY SL: ${fmt(trade.stopLossLevel)} (confirm)`)
            : '';

        const premSLText = trade.slPremium > 0
            ? `  |  Premium SL: ₹${fmt(trade.slPremium)}${trade.initialSlPremium > 0 && trade.slPremium < trade.initialSlPremium ? ' 📉' : ''}`
            : '';

        slEl.textContent = niftySLText + premSLText;

        if (trade.status === TRADE_STATUS_ACTIVE) {
            if (trade.slPremium > 0 && trade.currentPremium > 0) {
                const premDist = trade.slPremium - trade.currentPremium;
                slEl.className = premDist <= 5
                    ? 'opt-sl-badge opt-sl-danger'
                    : premDist <= 20
                        ? 'opt-sl-badge opt-sl-warn'
                        : 'opt-sl-badge';
            } else if (niftyPrice && trade.stopLossLevel > 0) {
                const dist = trade.signalType === 'Buy'
                    ? niftyPrice - trade.stopLossLevel
                    : trade.stopLossLevel - niftyPrice;
                slEl.className = dist <= 10
                    ? 'opt-sl-badge opt-sl-danger'
                    : dist <= 30
                        ? 'opt-sl-badge opt-sl-warn'
                        : 'opt-sl-badge';
            } else {
                slEl.className = 'opt-sl-badge';
            }
        } else if (trade.status === TRADE_STATUS_SL) {
            slEl.className   = 'opt-sl-badge opt-sl-hit';
            slEl.textContent += ` — HIT ${trade.exitTime}`;
        } else {
            slEl.className = 'opt-sl-badge';
        }
    }

    // Exit reason
    const reasonEl = document.getElementById('optExitReason');
    if (reasonEl) {
        reasonEl.textContent = trade.isClosed ? trade.exitReason || '' : '';
        reasonEl.style.display = trade.isClosed && trade.exitReason ? '' : 'none';
    }

    // Trade ID
    setText('optTradeId', trade.tradeId ? `Trade #${trade.tradeId}` : '');
    setText('optConfirmTime', trade.confirmationCandleTime
        ? `Confirm candle: ${trade.confirmationCandleTime}` : '');
}

function tradeStatusLabel(status) {
    if (status === TRADE_STATUS_SL)  return ' 🛑';
    if (status === TRADE_STATUS_EOD) return ' ✓';
    return '';
}

// ─── Paper P&L refresh ────────────────────────────────────────────────────────
async function refreshPnl() {
    try {
        const resp = await fetch(PNL_URL, { cache: 'no-store' });
        if (!resp.ok) return;
        const data = await resp.json();
        if (!data.success) return;
        renderPnlTable(data.days || []);
    } catch (err) {
        console.error('P&L fetch error:', err);
    }
}

function renderPnlTable(days) {
    const loading    = document.getElementById('pnlLoading');
    const empty      = document.getElementById('pnlEmpty');
    const tableWrap  = document.getElementById('pnlTableWrap');
    const tbody      = document.getElementById('pnlBody');
    const grandTotal = document.getElementById('pnlGrandTotal');
    const statPnl    = document.getElementById('statPnl');

    if (loading) loading.style.display = 'none';

    if (!days || days.length === 0) {
        empty?.classList.remove('d-none');
        tableWrap?.classList.add('d-none');
        return;
    }

    empty?.classList.add('d-none');
    tableWrap?.classList.remove('d-none');

    const total    = days.reduce((s, d) => s + (d.totalPnl || 0), 0);
    const totalStr = `${total >= 0 ? '+' : ''}₹${Math.abs(total).toFixed(0)}`;
    if (grandTotal) {
        grandTotal.textContent = totalStr;
        grandTotal.className   = `pnl-grand-total ${total >= 0 ? 'pnl-profit' : 'pnl-loss'}`;
    }
    if (statPnl) {
        statPnl.textContent = totalStr;
        statPnl.className   = `stat-value ${total >= 0 ? 'stat-success' : 'stat-danger'}`;
    }

    tbody.innerHTML = '';
    days.forEach(day => {
        const dayPnl  = day.totalPnl || 0;
        const daySign = dayPnl >= 0 ? '+' : '';

        // Day summary row
        const dayRow = document.createElement('tr');
        dayRow.className = 'pnl-day-row';
        dayRow.innerHTML =
            `<td colspan="8" class="pnl-date-cell">📅 ${day.date}</td>` +
            `<td class="pnl-pnl-cell ${dayPnl >= 0 ? 'pnl-profit' : 'pnl-loss'} text-end">` +
                `${daySign}₹${Math.abs(dayPnl).toFixed(0)}</td>` +
            `<td class="pnl-status-cell">${day.winningTrades}W / ${day.losingTrades}L</td>`;
        tbody.appendChild(dayRow);

        (day.trades || []).forEach((t, idx) => {
            const pnl       = t.pnl || 0;
            const sign      = pnl >= 0 ? '+' : '';
            const isActive  = t.status === TRADE_STATUS_ACTIVE;
            const isSL      = t.status === TRADE_STATUS_SL;

            const sigBadge  = t.signalType === 'Buy'
                ? '<span class="pnl-badge pnl-buy-badge">BUY</span>'
                : '<span class="pnl-badge pnl-sell-badge">SELL</span>';
            const optBadge  = t.optionType === 'PE'
                ? '<span class="pnl-badge pnl-pe-badge">PUT</span>'
                : '<span class="pnl-badge pnl-ce-badge">CALL</span>';
            const slBadge   = isSL ? '<span class="pnl-badge pnl-sl-badge">SL</span>' : '';

            const exitVal   = t.isClosed ? t.exitPremium : t.currentPremium;
            const statusTxt = isActive ? '● Active'
                : isSL                 ? '🛑 SL Hit'
                                       : '✓ Closed';

            const tr = document.createElement('tr');
            tr.className = `pnl-trade-row${isActive ? ' pnl-row-open' : ''}${isSL ? ' pnl-row-sl' : ''}`;
            tr.innerHTML =
                `<td class="pnl-date-sub">${t.tradingDate}</td>` +
                `<td class="pnl-time-cell">${t.entryTime}</td>` +
                `<td class="pnl-symbol">${t.optionSymbol}</td>` +
                `<td>${optBadge} ${sigBadge}</td>` +
                `<td class="pnl-sl-col">${fmt(t.stopLossLevel)} <span class="pnl-sl-label">NIFTY SL</span></td>` +
                `<td class="pnl-num text-end">${fmt(t.entryPremium)}</td>` +
                `<td class="pnl-num text-end">${fmt(exitVal)}${slBadge}</td>` +
                `<td class="pnl-pnl-cell ${pnl >= 0 ? 'pnl-profit' : 'pnl-loss'} text-end">${sign}₹${Math.abs(pnl).toFixed(0)}</td>` +
                `<td class="pnl-status-cell ${isActive ? 'pnl-status-open' : isSL ? 'pnl-status-sl' : 'pnl-status-closed'}">${statusTxt}</td>` +
                `<td class="pnl-exit-time">${t.exitTime || '—'}</td>`;
            tbody.appendChild(tr);
        });
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toDisplayTime(isoStr) {
    return Math.floor(new Date(isoStr.slice(0, 19) + 'Z').getTime() / 1000);
}

function fmt(v) {
    if (!v && v !== 0) return '—';
    return Number(v).toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text ?? '';
}

function showError(msg) {
    setText('errorMsg', msg);
    document.getElementById('errorBanner')?.classList.remove('d-none');
}

function hideError() {
    document.getElementById('errorBanner')?.classList.add('d-none');
}

function hideLoading() {
    const el = document.getElementById('chartLoading');
    if (el) el.style.display = 'none';
}

function pulseRefreshDot() {
    const dot = document.getElementById('refreshDot');
    if (!dot) return;
    dot.classList.remove('dot-pulse');
    void dot.offsetWidth;
    dot.classList.add('dot-pulse');
}
