using System.Text.Json.Nodes;
using Api;

var builder = WebApplication.CreateBuilder(args);
builder.Services.Configure<WclOptions>(builder.Configuration.GetSection("Wcl"));
builder.Services.AddMemoryCache(o => o.SizeLimit = 400_000_000);
builder.Services.AddHttpClient<WclClient>();
builder.Services.AddSingleton<ReportService>();

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

app.Use(async (ctx, next) =>
{
    RequestStats.Begin();
    ctx.Response.OnStarting(() =>
    {
        // when the oldest WCL data behind this response was fetched (unix ms) – the UI shows its age
        if (RequestStats.Oldest is { } at) ctx.Response.Headers["X-Data-Fetched"] = new DateTimeOffset(at).ToUnixTimeMilliseconds().ToString();
        return Task.CompletedTask;
    });
    try { await next(); }
    catch (WclException e) { ctx.Response.StatusCode = e.Status; await ctx.Response.WriteAsJsonAsync(new { error = e.Message }); }
    catch (InvalidOperationException e) { ctx.Response.StatusCode = 500; await ctx.Response.WriteAsJsonAsync(new { error = e.Message }); }
});

var api = app.MapGroup("/api");

// Forget everything cached for a report (the UI then reloads it from WCL).
api.MapPost("/report/{code}/refresh", (string code, WclClient w) => Results.Json(new { refreshed = w.InvalidateReport(code) }));

// List fights of a report.
api.MapGet("/report/{code}", (string code, ReportService s) => s.GetReportAsync(code));

// Everything the UI needs to configure a timeline for one fight: phases, actors present in the fight.
api.MapGet("/report/{code}/fight/{fightId:int}", (string code, int fightId, ReportService s) => s.GetFightAsync(code, fightId));

// Generic normalized event list: ?dataType=Casts&source=1&target=2&ability=123,456&hostility=Friendlies&types=cast
api.MapGet("/report/{code}/fight/{fightId:int}/events",
    (string code, int fightId, string dataType, int? source, int? target, string? ability, string? hostility, string? types, ReportService s) =>
        s.GetEventsAsync(code, fightId, dataType, source, target, ability, hostility, types));

// Buff/debuff uptime spans: ?type=Buffs|Debuffs&target=1&ability=123
api.MapGet("/report/{code}/fight/{fightId:int}/auras",
    (string code, int fightId, string type, int? target, string? ability, string? hostility, ReportService s) =>
        s.GetAurasAsync(code, fightId, type, target, ability, hostility));

// Damage / healing received by one unit: ?target=1
api.MapGet("/report/{code}/fight/{fightId:int}/taken",
    (string code, int fightId, int target, ReportService s) => s.GetTakenAsync(code, fightId, target));

// Health % series (1s resolution) for one or more units: ?targets=1,2,3&hostility=Enemies
api.MapGet("/report/{code}/fight/{fightId:int}/health",
    (string code, int fightId, string targets, string? hostility, ReportService s) =>
        s.GetHealthAsync(code, fightId, targets, hostility));

app.MapFallbackToFile("index.html");
app.Run();
