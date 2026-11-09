using System.Text.Json.Serialization;

namespace Test.Models.Dto
{
    /// <summary>
    /// Root DTO for the Groww pro-option-chain expiry list response.
    /// Endpoint: GET https://groww.in/v1/pro-option-chain/nifty?responseStructure=LIST
    /// </summary>
    public class GrowwProOptionChainDto
    {
        /// <summary>
        /// List of records returned when responseStructure=LIST is used.
        /// Each record contains, among other things, the expiry date.
        /// </summary>
        [JsonPropertyName("records")]
        public GrowwProOptionChainRecords? Records { get; set; }
    }

    public class GrowwProOptionChainRecords
    {
        /// <summary>
        /// Array of available expiry dates in "DD-MMM-YYYY" format, e.g. "13-Nov-2026".
        /// </summary>
        [JsonPropertyName("expiryDates")]
        public string[]? ExpiryDates { get; set; }
    }
}
