using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Test.Models.Options;
using Test.Services.Interfaces;

namespace Test.Services
{
    /// <summary>
    /// Fetches the nearest weekly Nifty expiry from Groww's pro-option-chain endpoint
    /// once per trading day and caches it in memory for the rest of that day.
    ///
    /// Endpoint : GET https://groww.in/v1/pro-option-chain/nifty?responseStructure=LIST
    ///
    /// The expiry code is used in Groww FnO symbols: NIFTY + Expiry + Strike + CE/PE.
    /// Format: YY + MonthCode + DD (e.g. 2026-Nov-12 → "26N12")
    ///
    /// Month codes:
    ///   Jan=1, Feb=2, Mar=3, Apr=4, May=5, Jun=6, Jul=7, Aug=8, Sep=9, Oct=O, Nov=N, Dec=D
    /// </summary>
    public class GrowwExpiryService : IGrowwExpiryService
    {
        private const string ProOptionChainUrl =
            "https://groww.in/v1/pro-option-chain/nifty?responseStructure=LIST";

        private static readonly TimeSpan IstOffset = TimeSpan.FromHours(5.5);

        private static readonly Dictionary<int, string> MonthCodes = new()
        {
            { 1,  "1" }, { 2,  "2" }, { 3,  "3" },
            { 4,  "4" }, { 5,  "5" }, { 6,  "6" },
            { 7,  "7" }, { 8,  "8" }, { 9,  "9" },
            { 10, "O" }, { 11, "N" }, { 12, "D" }
        };

        private string?   _cachedExpiry;
        private DateOnly? _cachedExpiryDate;
        private DateOnly  _cacheDate;
        private readonly SemaphoreSlim _lock = new(1, 1);

        private readonly IHttpClientFactory          _httpFactory;
        private readonly OptionChainOptions          _opts;
        private readonly ILogger<GrowwExpiryService> _logger;

        public GrowwExpiryService(
            IHttpClientFactory httpFactory,
            IOptions<OptionChainOptions> opts,
            ILogger<GrowwExpiryService> logger)
        {
            _httpFactory = httpFactory;
            _opts        = opts.Value;
            _logger      = logger;
        }

        /// <inheritdoc/>
        public async Task<string> GetCurrentExpiryAsync()
        {
            var todayIst = DateOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(IstOffset).DateTime);

            if (_cachedExpiry != null && _cacheDate == todayIst)
                return _cachedExpiry;

            await _lock.WaitAsync();
            try
            {
                if (_cachedExpiry != null && _cacheDate == todayIst)
                    return _cachedExpiry;

                var (code, date) = await ResolveNearestExpiryAsync(todayIst);
                _cachedExpiry     = code;
                _cachedExpiryDate = date;
                _cacheDate        = todayIst;

                _logger.LogInformation(
                    "GrowwExpiryService: resolved expiry for {Date} → {Code} ({Formatted})",
                    todayIst, code, date.ToString("dd-MMM-yyyy"));

                return code;
            }
            finally
            {
                _lock.Release();
            }
        }

        /// <inheritdoc/>
        public string GetFormattedExpiryDate()
        {
            if (_cachedExpiryDate.HasValue)
                return _cachedExpiryDate.Value.ToString("dd-MMM-yyyy");

            var todayIst = DateOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(IstOffset).DateTime);
            int daysUntilThursday = ((int)DayOfWeek.Thursday - (int)todayIst.DayOfWeek + 7) % 7;
            var thursday = todayIst.AddDays(daysUntilThursday);
            return thursday.ToString("dd-MMM-yyyy");
        }

        private async Task<(string Code, DateOnly Date)> ResolveNearestExpiryAsync(DateOnly todayIst)
        {
            try
            {
                var client   = _httpFactory.CreateClient("GrowwClient");
                var response = await client.GetAsync(ProOptionChainUrl);

                if (response.IsSuccessStatusCode)
                {
                    var rawJson = await response.Content.ReadAsStringAsync();
                    var expiryDates = TryExtractExpiryDates(rawJson);

                    if (expiryDates != null && expiryDates.Length > 0)
                    {
                        var nearest = ParseNearestExpiry(expiryDates, todayIst);
                        if (nearest.HasValue)
                        {
                            return (ToGrowwExpiryCode(nearest.Value), nearest.Value);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "GrowwExpiryService: error fetching from pro-option-chain API, using Thursday calculation");
            }

            // Fallback: calculate nearest upcoming Thursday (NIFTY standard weekly expiry)
            var thursday = GetNearestThursday(todayIst);
            return (ToGrowwExpiryCode(thursday), thursday);
        }

        private string[]? TryExtractExpiryDates(string rawJson)
        {
            if (string.IsNullOrWhiteSpace(rawJson)) return null;

            try
            {
                using var doc = JsonDocument.Parse(rawJson);
                var root = doc.RootElement;

                // 1. root.expiryDates
                if (root.TryGetProperty("expiryDates", out var ed1) && ed1.ValueKind == JsonValueKind.Array)
                    return ReadStringArray(ed1);

                // 2. root.expiries
                if (root.TryGetProperty("expiries", out var ed2) && ed2.ValueKind == JsonValueKind.Array)
                    return ReadStringArray(ed2);

                // 3. root.payload.expiryDates / expiries
                if (root.TryGetProperty("payload", out var payload) && payload.ValueKind == JsonValueKind.Object)
                {
                    if (payload.TryGetProperty("expiryDates", out var ped1) && ped1.ValueKind == JsonValueKind.Array)
                        return ReadStringArray(ped1);
                    if (payload.TryGetProperty("expiries", out var ped2) && ped2.ValueKind == JsonValueKind.Array)
                        return ReadStringArray(ped2);
                    if (payload.TryGetProperty("expiryDetails", out var ped3) && ped3.ValueKind == JsonValueKind.Array)
                        return ExtractDatesFromObjects(ped3);
                }

                // 4. root.records.expiryDates
                if (root.TryGetProperty("records", out var records))
                {
                    if (records.ValueKind == JsonValueKind.Object)
                    {
                        if (records.TryGetProperty("expiryDates", out var red1) && red1.ValueKind == JsonValueKind.Array)
                            return ReadStringArray(red1);
                        if (records.TryGetProperty("expiries", out var red2) && red2.ValueKind == JsonValueKind.Array)
                            return ReadStringArray(red2);
                    }
                    else if (records.ValueKind == JsonValueKind.Array)
                    {
                        return ExtractDatesFromObjects(records);
                    }
                }

                // 5. root.data.expiryDates
                if (root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object)
                {
                    if (data.TryGetProperty("expiryDates", out var ded1) && ded1.ValueKind == JsonValueKind.Array)
                        return ReadStringArray(ded1);
                    if (data.TryGetProperty("expiries", out var ded2) && ded2.ValueKind == JsonValueKind.Array)
                        return ReadStringArray(ded2);
                }

                // 6. Top-level array
                if (root.ValueKind == JsonValueKind.Array)
                {
                    var direct = ReadStringArray(root);
                    if (direct.Length > 0 && TryParseExpiryDate(direct[0], out _))
                        return direct;
                    return ExtractDatesFromObjects(root);
                }

                // 7. Recursive scan of the entire JSON
                return ScanForDateArray(root);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "GrowwExpiryService: error parsing JSON");
                return null;
            }
        }

        private static string[] ReadStringArray(JsonElement arr)
        {
            var list = new List<string>();
            foreach (var el in arr.EnumerateArray())
            {
                if (el.ValueKind == JsonValueKind.String)
                {
                    var s = el.GetString();
                    if (!string.IsNullOrWhiteSpace(s)) list.Add(s);
                }
            }
            return list.ToArray();
        }

        private static string[]? ExtractDatesFromObjects(JsonElement arr)
        {
            var list = new List<string>();
            foreach (var item in arr.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object) continue;
                foreach (var propName in new[] { "expiryDate", "expiry_date", "expiry", "date" })
                {
                    if (item.TryGetProperty(propName, out var v) && v.ValueKind == JsonValueKind.String)
                    {
                        var s = v.GetString();
                        if (!string.IsNullOrWhiteSpace(s)) { list.Add(s); break; }
                    }
                }
            }
            return list.Count > 0 ? list.Distinct().ToArray() : null;
        }

        private string[]? ScanForDateArray(JsonElement el, int depth = 0)
        {
            if (depth > 6) return null;

            if (el.ValueKind == JsonValueKind.Array)
            {
                var candidates = ReadStringArray(el);
                if (candidates.Count(s => TryParseExpiryDate(s, out _)) >= 2)
                    return candidates;
            }

            if (el.ValueKind == JsonValueKind.Object)
            {
                foreach (var prop in el.EnumerateObject())
                {
                    var result = ScanForDateArray(prop.Value, depth + 1);
                    if (result != null) return result;
                }
            }

            return null;
        }

        private DateOnly? ParseNearestExpiry(string[] expiryDates, DateOnly todayIst)
        {
            var parsed = new List<DateOnly>();
            foreach (var raw in expiryDates)
            {
                if (TryParseExpiryDate(raw, out var date))
                    parsed.Add(date);
            }

            if (parsed.Count == 0) return null;

            var upcoming = parsed.Where(d => d >= todayIst).OrderBy(d => d).ToList();
            return upcoming.Count > 0 ? upcoming[0] : parsed.OrderByDescending(d => d).First();
        }

        private static bool TryParseExpiryDate(string raw, out DateOnly result)
        {
            if (string.IsNullOrWhiteSpace(raw))
            {
                result = default;
                return false;
            }

            raw = raw.Trim();

            // dd-MMM-yyyy (e.g. 12-Nov-2026)
            if (DateOnly.TryParseExact(raw, "dd-MMM-yyyy", CultureInfo.InvariantCulture, DateTimeStyles.None, out result))
                return true;

            // yyyy-MM-dd (e.g. 2026-11-12)
            if (DateOnly.TryParseExact(raw, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out result))
                return true;

            // dd-MM-yyyy (e.g. 12-11-2026)
            if (DateOnly.TryParseExact(raw, "dd-MM-yyyy", CultureInfo.InvariantCulture, DateTimeStyles.None, out result))
                return true;

            // ddMMMyyyy (e.g. 12Nov2026)
            if (DateOnly.TryParseExact(raw, "ddMMMyyyy", CultureInfo.InvariantCulture, DateTimeStyles.None, out result))
                return true;

            return DateOnly.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.None, out result);
        }

        private static DateOnly GetNearestThursday(DateOnly todayIst)
        {
            int daysUntilThursday = ((int)DayOfWeek.Thursday - (int)todayIst.DayOfWeek + 7) % 7;
            return todayIst.AddDays(daysUntilThursday);
        }

        /// <summary>
        /// Converts DateOnly to Groww weekly symbol expiry code: YY + MonthCode + DD.
        /// Example: 2026-11-12 → "26N12"
        /// </summary>
        internal static string ToGrowwExpiryCode(DateOnly date)
        {
            var yy    = date.Year % 100;
            var mCode = MonthCodes.TryGetValue(date.Month, out var m) ? m : "N";
            var dd    = date.Day.ToString("D2");
            return $"{yy}{mCode}{dd}";
        }
    }
}
