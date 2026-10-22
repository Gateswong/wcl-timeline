import { Component, computed, signal } from '@angular/core';
import {
  AbilityMap, Actor, Api, AurasResult, FightDetail, FightSummary, HealthSeries, LogEvent, ReportSummary, Span,
  fmtTime, fmtTimeP, iconUrl, parseReportUrl, setFetchedListener, specIconUrl,
} from './api';

type Kind = 'casts' | 'auras' | 'health' | 'power' | 'events';
type Hostility = 'Friendlies' | 'Enemies' | 'Both';

interface ColumnDef {
  id: number; kind: Kind; title: string; ids: number[]; hostility: Hostility;
  ability: string; auraType: 'Buffs' | 'Debuffs'; dataType: string;
  targetKey: string; targetClass?: string;
  /** give every unit / NPC instance of a casts column its own lane */
  stagger: boolean;
  /** auras: also show buffs/debuffs that are up for (nearly) the whole fight; hidden by default */
  showLong: boolean;
  /** power columns: only this resource type (undefined = every type as its own line) */
  resType?: number;
  /** the saved unit does not exist in this fight: the column is kept as configured, but nothing is loaded */
  unresolved?: boolean;
  /** shown in the column header, e.g. when a same-class player stood in for the saved one */
  note?: string;
}
/** Actor-id-free column description: units are referenced by name (`c`, the class, is legacy and ignored). */
export interface SavedCol { k: Kind; t: string; c?: string; a?: string; u?: 'Buffs' | 'Debuffs'; d?: string; s?: 1; l?: 1; r?: number; }

const b64enc = (o: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64dec = <T>(s: string): T => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0))));
};
interface ColState {
  loading: boolean; error?: string;
  events?: LogEvent[]; spans?: Span[]; series?: HealthSeries[]; abilities: AbilityMap;
}
interface TargetOption { key: string; label: string; ids: number[]; enemy: boolean; group: string; cls?: string; icon?: string; }

/** One dot on a vertical timeline with icon, name and "caster → target". */
export interface EvRow {
  y: number; h: number; interrupted: boolean; icon?: string; name: string; route: string; time: string; detail: string;
  src: string; lane: number; color?: string;
}
/** A buff/debuff: start dot, end dot and a connecting line, placed in a lane. */
export interface AuraRow {
  y: number; h: number; lane: number; ly: number; color: string; icon?: string; label: string;
  name: string; target: string; sMs: number; eMs: number;
}
export interface Tip { casts?: EvRow[]; more?: number; aura?: AuraRow; }
export interface Line { color: string; points: string; label: string; }
export interface Mark { x: number; y: number; text: string; color: string; }
export interface Tick { y: number; label: string; minor: boolean; major: boolean; }
interface Ser { color: string; label: string; pts: [number, number, string][]; } // [t ms, fraction 0..1, text]
export interface ColView {
  def: ColumnDef; state: ColState; width: number;
  rows: EvRow[]; auras: AuraRow[]; lanes: number; laneIdx: number[]; laneColors: string[]; lines: Line[]; marks: Mark[];
  hidden: number; // auras left out because they last (nearly) the whole fight
  resTypes: number[]; // power columns: resource types offered in the header
}

const LIST_W = 340;   // casts / events columns
const PLOT_W = 240;   // health / power columns
const AURA_STEP = 14; // one buff/debuff lane (labels may run across the neighbouring lanes)
const LABEL_W = 190;  // room right of the last lane for its label
const PAD = 28;       // empty space above t=0 so labels of things active at the pull stay visible
const MAX_LANES = 12;        // lanes of a multi-unit aura column (greedy packing)
const LONG_AURA = 0.95;       // an aura covering at least this share of the fight counts as "whole fight"
const MAX_LABEL_SHIFT = 45;   // max px an aura label may be pushed down from its dot
const MAX_UNIT_LANES = 40;   // lanes of a single-unit aura column (one lane per ability)
const STAGGER_STEP = 14; // px between instance lanes of a staggered casts column
const MAX_STAGGER = 12;
const MARK_STEPS = [1, 2, 5, 10, 15, 30, 60];
const TICK_STEPS = [1, 2, 5, 10, 30, 60];
/** WoW power types as they appear in classResources[].type */
const RES_LABEL: Record<number, string> = {
  0: '法力', 1: '怒气', 2: '集中值', 3: '能量', 4: '连击点', 5: '符文', 6: '符文能量', 7: '灵魂碎片', 8: '星界能量',
  9: '神圣能量', 11: '漩涡', 12: '真气', 13: '狂乱', 17: '恶魔之怒', 18: '痛苦', 19: '精华',
};
const RES_COLOR: Record<number, string> = {
  0: '#4fc3f7', 1: '#e57373', 2: '#ffb74d', 3: '#fff176', 6: '#4db6ac', 8: '#ba68c8', 9: '#ffe082', 13: '#9575cd', 17: '#a5d6a7',
};
const TYPE_LABEL: Record<string, string> = {
  death: '死亡', summon: '召唤', interrupt: '打断', dispel: '驱散', resurrect: '复活',
};
const PALETTE = ['#4fc3f7', '#ffb74d', '#81c784', '#e57373', '#ba68c8', '#fff176', '#4db6ac', '#f06292', '#a1887f', '#90a4ae'];
const KIND_LABEL: Record<Kind, string> = {
  casts: '施法序列', auras: 'Buff / Debuff', health: '血量 %', power: '能量/资源', events: '其他事件',
};
const EVENT_TYPES: [string, string][] = [
  ['Deaths', '死亡'], ['Summons', '召唤'], ['Interrupts', '打断'], ['Dispels', '驱散'], ['Resurrects', '复活'],
];

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
  host: { '(document:keydown.escape)': 'pickerOpen.set(false)' },
})
export class App {
  protected readonly kindLabel = KIND_LABEL;
  protected readonly kinds = Object.keys(KIND_LABEL) as Kind[];
  protected readonly eventTypes = EVENT_TYPES;
  protected readonly fmtTime = fmtTime;
  protected readonly fmtTimeP = fmtTimeP;
  protected readonly pad = PAD;

  input = signal('');
  report = signal<ReportSummary | null>(null);
  fight = signal<FightDetail | null>(null);
  busy = signal(false);
  error = signal('');

  columns = signal<ColumnDef[]>([]);
  states = signal<Record<number, ColState>>({});
  zoom = signal(20); // px per second
  nextId = 1;

  // "Add column" form
  fKind = signal<Kind>('casts');
  fTarget = signal('');
  fAbility = signal('');
  fAuraType = signal<'Buffs' | 'Debuffs'>('Debuffs');
  fDataType = signal('Deaths');

  private initialCols: SavedCol[] | null = null;
  /** Columns of the previously loaded report, re-applied when a fight of a new report gets selected. */
  private carry: SavedCol[] | null = null;

  /** Age of the data on screen: when the oldest WCL result behind it was fetched (server cache included). */
  private fetchedAt = signal<number | null>(null);
  private now = signal(Date.now());
  ageText = computed(() => {
    const at = this.fetchedAt(); if (at == null) return '';
    const s = Math.max(0, Math.round((this.now() - at) / 1000));
    return s < 10 ? '刚刚' : s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : `${Math.floor(s / 3600)} 小时前`;
  });
  refreshing = signal(false);

  /** Drops the server's cache for this report and reloads the report, the fight and all columns from WCL. */
  async refresh() {
    const rep = this.report(), f = this.fight(); if (!rep || !f) return;
    this.refreshing.set(true); this.error.set('');
    try {
      await Api.refresh(rep.code);
      this.fetchedAt.set(null);
      this.report.set(await Api.report(rep.code));
      await this.selectFight(f.id);
    } catch (e) { this.error.set(String((e as Error).message)); }
    finally { this.refreshing.set(false); }
  }

  constructor() {
    setFetchedListener(at => this.fetchedAt.update(m => (m == null ? at : Math.min(m, at))));
    setInterval(() => this.now.set(Date.now()), 10000);
    const p = new URLSearchParams(location.search);
    const r = p.get('report');
    const c = p.get('c');
    if (c) { try { this.initialCols = b64dec<SavedCol[]>(c); } catch { this.error.set('分享链接中的列配置无法解析'); } }
    if (r) {
      this.input.set(`https://www.warcraftlogs.com/reports/${r}` + (p.get('fight') ? `?fight=${p.get('fight')}` : ''));
      void this.loadReport();
    }
  }

  // ---------- loading ----------

  async loadReport() {
    const parsed = parseReportUrl(this.input());
    if (!parsed) { this.error.set('无法识别 Report 链接'); return; }
    this.busy.set(true); this.error.set('');
    try {
      this.fetchedAt.set(null);
      const rep = await Api.report(parsed.code);
      this.report.set(rep);
      if (this.columns().length) this.carry = this.columns().map(d => this.toSaved(d));
      this.fight.set(null); this.columns.set([]);
      // fight=last means the report's last fight; the dropdown only lists boss fights, so prefer the last of those
      const last = [...rep.fights].reverse().find(f => f.encounterId > 0) ?? rep.fights[rep.fights.length - 1];
      const want = parsed.fight === 'last' ? last?.id : parsed.fight;
      const pick = want && rep.fights.some(f => f.id === want) ? want : undefined;
      if (pick) await this.selectFight(pick);
    } catch (e) { this.error.set(String((e as Error).message)); }
    finally { this.busy.set(false); }
  }

  async selectFight(id: number) {
    const rep = this.report(); if (!rep) return;
    this.fetchedAt.set(null); // the age shown is that of the data of this fight
    this.busy.set(true); this.error.set('');
    try {
      const saved = this.initialCols ?? (this.columns().length ? this.columns().map(d => this.toSaved(d)) : this.carry);
      this.initialCols = null; this.carry = null;
      this.fight.set(await Api.fight(rep.code, id));
      this.columns.set([]); this.states.set({});
      this.fTarget.set(this.targetOptions()[0]?.key ?? '');
      this.syncUrl();
      if (saved?.length) await this.applySaved(saved);
    } catch (e) { this.error.set(String((e as Error).message)); }
    finally { this.busy.set(false); }
  }

  fightLabel(f: FightSummary) {
    const res = f.kill === true ? '击杀' : f.kill === false ? `未击杀${f.bossPercentage != null ? ' ' + f.bossPercentage + '%' : ''}` : '';
    return `#${f.id} ${f.name} · ${fmtTime(f.duration)} ${res}`;
  }
  bossFights = computed(() => this.report()?.fights.filter(f => f.encounterId > 0) ?? []);

  // ---------- target options ----------

  targetOptions = computed<TargetOption[]>(() => {
    const f = this.fight(); if (!f) return [];
    const out: TargetOption[] = [];
    const players = f.actors.filter(a => a.type === 'Player');
    for (const a of players.sort((x, y) => x.name.localeCompare(y.name)))
      out.push({
        key: `p:${a.name}`, label: `${a.name} (${a.spec ? a.spec + ' ' : ''}${a.subType ?? ''})`, ids: [a.id], enemy: false,
        group: '玩家', cls: a.subType, icon: specIconUrl(a),
      });
    for (const enemy of [false, true]) {
      const byName = new Map<string, Actor[]>();
      for (const a of f.actors.filter(x => x.enemy === enemy && x.type !== 'Player'))
        byName.set(a.name, [...(byName.get(a.name) ?? []), a]);
      for (const [name, list] of [...byName].sort((x, y) => x[0].localeCompare(y[0])))
        out.push({
          key: `${enemy ? 'e' : 'f'}:${name}`, enemy, ids: list.map(a => a.id),
          label: list.length > 1 ? `${name} ×${list.length}` : name, group: enemy ? '敌方单位' : '友方 NPC / 宠物',
        });
    }
    out.push({ key: 'allF', label: '所有友方（不过滤）', ids: [], enemy: false, group: '全部' });
    out.push({ key: 'allE', label: '所有敌方（不过滤）', ids: [], enemy: true, group: '全部' });
    out.push({ key: 'allA', label: '所有单位（不过滤）', ids: [], enemy: false, group: '全部' });
    return out;
  });
  // unit picker (custom dropdown so options can show spec icons)
  pickerOpen = signal(false);
  pickerFilter = signal('');
  currentTarget = computed(() => this.targetOptions().find(o => o.key === this.fTarget()));
  filteredGroups = computed(() => {
    const f = this.pickerFilter().trim().toLowerCase();
    return this.targetGroups()
      .map(([g, list]) => [g, f ? list.filter(o => o.label.toLowerCase().includes(f)) : list] as [string, TargetOption[]])
      .filter(([, list]) => list.length);
  });
  togglePicker() {
    this.pickerOpen.update(v => !v);
    this.pickerFilter.set('');
    if (this.pickerOpen()) setTimeout(() => document.querySelector<HTMLInputElement>('.pfilter')?.focus());
  }
  pickTarget(key: string) { this.fTarget.set(key); this.pickerOpen.set(false); }

  targetGroups = computed(() => {
    const g = new Map<string, TargetOption[]>();
    for (const o of this.targetOptions()) g.set(o.group, [...(g.get(o.group) ?? []), o]);
    return [...g];
  });

  private actorMap = computed(() => new Map((this.fight()?.actors ?? []).map(a => [a.id, a])));

  /** Name with WCL-style instance number ("Spiteful Soulcoiler 2") when the actor stands for several NPCs. */
  unitName(id?: number | null, inst?: number | null): string {
    if (id == null) return '';
    const base = this.actorName(id);
    return (this.actorMap().get(id)?.instances ?? 1) > 1 ? `${base} ${inst ?? 1}` : base;
  }

  actorName(id?: number) {
    if (id == null) return '';
    const f = this.fight();
    return f?.actors.find(a => a.id === id)?.name ?? f?.names?.[id] ?? `#${id}`;
  }

  // ---------- columns ----------

  /** Builds a column from the "add column" form, or reports why it cannot. */
  private defFromForm(): ColumnDef | null {
    const opt = this.targetOptions().find(o => o.key === this.fTarget());
    if (!opt) return null;
    const kind = this.fKind();
    if ((kind === 'casts' || kind === 'health' || kind === 'power') && !opt.ids.length) {
      this.error.set('该列类型需要选择具体单位'); return null;
    }
    this.error.set('');
    return this.makeDef(opt, kind, this.fAbility().trim(), this.fAuraType(), this.fDataType());
  }

  async addColumn() {
    const def = this.defFromForm(); if (!def) return;
    this.columns.update(c => [...c, def]);
    this.syncUrl();
    await this.loadColumn(def);
  }

  /** Replaces the column picked in the "replace" selector (default: the last one) or, for "all", every column. */
  fReplace = signal('');
  async replaceColumn() {
    const def = this.defFromForm(); if (!def) return;
    const cols = this.columns();
    const target = this.fReplace() || String(cols[cols.length - 1]?.id ?? '');
    if (target === 'all' || !cols.some(c => String(c.id) === target)) {
      this.columns.set([def]);
    } else {
      const old = cols.find(c => String(c.id) === target)!;
      def.stagger = old.stagger && (def.kind === 'casts' || def.kind === 'events');
      this.columns.set(cols.map(c => (c === old ? def : c)));
    }
    this.fReplace.set(String(def.id));
    this.syncUrl();
    await this.loadColumn(def);
  }

  private makeDef(opt: TargetOption, kind: Kind, ability: string, auraType: 'Buffs' | 'Debuffs', dataType: string): ColumnDef {
    const def: ColumnDef = {
      stagger: false, showLong: false,
      id: this.nextId++, kind, ids: opt.ids.slice(0, 12),
      hostility: opt.key === 'allA' ? 'Both' : opt.enemy ? 'Enemies' : 'Friendlies',
      ability, auraType, dataType, title: '', targetKey: opt.key, targetClass: opt.cls,
    };
    const label = opt.label.replace(/ \(.*\)$/, '');
    def.title = kind === 'auras' ? `${label} · ${def.auraType === 'Buffs' ? 'Buff' : 'Debuff'}`
      : kind === 'events' ? `${label} · ${EVENT_TYPES.find(e => e[0] === def.dataType)?.[1]}`
      : `${label} · ${KIND_LABEL[kind]}`;
    return def;
  }

  // ---------- save / share ----------

  toSaved(d: ColumnDef): SavedCol {
    const o: SavedCol = { k: d.kind, t: d.targetKey };
    if (d.ability) o.a = d.ability;
    if (d.kind === 'auras') o.u = d.auraType;
    if (d.kind === 'events') o.d = d.dataType;
    if (d.stagger) o.s = 1;
    if (d.kind === 'auras' && d.showLong) o.l = 1;
    if (d.kind === 'power' && d.resType != null) o.r = d.resType;
    return o;
  }

  /**
   * Resolves saved columns against the current fight. A column whose unit cannot be found is kept exactly as
   * configured (so it survives further fight switches and share links) and flagged in its header instead of
   * being changed or dropped.
   */
  async applySaved(list: SavedCol[]) {
    const opts = this.targetOptions();
    const defs: ColumnDef[] = [];
    for (const sc of list) {
      const saved = sc.t.replace(/^[pef]:/, '');
      const opt0 = opts.find(o => o.key === sc.t); // exact unit only: never substitute another player
      const unresolved = !opt0;
      const opt = opt0 ?? { key: sc.t, label: saved, ids: [], enemy: sc.t.startsWith('e:'), group: '', cls: sc.c };
      const def = this.makeDef(opt, sc.k, sc.a ?? '', sc.u ?? 'Debuffs', sc.d ?? 'Deaths');
      def.stagger = !!sc.s;
      def.showLong = !!sc.l;
      def.resType = sc.r;
      def.unresolved = unresolved;
      defs.push(def);
    }
    this.columns.set(defs);
    this.syncUrl();
    await Promise.all(defs.filter(d => !d.unresolved).map(d => this.loadColumn(d)));
  }

  /** Mirrors report, fight and columns into the address bar so the page URL is the share link. */
  private syncUrl() {
    const rep = this.report(), f = this.fight(); if (!rep || !f) return;
    const cols = this.columns().map(d => this.toSaved(d));
    history.replaceState(null, '', `?report=${rep.code}&fight=${f.id}` + (cols.length ? `&c=${b64enc(cols)}` : ''));
  }

  /**
   * Lane focus: the lane under the pointer keeps its labels, the other lanes' labels are hidden.
   * Normal columns focus via the lane strips / rows and let go again in the blank area (after a short delay so that
   * crossing the gap between a dot and its label does not flicker). Single-player columns focus the lane nearest to
   * the pointer's x anywhere in the column.
   */
  focus = signal<{ col: number; lane: number } | null>(null);
  private clearTimer: ReturnType<typeof setTimeout> | undefined;
  setFocus(col: number, lane: number) { clearTimeout(this.clearTimer); this.focus.set({ col, lane }); }
  clearSoon(col: number) {
    clearTimeout(this.clearTimer);
    this.clearTimer = setTimeout(() => { if (this.focus()?.col === col) this.focus.set(null); }, 120);
  }
  dimmed(col: number, lane: number, active: boolean): boolean {
    const f = this.focus();
    return active && !!f && f.col === col && f.lane !== lane;
  }
  /** Single player unit: hover focus works anywhere in the column. */
  anywhere(v: ColView): boolean { return v.def.ids.length === 1 && v.def.targetKey.startsWith('p:'); }
  colMove(v: ColView, e: MouseEvent) {
    if (!this.anywhere(v) || v.lanes < 1) return;
    const step = v.def.kind === 'auras' ? AURA_STEP : STAGGER_STEP;
    const x = e.clientX - (e.currentTarget as HTMLElement).getBoundingClientRect().left;
    this.setFocus(v.def.id, Math.max(0, Math.min(v.lanes - 1, Math.floor((x - 2) / step))));
  }

  setResType(id: number, value: string) {
    const type = value === '' ? undefined : Number(value);
    this.columns.update(c => c.map(d => (d.id === id ? { ...d, resType: type } : d)));
    this.syncUrl();
  }
  resLabel(type: number) { return RES_LABEL[type] ?? `资源#${type}`; }

  toggleLong(id: number) {
    this.columns.update(c => c.map(d => (d.id === id ? { ...d, showLong: !d.showLong } : d)));
    this.syncUrl();
  }

  toggleStagger(id: number) {
    this.columns.update(c => c.map(d => (d.id === id ? { ...d, stagger: !d.stagger } : d)));
    this.syncUrl();
  }

  removeColumn(id: number) { this.columns.update(c => c.filter(x => x.id !== id)); this.syncUrl(); }
  moveColumn(id: number, dir: -1 | 1) {
    this.columns.update(c => {
      const i = c.findIndex(x => x.id === id), j = i + dir;
      if (i < 0 || j < 0 || j >= c.length) return c;
      const n = [...c]; [n[i], n[j]] = [n[j], n[i]]; return n;
    });
    this.syncUrl();
  }

  private setState(id: number, s: ColState) { this.states.update(m => ({ ...m, [id]: s })); }

  private async loadColumn(def: ColumnDef) {
    const code = this.report()!.code, fight = this.fight()!.id;
    this.setState(def.id, { loading: true, abilities: {} });
    try {
      const abilities: AbilityMap = {};
      if (def.kind === 'casts' || def.kind === 'power' || def.kind === 'events') {
        const isDeath = def.kind === 'events' && def.dataType === 'Deaths';
        const dataType = def.kind === 'events' ? def.dataType : 'Casts';
        const ids: (number | undefined)[] = def.ids.length ? def.ids : [undefined];
        const results = await Promise.all(ids.map(id => Api.events(code, fight, {
          dataType, hostility: def.hostility,
          source: isDeath ? undefined : id, target: isDeath ? id : undefined,
          ability: def.kind === 'casts' ? def.ability : undefined,
        })));
        const events = results.flatMap(r => r.events).sort((a, b) => a.t - b.t);
        results.forEach(r => Object.assign(abilities, r.abilities));
        this.setState(def.id, { loading: false, events, abilities });
      } else if (def.kind === 'auras') {
        const ids: (number | undefined)[] = def.ids.length ? def.ids : [undefined];
        const results: AurasResult[] = await Promise.all(ids.map(id => Api.auras(code, fight, {
          type: def.auraType, target: id, ability: def.ability, hostility: def.hostility,
        })));
        let spans = results.flatMap(r => r.spans).sort((a, b) => a.s - b.s);
        if (!def.ids.length && def.hostility !== 'Both') {
          // The API returns auras of both sides; keep only holders on the requested side.
          const enemy = def.hostility === 'Enemies';
          const side = new Map(this.fight()!.actors.map(a => [a.id, a.enemy]));
          spans = spans.filter(sp => side.get(sp.tgt) === enemy);
        }
        results.forEach(r => Object.assign(abilities, r.abilities));
        this.setState(def.id, { loading: false, spans, abilities });
      } else {
        const { series } = await Api.health(code, fight, def.ids, def.hostility);
        this.setState(def.id, { loading: false, series, abilities });
      }
    } catch (e) {
      this.setState(def.id, { loading: false, error: String((e as Error).message), abilities: {} });
    }
  }

  // ---------- layout ----------

  px = (ms: number) => (ms / 1000) * this.zoom();
  height = computed(() => this.px(this.fight()?.duration ?? 0) + PAD + 40);

  ticks = computed<Tick[]>(() => {
    const f = this.fight(); if (!f) return [];
    const z = this.zoom();
    const step = TICK_STEPS.find(t => t * z >= 24) ?? 60;
    const half = step === 1 && z >= 40; // half-second minor ticks when zoomed in far enough
    const out: Tick[] = [];
    for (let ms = 0; ms <= f.duration; ms += half ? 500 : step * 1000) {
      const whole = ms % (step * 1000) === 0;
      out.push({ y: this.px(ms), label: whole ? fmtTime(ms) : '', minor: !whole, major: whole && (ms / 1000) % (step * 5) === 0 });
    }
    return out;
  });

  phaseBlocks = computed(() => (this.fight()?.phases ?? []).map(p => ({
    ...p, y: this.px(p.start), h: Math.max(1, this.px(p.end - p.start)),
  })));

  // single global guide line that follows the mouse pointer
  hoverY = signal<number | null>(null);
  hoverMs = computed(() => ((this.hoverY() ?? 0) - PAD) / this.zoom() * 1000);
  hoverLabel = computed(() => (this.hoverY() == null ? '' : fmtTimeP(this.hoverMs())));
  mouse = signal({ x: 0, y: 0 });
  onMove(e: MouseEvent) {
    this.hoverY.set(e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top);
    this.mouse.set({ x: e.clientX, y: e.clientY });
  }

  // hover tooltip for casts (all casts within a few px of each other) and auras
  tip = signal<Tip | null>(null);
  showCast(v: ColView, r: EvRow, single = false) {
    const near = single ? [r] : v.rows.filter(x => Math.abs(x.y - r.y) <= 10);
    this.tip.set({ casts: near.slice(0, 8), more: Math.max(0, near.length - 8) });
  }
  showAura(a: AuraRow) { this.tip.set({ aura: a }); }
  hideTip() { this.tip.set(null); }
  tipPos = computed(() => {
    const m = this.mouse();
    const left = Math.max(4, Math.min(m.x + 14, innerWidth - 340));
    return m.y > innerHeight - 220 ? { left, top: null, bottom: innerHeight - m.y + 12 } : { left, top: m.y + 14, bottom: null };
  });
  auraNow(a: AuraRow): string {
    const t = this.hoverMs();
    if (t < a.sMs || t > a.eMs) return '指针当前不在持续期内';
    return `指针处已持续 ${((t - a.sMs) / 1000).toFixed(1)}s，还剩 ${((a.eMs - t) / 1000).toFixed(1)}s`;
  }
  dur(a: AuraRow) { return ((a.eMs - a.sMs) / 1000).toFixed(1); }

  totalWidth = computed(() => 56 + 84 + this.views().reduce((a, v) => a + v.width, 0));

  views = computed<ColView[]>(() => this.columns().map(def => {
    const state = this.states()[def.id] ?? { loading: !def.unresolved, abilities: {} };
    const base: ColView = { def, state, width: PLOT_W, rows: [], auras: [], lanes: 0, laneIdx: [], laneColors: [], lines: [], marks: [], hidden: 0, resTypes: [] };
    if (state.loading || state.error) return { ...base, width: def.kind === 'casts' || def.kind === 'events' ? LIST_W : PLOT_W };
    switch (def.kind) {
      case 'casts': case 'events': {
        const { rows, lanes } = this.eventRows(def, state);
        const laneIdx = Array.from({ length: lanes }, (_, i) => i);
        return {
          ...base, rows, lanes, laneIdx, laneColors: laneIdx.map(i => PALETTE[i % PALETTE.length]),
          width: LIST_W + (def.stagger ? lanes * STAGGER_STEP : 0),
        };
      }
      case 'auras': {
        const { rows, lanes, hidden } = this.auraRows(def, state);
        return { ...base, width: lanes * AURA_STEP + LABEL_W, auras: rows, lanes, hidden, laneIdx: Array.from({ length: lanes }, (_, i) => i) };
      }
      case 'health': return { ...base, ...this.plot(this.healthSeries(state)) };
      case 'power': {
        const types = new Set((state.events ?? []).flatMap(e => (e.res ?? []).filter(r => r[1] > 0).map(r => r[2])));
        if (def.resType != null) types.add(def.resType); // keep the chosen type selectable even if absent here
        return { ...base, resTypes: [...types].sort((x, y) => x - y), ...this.plot(this.powerSeries(def, state)) };
      }
    }
  }));

  private eventRows(def: ColumnDef, st: ColState): { rows: EvRow[]; lanes: number } {
    const laneOf = new Map<string, number>();
    if (def.stagger) {
      const keys = [...new Set((st.events ?? []).map(e => `${e.src ?? -1}:${e.si ?? 1}`))]
        .sort((x, y) => { const [a, b] = x.split(':').map(Number), [c, d] = y.split(':').map(Number); return a - c || b - d; });
      keys.slice(0, MAX_STAGGER).forEach((k, i) => laneOf.set(k, i));
    }
    const rows = (st.events ?? []).map(e => {
      const ab = e.a != null ? st.abilities[e.a] : undefined;
      const src = this.unitName(e.src, e.si);
      const tgt = this.unitName(e.tgt, e.ti);
      const label = TYPE_LABEL[e.type] ?? e.type;
      const name = e.type === 'death' ? `${tgt} ${label}` : ab?.name ?? (e.a != null ? `#${e.a}` : label);
      // "Caster → Target"; omitted when there is no distinct target
      const route = e.type === 'death' ? '' : tgt && src && (e.tgt !== e.src || e.ti !== e.si) ? `${src} → ${tgt}` : tgt && !src ? `→ ${tgt}` : '';
      let detail = '';
      if (e.intr) {
        const by = e.by != null ? this.unitName(e.by, e.bi) : '';
        const bya = e.ia != null ? st.abilities[e.ia]?.name : '';
        const who = by ? `被打断（${by}${bya ? ' 的 ' + bya : ''}）` : '未完成（被打断或取消）';
        detail = e.end != null ? `读条 ${((e.end - e.t) / 1000).toFixed(1)}s 后${who}，于 ${fmtTimeP(e.end)}` : who;
      } else if (e.end != null) {
        detail = `读条 ${((e.end - e.t) / 1000).toFixed(1)}s，完成于 ${fmtTimeP(e.end)}`;
      }
      const lane = laneOf.get(`${e.src ?? -1}:${e.si ?? 1}`) ?? 0;
      return {
        y: this.px(e.t), h: e.end != null ? Math.max(0, this.px(e.end - e.t)) : 0, interrupted: !!e.intr,
        icon: e.type === 'death' ? specIconUrl(e.tgt != null ? this.actorMap().get(e.tgt) : undefined) : iconUrl(ab?.icon),
        name, route, time: fmtTimeP(e.t), detail, src,
        lane, color: def.stagger ? PALETTE[lane % PALETTE.length] : undefined,
      };
    });
    return { rows, lanes: Math.max(1, laneOf.size) };
  }

  /**
   * Single unit: one lane per ability (a buff keeps its lane across re-applications), lanes ordered by first
   * appearance. Several units: lanes are packed greedily by time. Labels sit at the start dot; labels that would
   * collide are pushed down so that e.g. all the buffs present at the pull form a readable list.
   */
  private auraRows(def: ColumnDef, st: ColState): { rows: AuraRow[]; lanes: number; hidden: number } {
    const single = def.ids.length === 1;
    const laneOf = new Map<string, number>();
    const laneEnd: number[] = [];
    let lastLabelBottom = -Infinity;
    const all = st.spans ?? [];
    const whole = (this.fight()?.duration ?? 0) * LONG_AURA; // "up for the whole fight"
    const spans = def.showLong ? all : all.filter(sp => sp.e - sp.s < whole);
    const rows = spans.map(sp => {
      const y = this.px(sp.s), h = Math.max(0, this.px(sp.e - sp.s));
      let lane: number;
      if (single) {
        const key = `${sp.a}:${sp.ti ?? 1}`;
        lane = laneOf.get(key) ?? Math.min(laneOf.size, MAX_UNIT_LANES - 1);
        laneOf.set(key, lane);
        laneEnd[lane] = y + h;
      } else {
        const busy = Math.max(y + h, y + 18);
        lane = laneEnd.findIndex(end => end <= y);
        if (lane < 0) {
          if (laneEnd.length < MAX_LANES) { lane = laneEnd.length; laneEnd.push(0); }
          else lane = laneEnd.indexOf(Math.min(...laneEnd));
        }
        laneEnd[lane] = busy;
      }
      // Push a colliding label down, but never far from its own dot (otherwise a dense column drifts further and
      // further below the real time): beyond MAX_LABEL_SHIFT labels simply overlap.
      const ly = Math.min(Math.max(y - 9, lastLabelBottom), y - 9 + MAX_LABEL_SHIFT);
      lastLabelBottom = ly + 15;
      const ab = st.abilities[sp.a];
      const name = ab?.name ?? `#${sp.a}`;
      const target = this.unitName(sp.tgt, sp.ti);
      return {
        y, h, lane, ly, color: PALETTE[sp.a % PALETTE.length], icon: iconUrl(ab?.icon),
        label: def.ids.length !== 1 ? `${name} [${target}]` : name, name, target, sMs: sp.s, eMs: sp.e,
      };
    });
    return { rows, lanes: Math.max(1, laneEnd.length), hidden: all.length - spans.length };
  }

  private healthSeries(st: ColState): Ser[] {
    return (st.series ?? []).filter(s => s.points.length).map((s, i) => ({
      color: PALETTE[i % PALETTE.length], label: this.unitName(s.id, s.inst),
      pts: s.points.map(p => [p[0], p[1] / 100, `${p[1]}%`] as [number, number, string]),
    }));
  }

  /** One line per resource type (or only the chosen one). Mana is labelled in %, others in game units. */
  private powerSeries(def: ColumnDef, st: ColState): Ser[] {
    const byType = new Map<number, [number, number, string][]>();
    for (const e of st.events ?? []) {
      for (const [amt, max, type] of e.res ?? []) {
        if (max <= 0 || (def.resType != null && type !== def.resType)) continue;
        // Rage, runic power, astral power, … are stored ×10 (max 1000+ for 100+)
        const text = type === 0 ? `${Math.round((amt / max) * 100)}%` : `${Math.round(max >= 500 ? amt / 10 : amt)}`;
        if (!byType.has(type)) byType.set(type, []);
        byType.get(type)!.push([e.t, amt / max, text]);
      }
    }
    return [...byType].sort((x, y) => x[0] - y[0]).map(([type, pts], i) => ({
      color: RES_COLOR[type] ?? PALETTE[i % PALETTE.length], label: this.resLabel(type), pts,
    }));
  }

  /** Step-after polylines plus value labels every N seconds (N shrinks as the zoom grows). */
  private plot(series: Ser[]): { lines: Line[]; marks: Mark[] } {
    const W = PLOT_W, z = this.zoom();
    const step = (MARK_STEPS.find(s => s * z >= 40) ?? 60) * 1000;
    const lines: Line[] = [], marks: Mark[] = [];
    for (const s of series) {
      lines.push({
        color: s.color, label: s.label,
        points: s.pts.map((p, j, a) => {
          const prev = j > 0 ? `${a[j - 1][1] * W},${this.px(p[0])} ` : '';
          return `${prev}${p[1] * W},${this.px(p[0])}`;
        }).join(' '),
      });
      const last = s.pts[s.pts.length - 1][0];
      let j = 0;
      for (let t = Math.ceil(s.pts[0][0] / step) * step; t <= last; t += step) {
        while (j + 1 < s.pts.length && s.pts[j + 1][0] <= t) j++;
        const p = s.pts[j];
        marks.push({ x: Math.min(p[1] * W + 6, W - 44), y: this.px(t), text: p[2], color: s.color });
      }
    }
    return { lines, marks };
  }
}
