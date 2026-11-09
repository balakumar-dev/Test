using System.Text.Json.Serialization;
using Test.Models;

namespace Test.Models.Signal
{
    /// <summary>
    /// Full JSON payload sent to the browser on each 30-second poll.
    /// Extends the chart data with bias, state-machine info, markers, the active signal, and expiry info.
    /// </summary>
    public class SignalDataViewModel
    {
        // ── Chart / price data (mirrors ChartDataViewModel) ───────────────────
        [JsonPropertyName("success")]
        public bool Success { get; set; } = true;

        [JsonPropertyName("errorMessage")]
        public string? ErrorMessage { get; set; }

        [JsonPropertyName("currentPrice")]
        public double CurrentPrice { get; set; }

        [JsonPropertyName("previousDayHigh")]
        public double PreviousDayHigh { get; set; }

        [JsonPropertyName("previousDayLow")]
        public double PreviousDayLow { get; set; }

        [JsonPropertyName("previousDayClose")]
        public double PreviousDayClose { get; set; }

        [JsonPropertyName("currentDayHigh")]
        public double CurrentDayHigh { get; set; }

        [JsonPropertyName("currentDayLow")]
        public double CurrentDayLow { get; set; }

        [JsonPropertyName("currentTradingDate")]
        public string CurrentTradingDate { get; set; } = string.Empty;

        [JsonPropertyName("previousTradingDate")]
        public string PreviousTradingDate { get; set; } = string.Empty;

        [JsonPropertyName("candles")]
        public List<CandleViewModel> Candles { get; set; } = new();

        // ── Expiry info ───────────────────────────────────────────────────────
        /// <summary>Groww symbol expiry code, e.g. "26N12".</summary>
        [JsonPropertyName("expiry")]
        public string Expiry { get; set; } = string.Empty;

        /// <summary>Human-readable expiry date, e.g. "12-Nov-2026".</summary>
        [JsonPropertyName("expiryDate")]
        public string ExpiryDate { get; set; } = string.Empty;

        // ── Signal engine data ────────────────────────────────────────────────

        /// <summary>Today's directional bias: "Bullish", "Bearish", or "Neutral".</summary>
        [JsonPropertyName("dailyBias")]
        public string DailyBias { get; set; } = "Neutral";

        /// <summary>Previous day upper wick in points.</summary>
        [JsonPropertyName("prevDayUpperWick")]
        public double PrevDayUpperWick { get; set; }

        /// <summary>Previous day lower wick in points.</summary>
        [JsonPropertyName("prevDayLowerWick")]
        public double PrevDayLowerWick { get; set; }

        // ── Opening Range ─────────────────────────────────────────────────────

        /// <summary>Today's Opening Range High (first N minutes). 0 until OR period ends.</summary>
        [JsonPropertyName("openingRangeHigh")]
        public double OpeningRangeHigh { get; set; }

        /// <summary>Today's Opening Range Low (first N minutes). 0 until OR period ends.</summary>
        [JsonPropertyName("openingRangeLow")]
        public double OpeningRangeLow { get; set; }

        /// <summary>True once the OR period is complete and ORH/ORL are active sweep levels.</summary>
        [JsonPropertyName("openingRangeReady")]
        public bool OpeningRangeReady { get; set; }

        /// <summary>Current state of the signal engine state machine.</summary>
        [JsonPropertyName("signalState")]
        public string SignalState { get; set; } = "WaitingForBias";

        /// <summary>Human-readable status message shown in the signal panel.</summary>
        [JsonPropertyName("statusMessage")]
        public string StatusMessage { get; set; } = "Initialising…";

        /// <summary>Human-readable next-condition message shown below the status.</summary>
        [JsonPropertyName("nextCondition")]
        public string NextCondition { get; set; } = string.Empty;

        /// <summary>Description of the most-recent engine event (sweep detected, etc.).</summary>
        [JsonPropertyName("lastEvent")]
        public string LastEvent { get; set; } = string.Empty;

        /// <summary>IST time of the last engine event.</summary>
        [JsonPropertyName("lastEventTime")]
        public string LastEventTime { get; set; } = string.Empty;

        /// <summary>Number of signals generated today.</summary>
        [JsonPropertyName("signalsToday")]
        public int SignalsToday { get; set; }

        /// <summary>Maximum signals allowed per day (from config).</summary>
        [JsonPropertyName("maxSignalsPerDay")]
        public int MaxSignalsPerDay { get; set; }

        /// <summary>The active BUY or SELL signal; null if none yet.</summary>
        [JsonPropertyName("activeSignal")]
        public TradingSignal? ActiveSignal { get; set; }

        /// <summary>All signals generated today (chronological order).</summary>
        [JsonPropertyName("allSignalsToday")]
        public List<TradingSignal> AllSignalsToday { get; set; } = new();

        /// <summary>
        /// Chart markers for the current session — sweep, confirmation, buy, sell.
        /// Each element: { time (unix s), position, color, shape, text }.
        /// </summary>
        [JsonPropertyName("markers")]
        public List<ChartMarker> Markers { get; set; } = new();

        // ── Paper trading ──────────────────────────────────────────────────────

        /// <summary>
        /// The option symbol to paper-trade based on the active signal.
        /// BUY → short PUT 2 strikes OTM (ATM-100 PE).
        /// SELL → short CALL 2 strikes OTM (ATM+100 CE).
        /// Null when no active signal exists.
        /// </summary>
        [JsonPropertyName("optionSymbol")]
        public string? OptionSymbol { get; set; }

        /// <summary>The currently open paper trade, or null.</summary>
        [JsonPropertyName("activePaperTrade")]
        public PaperTrade? ActivePaperTrade { get; set; }
    }

    /// <summary>A single annotation marker on the TradingView Lightweight Chart.</summary>
    public class ChartMarker
    {
        /// <summary>Unix timestamp in seconds (display-adjusted, same as candle time).</summary>
        [JsonPropertyName("time")]
        public long Time { get; set; }

        /// <summary>"aboveBar" or "belowBar".</summary>
        [JsonPropertyName("position")]
        public string Position { get; set; } = "aboveBar";

        /// <summary>Hex color.</summary>
        [JsonPropertyName("color")]
        public string Color { get; set; } = "#ffffff";

        /// <summary>"arrowUp", "arrowDown", or "circle".</summary>
        [JsonPropertyName("shape")]
        public string Shape { get; set; } = "circle";

        /// <summary>Short label shown on the chart.</summary>
        [JsonPropertyName("text")]
        public string Text { get; set; } = string.Empty;
    }
}
