namespace Test.Services.Interfaces
{
    /// <summary>
    /// Provides the nearest weekly Nifty options expiry code for the current trading day.
    /// The expiry code is fetched once per day from Groww's pro-option-chain endpoint
    /// and cached in memory for the rest of the day.
    /// </summary>
    public interface IGrowwExpiryService
    {
        /// <summary>
        /// Returns the Groww symbol expiry code for the nearest (or current-day) weekly expiry,
        /// e.g. "26N12" for 2026-Nov-12.
        ///
        /// The result is cached for the current IST trading date.
        /// Falls back to nearest upcoming Thursday if the API call fails.
        /// </summary>
        Task<string> GetCurrentExpiryAsync();

        /// <summary>
        /// Returns the human-readable expiry date, e.g. "12-Nov-2026".
        /// </summary>
        string GetFormattedExpiryDate();
    }
}
