export interface FightSummary {
  id: number; name: string; encounterId: number; duration: number; kill?: boolean; difficulty?: number; bossPercentage?: number;
}
export interface ReportSummary { code: string; title?: string; zone?: string; fights: FightSummary[]; }

export interface Phase { id: number; name: string; isIntermission: boolean; start: number; end: number; }
export interface Actor {
  id: number; name: string; type: string; subType?: string; gameId?: number; petOwner?: number; enemy: boolean; instances: number;
  /** players: spec name ("Balance") and WCL icon id ("Druid-Balance") */
  spec?: string | null; icon?: string | null;
}
export interface FightDetail {
  id: number; name: string; encounterId: number; duration: number; kill?: boolean; phases: Phase[]; actors: Actor[]; names: Record<number, string>;
}

export interface AbilityInfo { name?: string; icon?: string; }
export type AbilityMap = Record<number, AbilityInfo>;
export interface LogEvent {
  t: number; type: string; src?: number; tgt?: number; a?: number;
  /** the caster's class resources: [amount, max, type] per resource type */
  res?: [number, number, number][] | null;
  /** casts with a cast time: completion (or interruption) time; `intr` marks interrupted/cancelled casts */
  end?: number | null; intr?: boolean; by?: number | null; ia?: number | null;
  /** NPC instance numbers (1-based) of source / target / interrupter */
  si?: number; ti?: number; bi?: number;
}
export interface EventsResult { events: LogEvent[]; abilities: AbilityMap; }
export interface Span {
  tgt: number; ti?: number; a: number; s: number; e: number;
  /** who applied it (latest apply/refresh) and that unit's instance */
  src?: number | null; si?: number;
}
/** Damage (k=d), heal (k=h) or shield absorb (k=a) received by a unit, with WCL's raw numbers. */
export interface TakenEvent {
  t: number; k: 'd' | 'h' | 'a'; src?: number | null; si?: number; tgt?: number | null; ti?: number; a?: number | null;
  amt: number; raw?: number | null; mit?: number | null; abs?: number | null; over?: number | null;
  hit?: number | null; tick?: boolean;
  /** absorbs: the damage ability that was absorbed and who dealt it */
  xa?: number | null; atk?: number | null;
}
export interface TakenResult { events: TakenEvent[]; abilities: AbilityMap; }
/** Death recap: killing blow, auras at death and the last 5 s of damage/healing taken. */
export interface DeathRecap {
  t: number; killing: TakenEvent | null; events: TakenEvent[]; buffs: Span[]; debuffs: Span[]; abilities: AbilityMap;
}
export interface AurasResult { spans: Span[]; abilities: AbilityMap; }
export interface HealthSeries { id: number; inst?: number; points: [number, number, number, number][]; }

/** Extracts report code and fight id from a warcraftlogs.com URL (or a bare report code). */
export function parseReportUrl(input: string): { code: string; fight?: number | 'last' } | null {
  const s = input.trim();
  const m = s.match(/reports\/([A-Za-z0-9]{16})/) ?? s.match(/^([A-Za-z0-9]{16})$/);
  if (!m) return null;
  const f = s.match(/[?&#]fight=(\d+|last)/);
  return { code: m[1], fight: f ? (f[1] === 'last' ? 'last' : +f[1]) : undefined };
}

/** Called with the fetch time (unix ms) of the oldest WCL data behind each response. */
let onFetched: ((at: number) => void) | null = null;
export const setFetchedListener = (f: ((at: number) => void) | null) => { onFetched = f; };

async function get<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const at = Number(res.headers.get('x-data-fetched'));
  if (at) onFetched?.(at);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.json();
}

const q = (o: Record<string, string | number | undefined>) =>
  Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&');

export const Api = {
  refresh: (code: string) => get<{ refreshed: boolean }>(`api/report/${code}/refresh`, { method: 'POST' }),
  report: (code: string) => get<ReportSummary>(`api/report/${code}`),
  fight: (code: string, fight: number) => get<FightDetail>(`api/report/${code}/fight/${fight}`),
  events: (code: string, fight: number, p: { dataType: string; source?: number; target?: number; ability?: string; hostility?: string; types?: string }) =>
    get<EventsResult>(`api/report/${code}/fight/${fight}/events?${q(p)}`),
  auras: (code: string, fight: number, p: { type: string; target?: number; ability?: string; hostility?: string }) =>
    get<AurasResult>(`api/report/${code}/fight/${fight}/auras?${q(p)}`),
  taken: (code: string, fight: number, target: number, ability?: string) =>
    get<TakenResult>(`api/report/${code}/fight/${fight}/taken?${q({ target, ability })}`),
  done: (code: string, fight: number, source: number, pets: number[], ability?: string) =>
    get<TakenResult>(`api/report/${code}/fight/${fight}/done?${q({ source, pets: pets.join(','), ability })}`),
  death: (code: string, fight: number, target: number, t: number) =>
    get<DeathRecap>(`api/report/${code}/fight/${fight}/death?${q({ target, t })}`),
  health: (code: string, fight: number, targets: number[], hostility: string) =>
    get<{ series: HealthSeries[] }>(`api/report/${code}/fight/${fight}/health?${q({ targets: targets.join(','), hostility })}`),
};

export function iconUrl(icon?: string): string | undefined {
  if (!icon) return undefined;
  return `https://wow.zamimg.com/images/wow/icons/medium/${icon.endsWith('.jpg') ? icon : icon + '.jpg'}`;
}

export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** m:ss.s */
export function fmtTimeP(ms: number): string {
  const neg = ms < 0, s = Math.abs(ms) / 1000;
  return `${neg ? '-' : ''}${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

/** Spec icon (falls back to the class icon) for a player; undefined for NPCs. */
export function specIconUrl(a?: Actor): string | undefined {
  if (!a || a.type !== 'Player') return undefined;
  const id = a.icon || a.subType;
  return id ? `https://assets.rpglogs.com/img/warcraft/icons/${id}.jpg` : undefined;
}
