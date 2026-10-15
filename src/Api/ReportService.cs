using System.Text.Json.Nodes;

namespace Api;

/// <summary>Shapes Warcraft Logs data into compact, fight-relative payloads for the timeline UI.</summary>
public class ReportService(WclClient wcl)
{
    const int MaxPages = 60;

    public async Task<object> GetReportAsync(string code)
    {
        var d = await wcl.QueryAsync("""
            query($code:String!){reportData{report(code:$code){
              title startTime endTime owner{name} zone{name}
              fights{id name encounterID startTime endTime kill difficulty bossPercentage fightPercentage}
            }}}
            """, new { code });
        var r = d["reportData"]!["report"]!;
        var fights = r["fights"]!.AsArray().Select(f => new
        {
            id = f!["id"]!.GetValue<int>(),
            name = f["name"]!.GetValue<string>(),
            encounterId = f["encounterID"]?.GetValue<int>() ?? 0,
            duration = f["endTime"]!.GetValue<double>() - f["startTime"]!.GetValue<double>(),
            kill = f["kill"]?.GetValue<bool>(),
            difficulty = f["difficulty"]?.GetValue<int>(),
            bossPercentage = f["bossPercentage"]?.GetValue<double>(),
        });
        return new { code, title = r["title"]?.GetValue<string>(), zone = r["zone"]?["name"]?.GetValue<string>(), fights };
    }

    record FightInfo(double Start, double End, int EncounterId);

    async Task<FightInfo> GetFightInfoAsync(string code, int fightId)
    {
        var d = await wcl.QueryAsync("""
            query($code:String!,$f:[Int]){reportData{report(code:$code){fights(fightIDs:$f){id encounterID startTime endTime}}}}
            """, new { code, f = new[] { fightId } });
        var f = d["reportData"]!["report"]!["fights"]!.AsArray().FirstOrDefault()
                ?? throw new WclException($"Fight {fightId} not found.", 404);
        return new FightInfo(f["startTime"]!.GetValue<double>(), f["endTime"]!.GetValue<double>(), f["encounterID"]?.GetValue<int>() ?? 0);
    }

    public async Task<object> GetFightAsync(string code, int fightId)
    {
        var d = await wcl.QueryAsync("""
            query($code:String!,$f:[Int]){reportData{report(code:$code){
              phases{encounterID phases{id name isIntermission}}
              fights(fightIDs:$f){
                id name encounterID startTime endTime kill difficulty bossPercentage
                phaseTransitions{id startTime}
                friendlyPlayers enemyPlayers
                friendlyNPCs{id instanceCount} friendlyPets{id instanceCount} enemyNPCs{id instanceCount}
              }
              masterData{actors{id name type subType petOwner gameID}}
            }}}
            """, new { code, f = new[] { fightId } });
        var r = d["reportData"]!["report"]!;
        var f = r["fights"]!.AsArray().FirstOrDefault() ?? throw new WclException($"Fight {fightId} not found.", 404);
        var start = f["startTime"]!.GetValue<double>();
        var end = f["endTime"]!.GetValue<double>();
        var encId = f["encounterID"]?.GetValue<int>() ?? 0;

        // Phase names live on the report, phase transitions on the fight.
        var names = new Dictionary<int, (string name, bool inter)>();
        foreach (var p in r["phases"]?.AsArray() ?? [])
            if (p!["encounterID"]!.GetValue<int>() == encId)
                foreach (var ph in p["phases"]!.AsArray())
                    names[ph!["id"]!.GetValue<int>()] = (ph["name"]!.GetValue<string>(), ph["isIntermission"]?.GetValue<bool>() ?? false);
        var trans = f["phaseTransitions"]?.AsArray().Select(t => (id: t!["id"]!.GetValue<int>(), at: t["startTime"]!.GetValue<double>())).ToList() ?? [];
        var phases = trans.Select((t, i) => new
        {
            id = t.id,
            name = names.TryGetValue(t.id, out var n) ? n.name : $"Phase {t.id}",
            isIntermission = names.TryGetValue(t.id, out n) && n.inter,
            start = t.at - start,
            end = (i + 1 < trans.Count ? trans[i + 1].at : end) - start,
        }).ToList();

        var friendlyIds = new HashSet<int>();
        var enemyIds = new HashSet<int>();
        var instances = new Dictionary<int, int>(); // one actor id can stand for several NPC instances ("Soulcoiler 1", "2", ...)
        void Collect(string k, HashSet<int> into)
        {
            foreach (var x in f[k]?.AsArray() ?? [])
            {
                var id = x is JsonObject o ? o["id"]!.GetValue<int>() : x!.GetValue<int>();
                into.Add(id);
                if (x is JsonObject o2 && o2["instanceCount"] != null) instances[id] = o2["instanceCount"]!.GetValue<int>();
            }
        }
        foreach (var k in new[] { "friendlyPlayers", "friendlyNPCs", "friendlyPets" }) Collect(k, friendlyIds);
        foreach (var k in new[] { "enemyPlayers", "enemyNPCs" }) Collect(k, enemyIds);

        object Map(JsonNode a, bool enemy) => new
        {
            id = a["id"]!.GetValue<int>(),
            name = a["name"]!.GetValue<string>(),
            type = a["type"]!.GetValue<string>(),
            subType = a["subType"]?.GetValue<string>(),
            gameId = a["gameID"]?.GetValue<int>(),
            petOwner = a["petOwner"]?.GetValue<int>(),
            instances = instances.GetValueOrDefault(a["id"]!.GetValue<int>(), 1),
            enemy,
        };
        var actors = r["masterData"]!["actors"]!.AsArray();
        var friendlies = actors.Where(a => friendlyIds.Contains(a!["id"]!.GetValue<int>())).Select(a => Map(a!, false));
        var enemies = actors.Where(a => enemyIds.Contains(a!["id"]!.GetValue<int>())).Select(a => Map(a!, true));

        return new
        {
            id = fightId,
            name = f["name"]!.GetValue<string>(),
            encounterId = encId,
            duration = end - start,
            kill = f["kill"]?.GetValue<bool>(),
            phases,
            actors = friendlies.Concat(enemies),
            names = actors.Where(x => x!["id"] != null).GroupBy(x => x!["id"]!.GetValue<int>()).ToDictionary(g => g.Key, g => g.First()!["name"]?.GetValue<string>()),
        };
    }

    async Task<Dictionary<int, JsonNode>> GetAbilitiesAsync(string code)
    {
        var d = await wcl.QueryAsync("""
            query($code:String!){reportData{report(code:$code){masterData{abilities{gameID name icon type}}}}}
            """, new { code });
        var map = new Dictionary<int, JsonNode>();
        foreach (var a in d["reportData"]!["report"]!["masterData"]!["abilities"]!.AsArray())
            map[a!["gameID"]!.GetValue<int>()] = a;
        return map;
    }

    /// <summary>Pages through the events endpoint of one fight; yields raw event objects.</summary>
    async Task<List<JsonNode>> FetchRawAsync(string code, FightInfo fi, string dataType, int? source, int? target,
        string? ability, string? hostility, string? filter = null)
    {
        double? singleAbility = null;
        string? expr = filter;
        if (!string.IsNullOrWhiteSpace(ability))
        {
            var ids = ability.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(double.Parse).ToArray();
            if (ids.Length == 1) singleAbility = ids[0];
            else if (ids.Length > 1)
            {
                var e = $"ability.id in ({string.Join(",", ids.Select(i => (long)i))})";
                expr = expr == null ? e : $"({expr}) and {e}";
            }
        }

        var all = new List<JsonNode>();
        double cur = fi.Start;
        for (var page = 0; page < MaxPages; page++)
        {
            var d = await wcl.QueryAsync("""
                query($code:String!,$s:Float!,$e:Float!,$dt:EventDataType,$src:Int,$tgt:Int,$ab:Float,$host:HostilityType,$flt:String,$res:Boolean){
                  reportData{report(code:$code){
                    events(startTime:$s,endTime:$e,dataType:$dt,sourceID:$src,targetID:$tgt,abilityID:$ab,hostilityType:$host,filterExpression:$flt,includeResources:$res,limit:10000){
                      data nextPageTimestamp
                    }}}}
                """, new { code, s = cur, e = fi.End, dt = dataType, src = source, tgt = target, ab = singleAbility, host = hostility ?? "Friendlies", flt = expr, res = dataType is "Casts" or "DamageTaken" or "Healing" });
            var ev = d["reportData"]!["report"]!["events"]!;
            foreach (var x in ev["data"]!.AsArray()) if (x != null) all.Add(x);
            var next = ev["nextPageTimestamp"];
            if (next == null) break;
            cur = next.GetValue<double>();
        }
        return all;
    }

    /// <summary>hostilityType in the WCL events API refers to the *source* side, so unit-centric queries fetch both.</summary>
    async Task<List<JsonNode>> FetchBothAsync(string code, FightInfo fi, string dataType, int? source, int? target, string? ability)
    {
        var r = await Task.WhenAll(new[] { "Friendlies", "Enemies" }.Select(h => FetchRawAsync(code, fi, dataType, source, target, ability, h)));
        return r.SelectMany(x => x).ToList();
    }

    static int? Int(JsonNode? n) { var v = n?.GetValue<int>(); return v is null or < 0 ? null : v; }
    /// <summary>NPC instance number; events omit it for instance 1.</summary>
    static int Inst(JsonNode? n) => Int(n) ?? 1;

    public async Task<object> GetEventsAsync(string code, int fightId, string dataType, int? source, int? target,
        string? ability, string? hostility, string? types)
    {
        var fi = await GetFightInfoAsync(code, fightId);
        var raw = hostility == "Both"
            ? await FetchBothAsync(code, fi, dataType, source, target, ability)
            : await FetchRawAsync(code, fi, dataType, source, target, ability, hostility);
        if (dataType == "Casts" && types == null) return await PairCastsAsync(code, fi, raw);
        var typeSet = types?.Split(',', StringSplitOptions.RemoveEmptyEntries).ToHashSet();

        var used = new HashSet<int>();
        var list = new List<object>(raw.Count);
        foreach (var e in raw)
        {
            var type = e["type"]?.GetValue<string>() ?? "";
            if (typeSet != null && !typeSet.Contains(type)) continue;
            var a = Int(e["abilityGameID"]);
            if (a == 0) a = null;
            if (a != null) used.Add(a.Value);
            var cr = e["classResources"]?.AsArray().FirstOrDefault();
            list.Add(new
            {
                t = Math.Round(e["timestamp"]!.GetValue<double>() - fi.Start),
                type,
                src = Int(e["sourceID"]),
                tgt = Int(e["targetID"]),
                si = Inst(e["sourceInstance"]),
                ti = Inst(e["targetInstance"]),
                a,
                res = cr == null ? null : new[] { cr["amount"]?.GetValue<double>() ?? 0, cr["max"]?.GetValue<double>() ?? 0, cr["type"]?.GetValue<double>() ?? 0 },
            });
        }
        return new { events = list, abilities = await AbilitySubset(code, used) };
    }

    record Pending(double T, int? A, int? Tgt, int Ti);

    /// <summary>
    /// Merges begincast/cast pairs into one entry starting at begincast (t) and ending at completion (end).
    /// A begincast with no matching cast was interrupted or cancelled; like WCL we only keep its start (end = null,
    /// intr = true). When an Interrupt event hit that very caster instance, the entry ends there (end = interrupt time) and
    /// carries who interrupted it and with what.
    /// </summary>
    async Task<object> PairCastsAsync(string code, FightInfo fi, List<JsonNode> raw)
    {
        var interrupts = (await FetchBothAsync(code, fi, "Interrupts", null, null, null))
            .Where(e => e["type"]?.GetValue<string>() == "interrupt")
            .Select(e => (t: e["timestamp"]!.GetValue<double>() - fi.Start, tgt: Int(e["targetID"]), ti: Inst(e["targetInstance"]),
                          extra: Int(e["extraAbilityGameID"]), by: Int(e["sourceID"]), bi: Inst(e["sourceInstance"]), ia: Int(e["abilityGameID"])))
            .ToList();

        var used = new HashSet<int>();
        var list = new List<(double t, object item)>();
        var pending = new Dictionary<(int src, int si), Pending>();

        static double[]? Res(JsonNode e)
        {
            var cr = e["classResources"]?.AsArray().FirstOrDefault();
            return cr == null ? null : [cr["amount"]?.GetValue<double>() ?? 0, cr["max"]?.GetValue<double>() ?? 0, cr["type"]?.GetValue<double>() ?? 0];
        }
        void Emit(double t, int? src, int si, int? tgt, int ti, int? a, double[]? res, double? end, bool intr, int? by, int bi, int? ia)
        {
            if (a == 0) a = null;
            if (a != null) used.Add(a.Value);
            if (ia != null) used.Add(ia.Value);
            list.Add((t, new { t, type = "cast", src, si, tgt, ti, a, res, end, intr, by, bi, ia }));
        }
        var consumed = new HashSet<int>(); // an Interrupt event explains at most one cast
        int FindInterrupt(int? src, int si, Pending p, double upTo)
        {
            for (var i = 0; i < interrupts.Count; i++)
            {
                var x = interrupts[i];
                if (consumed.Contains(i) || x.tgt != src || x.ti != si || x.t < p.T || x.t > p.T + 10000 || x.t > upTo) continue;
                if (x.extra == p.A) return i;
            }
            return -1;
        }
        void EmitInterrupted(Pending p, int? src, int si, int idx)
        {
            var found = idx >= 0;
            if (found) consumed.Add(idx);
            var hit = found ? interrupts[idx] : default;
            Emit(p.T, src, si, p.Tgt, p.Ti, p.A, null, found ? Math.Round(hit.t) : null, true, found ? hit.by : null, found ? hit.bi : 1, found ? hit.ia : null);
        }
        void Flush((int src, int si) key, double nextT)
        {
            var p = pending[key]; pending.Remove(key);
            int? src = key.src < 0 ? null : key.src;
            // Only events before the caster began its next cast can belong to this one.
            EmitInterrupted(p, src, key.si, FindInterrupt(src, key.si, p, nextT + 50));
        }

        foreach (var e in raw.OrderBy(x => x["timestamp"]!.GetValue<double>()))
        {
            var type = e["type"]?.GetValue<string>();
            if (type is not ("begincast" or "cast")) continue;
            var t = Math.Round(e["timestamp"]!.GetValue<double>() - fi.Start);
            var src = Int(e["sourceID"]); var si = Inst(e["sourceInstance"]);
            var key = (src ?? -1, si);
            var a = Int(e["abilityGameID"]);
            var tgt = Int(e["targetID"]); var ti = Inst(e["targetInstance"]);
            if (type == "begincast")
            {
                if (pending.ContainsKey(key)) Flush(key, t);
                pending[key] = new Pending(t, a, tgt, ti);
            }
            else if (pending.TryGetValue(key, out var p) && p.A == a)
            {
                pending.Remove(key);
                Emit(p.T, src, si, tgt, ti, a, Res(e), t, false, null, 1, null);
            }
            else Emit(t, src, si, tgt, ti, a, Res(e), null, false, null, 1, null);
        }
        foreach (var key in pending.Keys.ToList()) Flush(key, double.MaxValue);

        return new { events = list.OrderBy(x => x.t).Select(x => x.item).ToList(), abilities = await AbilitySubset(code, used) };
    }

    async Task<Dictionary<int, object>> AbilitySubset(string code, HashSet<int> used)
    {
        var all = await GetAbilitiesAsync(code);
        var res = new Dictionary<int, object>();
        foreach (var id in used)
            if (all.TryGetValue(id, out var a))
                res[id] = new { name = a["name"]?.GetValue<string>(), icon = a["icon"]?.GetValue<string>() };
        return res;
    }

    public async Task<object> GetAurasAsync(string code, int fightId, string type, int? target, string? ability, string? hostility)
    {
        if (type is not ("Buffs" or "Debuffs")) throw new WclException("type must be Buffs or Debuffs", 400);
        var fi = await GetFightInfoAsync(code, fightId);
        // Like DamageTaken, the Buffs/Debuffs views swap roles: sourceID filters the aura holder.
        var raw = await FetchBothAsync(code, fi, type, target, null, ability);
        var dur = fi.End - fi.Start;

        var open = new Dictionary<(int tgt, int ti, int ab), (double start, int stacks)>();
        var spans = new List<object>();
        var used = new HashSet<int>();
        void Close((int tgt, int ti, int ab) k, double end)
        {
            if (!open.Remove(k, out var o)) return;
            spans.Add(new { tgt = k.tgt, ti = k.ti, a = k.ab, s = o.start, e = end });
        }
        foreach (var e in raw.OrderBy(x => x["timestamp"]!.GetValue<double>()))
        {
            var ty = e["type"]!.GetValue<string>();
            var t = e["timestamp"]!.GetValue<double>() - fi.Start;
            var tg = Int(e["targetID"]); var ab = Int(e["abilityGameID"]);
            if (tg == null || ab == null) continue;
            var k = (tg.Value, Inst(e["targetInstance"]), ab.Value);
            if (ty is "applybuff" or "applydebuff") { used.Add(ab.Value); if (!open.ContainsKey(k)) open[k] = (t, 1); }
            else if (ty is "removebuff" or "removedebuff")
            {
                if (!open.ContainsKey(k)) open[k] = (0, 1); // applied before the fight window
                used.Add(ab.Value);
                Close(k, t);
            }
        }
        foreach (var k in open.Keys.ToList()) Close(k, dur);
        return new { spans, abilities = await AbilitySubset(code, used) };
    }

    public async Task<object> GetHealthAsync(string code, int fightId, string targets, string? hostility)
    {
        var fi = await GetFightInfoAsync(code, fightId);
        var ids = targets.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(int.Parse).Take(12).ToList();
        var friendly = (hostility ?? "Enemies") == "Friendlies";

        var tasks = ids.Select(async id =>
        {
            var byInst = new Dictionary<int, SortedDictionary<long, (double pct, double hp, double max)>>();
            var dts = friendly ? new[] { "DamageTaken", "Healing" } : new[] { "DamageTaken" };
            foreach (var dt in dts)
            {
                // In the DamageTaken view WCL swaps the roles: sourceID filters the victim.
                var raw = dt == "DamageTaken" ? await FetchBothAsync(code, fi, dt, id, null, null)
                                              : await FetchBothAsync(code, fi, dt, null, id, null);
                foreach (var e in raw)
                {
                    var hp = e["hitPoints"]?.GetValue<double>(); var max = e["maxHitPoints"]?.GetValue<double>();
                    if (hp == null || max is null or <= 0) continue;
                    // Healing events list the healed target as targetID too; skip events not about this unit.
                    if (Int(e["targetID"]) != id) continue;
                    var sec = (long)Math.Round((e["timestamp"]!.GetValue<double>() - fi.Start) / 1000.0);
                    var inst = Inst(e["targetInstance"]);
                    if (!byInst.TryGetValue(inst, out var points)) byInst[inst] = points = new();
                    points[sec] = (Math.Clamp(Math.Round(hp.Value / max.Value * 100, 1), 0, 100), Math.Max(0, hp.Value), max.Value);
                }
            }
            return byInst.OrderBy(k => k.Key).Select(k => new
            {
                id, inst = k.Key,
                points = k.Value.Select(p => new[] { p.Key * 1000.0, p.Value.pct, p.Value.hp, p.Value.max }),
            });
        });
        return new { series = (await Task.WhenAll(tasks)).SelectMany(x => x).Take(24) };
    }
}
