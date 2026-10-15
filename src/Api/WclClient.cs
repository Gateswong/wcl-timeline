using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Caching.Memory;

namespace Api;

public class WclOptions
{
    public string ClientId { get; set; } = "";
    public string ClientSecret { get; set; } = "";
}

/// <summary>Thin Warcraft Logs v2 GraphQL client with client-credentials token caching.</summary>
public class WclClient(HttpClient http, IMemoryCache cache, Microsoft.Extensions.Options.IOptions<WclOptions> opts)
{
    const string TokenUrl = "https://www.warcraftlogs.com/oauth/token";
    const string ApiUrl = "https://www.warcraftlogs.com/api/v2/client";
    static readonly SemaphoreSlim TokenLock = new(1, 1);

    async Task<string> GetTokenAsync()
    {
        if (cache.TryGetValue("wcl-token", out string? t) && t != null) return t;
        await TokenLock.WaitAsync();
        try
        {
            if (cache.TryGetValue("wcl-token", out t) && t != null) return t;
            var o = opts.Value;
            if (string.IsNullOrEmpty(o.ClientId) || string.IsNullOrEmpty(o.ClientSecret))
                throw new InvalidOperationException("Wcl:ClientId / Wcl:ClientSecret are not configured.");
            var req = new HttpRequestMessage(HttpMethod.Post, TokenUrl)
            {
                Content = new FormUrlEncodedContent([new("grant_type", "client_credentials")])
            };
            req.Headers.Authorization = new AuthenticationHeaderValue("Basic",
                Convert.ToBase64String(Encoding.UTF8.GetBytes($"{o.ClientId}:{o.ClientSecret}")));
            var res = await http.SendAsync(req);
            var body = await res.Content.ReadAsStringAsync();
            if (!res.IsSuccessStatusCode) throw new InvalidOperationException($"WCL token request failed: {(int)res.StatusCode} {body}");
            var json = JsonNode.Parse(body)!;
            t = json["access_token"]!.GetValue<string>();
            var ttl = json["expires_in"]?.GetValue<int>() ?? 3600;
            cache.Set("wcl-token", t, new MemoryCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(Math.Max(60, ttl - 120)),
                Size = 1
            });
            return t;
        }
        finally { TokenLock.Release(); }
    }

    /// <summary>Runs a GraphQL query and returns the "data" node. Results are cached by query+variables.</summary>
    public async Task<JsonNode> QueryAsync(string query, object? variables = null, TimeSpan? ttl = null)
    {
        var payload = JsonSerializer.Serialize(new { query, variables });
        var key = "q:" + payload;
        if (cache.TryGetValue(key, out JsonNode? hit) && hit != null) return hit.DeepClone();

        var token = await GetTokenAsync();
        var req = new HttpRequestMessage(HttpMethod.Post, ApiUrl)
        {
            Content = new StringContent(payload, Encoding.UTF8, "application/json")
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var res = await http.SendAsync(req);
        var body = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode) throw new WclException($"WCL API {(int)res.StatusCode}: {body}", (int)res.StatusCode);
        var json = JsonNode.Parse(body)!;
        if (json["errors"] is JsonArray errs && errs.Count > 0)
            throw new WclException(errs[0]!["message"]?.GetValue<string>() ?? "GraphQL error", 400);
        var data = json["data"]!;
        cache.Set(key, data.DeepClone(), new MemoryCacheEntryOptions
        {
            AbsoluteExpirationRelativeToNow = ttl ?? TimeSpan.FromHours(6),
            Size = body.Length
        });
        return data;
    }
}

public class WclException(string message, int status) : Exception(message)
{
    public int Status { get; } = status;
}
