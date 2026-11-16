/**
 * Home Assistant without the network: the shape of the data the source
 * hands to the widgets, how a state reads ("Open", "Abierta", "21.5 °C"),
 * how much it asks for the user (its level) and the short history of the
 * numeric sensors. Everything here is pure, so it is tested without a
 * Home Assistant.
 */
import { matchFilter, filterPatterns, type Filter, type Localized } from '@kiosko/sdk';

/** One entity, reduced to what the widgets paint. */
export interface Entity {
  /** `binary_sensor.front_door`. */
  id: string;
  /** `binary_sensor`. */
  domain: string;
  /** The friendly name, or the id when there is none. */
  name: string;
  /** Raw state, as Home Assistant says it: `on`, `21.5`, `not_home`, `unavailable`. */
  state: string;
  unit?: string;
  deviceClass?: string;
  stateClass?: string;
  /** When the state last changed (attributes changing don't count), epoch ms. */
  changedAt: number;
  /** Climate: room temperature. */
  current?: number;
  /** Climate: target temperature. */
  target?: number;
  /** Climate: what it is doing (`heating`, `idle`…). */
  action?: string;
  /** A battery level some devices report as an attribute, in %. */
  battery?: number;
}

/**
 * What the source emits.
 *
 * - `unconfigured`: no address or no token yet.
 * - `connecting`: the first connection is on its way; `entities` is empty.
 * - `ok`: connected and up to date.
 * - `offline`: the connection dropped; `entities` are the last ones known, `since` when it dropped.
 * - `error`: Home Assistant answered but refused (a wrong token), or never answered; `error` says why.
 */
export interface HaData {
  state: 'unconfigured' | 'connecting' | 'ok' | 'offline' | 'error';
  error?: string;
  since?: number;
  /** Home Assistant's version, once connected. */
  version?: string;
  entities: Record<string, Entity>;
  /** Numeric history. A class instance, so Kiosko compares it by identity and not by content. */
  history?: History;
}

/** A state as the WebSocket and REST APIs send it. */
export interface RawState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export function compact(s: RawState): Entity {
  const a = s.attributes ?? {};
  const changed = Date.parse(s.last_changed ?? s.last_updated ?? '');
  const e: Entity = {
    id: s.entity_id,
    domain: s.entity_id.split('.')[0] ?? '',
    name: str(a.friendly_name) ?? s.entity_id,
    state: String(s.state),
    changedAt: Number.isFinite(changed) ? changed : 0,
  };
  const unit = str(a.unit_of_measurement);
  if (unit) e.unit = unit;
  const dc = str(a.device_class);
  if (dc) e.deviceClass = dc;
  const sc = str(a.state_class);
  if (sc) e.stateClass = sc;
  const current = num(a.current_temperature);
  if (current !== undefined) e.current = current;
  const target = num(a.temperature);
  if (target !== undefined && e.domain === 'climate') e.target = target;
  const action = str(a.hvac_action);
  if (action) e.action = action;
  const battery = num(a.battery_level) ?? num(a.battery);
  if (battery !== undefined) e.battery = battery;
  return e;
}

/** `http://ha.local:8123` → `ws://ha.local:8123/api/websocket`. An address without a scheme is taken as http. */
export function websocketUrl(address: string): string {
  let a = address.trim().replace(/\/+$/, '');
  if (!/^[a-z]+:\/\//i.test(a)) a = `http://${a}`;
  a = a.replace(/^http(s?):\/\//i, (_, s: string) => `ws${s}://`);
  return a.endsWith('/api/websocket') ? a : `${a}/api/websocket`;
}

/* ---------- reading a state ---------- */

/** A number, when the state is one (sensors, input_number…). */
export function numericState(e: Pick<Entity, 'state'>): number | undefined {
  if (!/^\s*-?\d+(\.\d+)?(e[-+]?\d+)?\s*$/i.test(e.state)) return undefined;
  const n = Number(e.state);
  return Number.isFinite(n) ? n : undefined;
}

/** Decimals as Home Assistant's own cards would show them: fewer as the number grows. `decimals` ≥ 0 forces them. */
export function formatNumber(n: number, locale: string, decimals = -1): string {
  const a = Math.abs(n);
  const max = decimals >= 0 ? decimals : a >= 100 ? 0 : a >= 10 ? 1 : 2;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: max, minimumFractionDigits: decimals >= 0 ? decimals : 0 }).format(n);
}

/** `21.5 °C`, `1 534 W`, `68 %` (no space before %, as Home Assistant writes it). */
export function withUnit(text: string, unit: string | undefined): string {
  if (!unit) return text;
  return unit === '%' ? `${text} %` : `${text} ${unit}`;
}

type L = Localized;
const on_off = (on: L, off: L) => ({ on, off });

/** Binary sensors say `on`/`off`; what that means depends on what they sense. */
const BINARY: Record<string, { on: L; off: L }> = {
  battery: on_off({ en: 'Low', es: 'Baja' }, { en: 'Normal', es: 'Normal' }),
  battery_charging: on_off({ en: 'Charging', es: 'Cargando' }, { en: 'Not charging', es: 'Sin cargar' }),
  carbon_monoxide: on_off({ en: 'CO detected', es: 'CO detectado' }, { en: 'Clear', es: 'Normal' }),
  cold: on_off({ en: 'Cold', es: 'Frío' }, { en: 'Normal', es: 'Normal' }),
  connectivity: on_off({ en: 'Connected', es: 'Conectado' }, { en: 'Disconnected', es: 'Desconectado' }),
  door: on_off({ en: 'Open', es: 'Abierta' }, { en: 'Closed', es: 'Cerrada' }),
  garage_door: on_off({ en: 'Open', es: 'Abierta' }, { en: 'Closed', es: 'Cerrada' }),
  gas: on_off({ en: 'Gas detected', es: 'Gas detectado' }, { en: 'Clear', es: 'Normal' }),
  heat: on_off({ en: 'Hot', es: 'Calor' }, { en: 'Normal', es: 'Normal' }),
  light: on_off({ en: 'Light', es: 'Luz' }, { en: 'Dark', es: 'Oscuro' }),
  lock: on_off({ en: 'Unlocked', es: 'Sin cerrojo' }, { en: 'Locked', es: 'Con cerrojo' }),
  moisture: on_off({ en: 'Wet', es: 'Agua' }, { en: 'Dry', es: 'Seco' }),
  motion: on_off({ en: 'Motion', es: 'Movimiento' }, { en: 'Clear', es: 'Sin movimiento' }),
  moving: on_off({ en: 'Moving', es: 'Moviéndose' }, { en: 'Still', es: 'Quieto' }),
  occupancy: on_off({ en: 'Occupied', es: 'Ocupado' }, { en: 'Clear', es: 'Libre' }),
  opening: on_off({ en: 'Open', es: 'Abierto' }, { en: 'Closed', es: 'Cerrado' }),
  plug: on_off({ en: 'Plugged in', es: 'Enchufado' }, { en: 'Unplugged', es: 'Desenchufado' }),
  power: on_off({ en: 'Power', es: 'Con corriente' }, { en: 'No power', es: 'Sin corriente' }),
  presence: on_off({ en: 'Home', es: 'En casa' }, { en: 'Away', es: 'Fuera' }),
  problem: on_off({ en: 'Problem', es: 'Problema' }, { en: 'OK', es: 'Correcto' }),
  running: on_off({ en: 'Running', es: 'En marcha' }, { en: 'Not running', es: 'Parado' }),
  safety: on_off({ en: 'Unsafe', es: 'Peligro' }, { en: 'Safe', es: 'Seguro' }),
  smoke: on_off({ en: 'Smoke', es: 'Humo' }, { en: 'Clear', es: 'Normal' }),
  sound: on_off({ en: 'Sound', es: 'Sonido' }, { en: 'Quiet', es: 'Silencio' }),
  tamper: on_off({ en: 'Tampered', es: 'Manipulado' }, { en: 'Clear', es: 'Normal' }),
  update: on_off({ en: 'Update available', es: 'Actualización disponible' }, { en: 'Up to date', es: 'Al día' }),
  vibration: on_off({ en: 'Vibration', es: 'Vibración' }, { en: 'Still', es: 'Quieto' }),
  window: on_off({ en: 'Open', es: 'Abierta' }, { en: 'Closed', es: 'Cerrada' }),
};

/** Words of other domains, by state. */
const WORDS: Record<string, L> = {
  on: { en: 'On', es: 'Encendido' },
  off: { en: 'Off', es: 'Apagado' },
  open: { en: 'Open', es: 'Abierto' },
  opening: { en: 'Opening', es: 'Abriendo' },
  closed: { en: 'Closed', es: 'Cerrado' },
  closing: { en: 'Closing', es: 'Cerrando' },
  locked: { en: 'Locked', es: 'Cerrada' },
  unlocked: { en: 'Unlocked', es: 'Abierta' },
  locking: { en: 'Locking', es: 'Cerrando' },
  unlocking: { en: 'Unlocking', es: 'Abriendo' },
  jammed: { en: 'Jammed', es: 'Atascada' },
  home: { en: 'Home', es: 'En casa' },
  not_home: { en: 'Away', es: 'Fuera' },
  playing: { en: 'Playing', es: 'Reproduciendo' },
  paused: { en: 'Paused', es: 'En pausa' },
  idle: { en: 'Idle', es: 'Inactivo' },
  standby: { en: 'Standby', es: 'En espera' },
  buffering: { en: 'Buffering', es: 'Cargando' },
  heat: { en: 'Heat', es: 'Calor' },
  cool: { en: 'Cool', es: 'Frío' },
  heat_cool: { en: 'Heat/cool', es: 'Calor/frío' },
  auto: { en: 'Auto', es: 'Automático' },
  dry: { en: 'Dry', es: 'Deshumidificar' },
  fan_only: { en: 'Fan only', es: 'Solo ventilador' },
  heating: { en: 'heating', es: 'calentando' },
  cooling: { en: 'cooling', es: 'enfriando' },
  drying: { en: 'drying', es: 'secando' },
  fan: { en: 'fan', es: 'ventilando' },
  preheating: { en: 'preheating', es: 'precalentando' },
  disarmed: { en: 'Disarmed', es: 'Desarmada' },
  armed_home: { en: 'Armed home', es: 'Armada en casa' },
  armed_away: { en: 'Armed away', es: 'Armada' },
  armed_night: { en: 'Armed night', es: 'Armada noche' },
  armed_vacation: { en: 'Armed vacation', es: 'Armada vacaciones' },
  armed_custom_bypass: { en: 'Armed', es: 'Armada' },
  arming: { en: 'Arming', es: 'Armando' },
  disarming: { en: 'Disarming', es: 'Desarmando' },
  pending: { en: 'Pending', es: 'Pendiente' },
  triggered: { en: 'Triggered', es: 'Disparada' },
  cleaning: { en: 'Cleaning', es: 'Limpiando' },
  docked: { en: 'Docked', es: 'En la base' },
  returning: { en: 'Returning', es: 'Volviendo' },
  error: { en: 'Error', es: 'Error' },
  above_horizon: { en: 'Up', es: 'Sobre el horizonte' },
  below_horizon: { en: 'Down', es: 'Bajo el horizonte' },
  unavailable: { en: 'Unavailable', es: 'No disponible' },
  unknown: { en: 'Unknown', es: 'Desconocido' },
  sunny: { en: 'Sunny', es: 'Soleado' },
  'clear-night': { en: 'Clear', es: 'Despejado' },
  partlycloudy: { en: 'Partly cloudy', es: 'Parcialmente nublado' },
  cloudy: { en: 'Cloudy', es: 'Nublado' },
  rainy: { en: 'Rain', es: 'Lluvia' },
  pouring: { en: 'Heavy rain', es: 'Lluvia fuerte' },
  snowy: { en: 'Snow', es: 'Nieve' },
  fog: { en: 'Fog', es: 'Niebla' },
  windy: { en: 'Windy', es: 'Viento' },
  lightning: { en: 'Storm', es: 'Tormenta' },
  'lightning-rainy': { en: 'Storm', es: 'Tormenta' },
};

const DOOR_LIKE = new Set(['door', 'garage_door', 'window', 'opening']);
const COVER_DOOR_LIKE = new Set(['door', 'garage', 'gate', 'window']);
const DANGER = new Set(['smoke', 'gas', 'carbon_monoxide', 'moisture', 'safety']);
const TROUBLE = new Set(['problem', 'tamper', 'battery', 'cold', 'heat']);
/** Domains of things that are devices: their being unavailable means something broke. */
export const DEVICE_DOMAINS = new Set(['sensor', 'binary_sensor', 'light', 'switch', 'lock', 'cover', 'climate', 'fan', 'media_player', 'vacuum', 'camera', 'alarm_control_panel', 'water_heater', 'humidifier', 'valve', 'siren', 'device_tracker']);

export interface TextCtx {
  t: (text: Localized) => string;
  locale: string;
  fmt: { time: (at: number) => string; ago: (at: number, o?: { suffix?: boolean }) => string };
  now: number;
}

/** The state as a person would say it: `Open`, `Abierta`, `21,5 °C`, `heating · 21 °C`. */
export function stateText(e: Entity, ctx: TextCtx, decimals = -1): string {
  const { t } = ctx;
  if (e.state === 'unavailable' || e.state === 'unknown') return t(WORDS[e.state]!);
  if (e.deviceClass === 'timestamp') {
    const at = Date.parse(e.state);
    if (Number.isFinite(at)) return at <= ctx.now ? ctx.fmt.ago(at) : ctx.fmt.time(at);
  }
  const n = numericState(e);
  if (n !== undefined && e.domain !== 'binary_sensor') return withUnit(formatNumber(n, ctx.locale, decimals), e.unit);
  if (e.domain === 'binary_sensor') {
    const words = BINARY[e.deviceClass ?? ''] ?? on_off(WORDS.on!, WORDS.off!);
    if (e.state === 'on' || e.state === 'off') return t(words[e.state]);
  }
  if (e.domain === 'climate' && e.current !== undefined) {
    const temp = withUnit(formatNumber(e.current, ctx.locale, decimals), e.unit ?? '°');
    return e.action && e.action !== 'idle' && e.action !== 'off' ? `${temp} · ${t(WORDS[e.action] ?? { en: e.action })}` : temp;
  }
  if (e.domain === 'update') return t(e.state === 'on' ? BINARY.update!.on : BINARY.update!.off);
  if ((e.domain === 'person' || e.domain === 'device_tracker') && !WORDS[e.state]) return e.state; // a zone's name
  const w = WORDS[e.state];
  if (w) return t(w);
  const plain = e.state.replace(/_/g, ' ');
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

/* ---------- how much a state asks for the user ---------- */

/**
 * - `alert`: act now (smoke, a leak, the alarm going off, a jammed lock).
 * - `warn`: worth a look (a door left open, a low battery, a problem).
 * - `on`: active, nothing wrong (a light on, someone home, motion).
 * - `off`: at rest. Also every plain number: thresholds are the widget's.
 * - `na`: unavailable or unknown.
 */
export type Level = 'alert' | 'warn' | 'on' | 'off' | 'na';

export interface LevelOptions {
  /** Battery % at or under which a battery warns. */
  batteryWarn: number;
  /** Battery % at or under which it alerts. */
  batteryAlert: number;
}

export const DEFAULT_LEVELS: LevelOptions = { batteryWarn: 20, batteryAlert: 10 };

export function levelOf(e: Entity, o: LevelOptions = DEFAULT_LEVELS): Level {
  const s = e.state;
  if (s === 'unavailable' || s === 'unknown') return 'na';
  const dc = e.deviceClass ?? '';
  switch (e.domain) {
    case 'binary_sensor':
      if (dc === 'connectivity') return s === 'off' ? 'warn' : 'off';
      if (s !== 'on') return 'off';
      if (DANGER.has(dc)) return 'alert';
      if (TROUBLE.has(dc) || DOOR_LIKE.has(dc) || dc === 'lock') return 'warn';
      return 'on';
    case 'lock':
      return s === 'jammed' ? 'alert' : s === 'unlocked' || s === 'open' || s === 'opening' ? 'warn' : s === 'locked' ? 'off' : 'on';
    case 'cover':
      if (s === 'closed') return 'off';
      return COVER_DOOR_LIKE.has(dc) ? 'warn' : 'on';
    case 'alarm_control_panel':
      return s === 'triggered' ? 'alert' : s === 'pending' || s === 'arming' ? 'warn' : s === 'disarmed' ? 'off' : 'on';
    case 'siren':
      return s === 'on' ? 'alert' : 'off';
    case 'vacuum':
      return s === 'error' ? 'warn' : s === 'cleaning' || s === 'returning' ? 'on' : 'off';
    case 'climate':
      return s === 'off' ? 'off' : 'on';
    case 'person':
    case 'device_tracker':
      return s === 'home' ? 'on' : 'off';
    case 'media_player':
      return s === 'playing' || s === 'on' || s === 'buffering' ? 'on' : 'off';
    case 'update':
      return s === 'on' ? 'on' : 'off';
    case 'sensor': {
      if (dc !== 'battery') return 'off';
      const n = numericState(e);
      if (n === undefined) return 'off';
      return n <= o.batteryAlert ? 'alert' : n <= o.batteryWarn ? 'warn' : 'off';
    }
    default:
      return s === 'on' || s === 'open' || s === 'active' ? 'on' : 'off';
  }
}

/** Colours of the theme a level paints with. */
export function levelColor(level: Level, colors: { alert: string; warn: string; accent: string; inkDim: string; inkFaint: string }): string {
  return level === 'alert' ? colors.alert : level === 'warn' ? colors.warn : level === 'on' ? colors.accent : level === 'na' ? colors.inkFaint : colors.inkDim;
}

/* ---------- picking entities ---------- */

/** An entity passes a filter by its id or its name: `sensor.*_temperature`, `*kitchen*`, `!light.porch`. */
export const matchEntity = (e: Entity, filter: Filter | undefined) => matchFilter([e.id, e.name], filter);

/**
 * The entities of `filter`, in the order of its patterns (what the first
 * pattern matches, then the second…), each group by name. An empty filter
 * gives every entity, by name.
 */
export function pick(entities: Record<string, Entity>, filter: Filter | undefined): Entity[] {
  const all = Object.values(entities).filter((e) => matchEntity(e, filter));
  const includes = filterPatterns(filter).filter((p) => !p.startsWith('!'));
  const byName = (a: Entity, b: Entity) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  if (!includes.length) return all.sort(byName);
  const rank = (e: Entity) => {
    const i = includes.findIndex((p) => matchEntity(e, [p]));
    return i < 0 ? includes.length : i;
  };
  return all.sort((a, b) => rank(a) - rank(b) || byName(a, b));
}

/* ---------- what needs the user ---------- */

export interface AttentionOptions extends LevelOptions {
  entities: Filter;
  includeOpenings: boolean;
  includeBatteries: boolean;
  includeProblems: boolean;
  includeUnavailable: boolean;
  includeUpdates: boolean;
  /** An opening counts only after this long open (0 = at once). */
  openMs: number;
}

export interface Notice {
  entity: Entity;
  level: Level;
  /** What is wrong, in a word or two: `Open`, `Battery 8 %`, `Smoke`. */
  what: L;
  kind: 'danger' | 'opening' | 'battery' | 'problem' | 'unavailable' | 'update';
}

const isOpening = (e: Entity) =>
  (e.domain === 'binary_sensor' && (DOOR_LIKE.has(e.deviceClass ?? '') || e.deviceClass === 'lock')) ||
  (e.domain === 'cover' && COVER_DOOR_LIKE.has(e.deviceClass ?? '')) ||
  e.domain === 'lock';

/** One entity's notice, or null when it doesn't need the user (under these options). */
export function noticeOf(e: Entity, o: AttentionOptions, now: number): Notice | null {
  const level = levelOf(e, o);
  const words = (): L => {
    if (e.domain === 'binary_sensor') return (BINARY[e.deviceClass ?? ''] ?? on_off(WORDS.on!, WORDS.off!))[e.state === 'on' ? 'on' : 'off'];
    return WORDS[e.state] ?? { en: e.state };
  };
  if (level === 'na') {
    if (!o.includeUnavailable || e.state !== 'unavailable' || !DEVICE_DOMAINS.has(e.domain)) return null;
    return { entity: e, level, what: WORDS.unavailable!, kind: 'unavailable' };
  }
  if (level === 'alert' && !(e.domain === 'sensor' && e.deviceClass === 'battery')) return { entity: e, level, what: words(), kind: 'danger' };
  if (e.domain === 'sensor' && e.deviceClass === 'battery') {
    if (!o.includeBatteries || (level !== 'warn' && level !== 'alert')) return null;
    const pct = `${Math.round(numericState(e)!)} %`;
    return { entity: e, level, what: { en: `Battery ${pct}`, es: `Batería ${pct}` }, kind: 'battery' };
  }
  if (e.domain === 'binary_sensor' && e.deviceClass === 'battery') {
    return o.includeBatteries && e.state === 'on' ? { entity: e, level: 'warn', what: { en: 'Battery low', es: 'Batería baja' }, kind: 'battery' } : null;
  }
  if (e.domain === 'update') return o.includeUpdates && e.state === 'on' ? { entity: e, level: 'on', what: BINARY.update!.on, kind: 'update' } : null;
  if (level !== 'warn') return null;
  if (isOpening(e)) {
    if (!o.includeOpenings || now - e.changedAt < o.openMs) return null;
    return { entity: e, level, what: words(), kind: 'opening' };
  }
  return o.includeProblems ? { entity: e, level, what: words(), kind: 'problem' } : null;
}

const LEVEL_RANK: Record<Level, number> = { alert: 0, warn: 1, na: 2, on: 3, off: 4 };

/** Everything that needs the user: red first (dangers before batteries), then amber; each by how long it has been so (oldest first). */
export function notices(entities: Record<string, Entity>, o: AttentionOptions, now: number): Notice[] {
  const out: Notice[] = [];
  for (const e of Object.values(entities)) {
    if (!matchEntity(e, o.entities)) continue;
    const n = noticeOf(e, o, now);
    if (n) out.push(n);
  }
  const danger = (n: Notice) => (n.kind === 'danger' ? 0 : 1);
  return out.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || danger(a) - danger(b) || a.entity.changedAt - b.entity.changedAt || a.entity.name.localeCompare(b.entity.name));
}

/* ---------- history ---------- */

export const HISTORY_SPAN_MS = 24 * 3_600_000;
export const HISTORY_BUCKET_MS = 5 * 60_000;

/**
 * The last day of the numeric sensors the source follows, in five-minute
 * buckets (their mean). Sensors only report when they change, so a value
 * holds until the next one: the series carries it forward.
 */
export class History {
  readonly spanMs: number;
  readonly bucketMs: number;
  /** Per entity, buckets in time order: [bucket index, sum, count, last value]. */
  private readonly series = new Map<string, [number, number, number, number][]>();

  constructor(spanMs = HISTORY_SPAN_MS, bucketMs = HISTORY_BUCKET_MS) {
    this.spanMs = spanMs;
    this.bucketMs = bucketMs;
  }

  has(id: string): boolean {
    return this.series.has(id);
  }

  get size(): number {
    return this.series.size;
  }

  /** Starts following `id` (with no samples yet). */
  track(id: string): void {
    if (!this.series.has(id)) this.series.set(id, []);
  }

  forget(id: string): void {
    this.series.delete(id);
  }

  /** Adds a sample. Older than the span, or older than the newest bucket of the series: ignored. */
  add(id: string, at: number, value: number, now = at): void {
    if (!Number.isFinite(value)) return;
    const s = this.series.get(id);
    if (!s) return;
    const b = Math.floor(at / this.bucketMs);
    const last = s.at(-1);
    if (last && b < last[0]) return;
    if (last && b === last[0]) {
      last[1] += value;
      last[2] += 1;
      last[3] = value;
    } else s.push([b, value, 1, value]);
    const oldest = Math.floor((now - this.spanMs) / this.bucketMs);
    // Keep one bucket before the window: the value that held when it started.
    let cut = 0;
    while (cut + 1 < s.length && s[cut + 1]![0] <= oldest) cut++;
    if (cut) s.splice(0, cut);
  }

  /** Replaces a series with samples from the history API (oldest first). */
  fill(id: string, samples: { at: number; value: number }[], now: number): void {
    this.series.set(id, []);
    for (const x of samples) this.add(id, x.at, x.value, now);
  }

  /**
   * `bars` values covering the last `spanMs` up to `now`, each the mean of
   * its stretch: a bucket with samples is their mean, one without holds the
   * last value before it. The bucket still
   * open (the one of `now`) counts as its latest value, so the last bar is
   * what the sensor says now. `NaN` before the first sample.
   */
  values(id: string, now: number, spanMs: number, bars: number): number[] {
    const s = this.series.get(id) ?? [];
    const span = Math.min(spanMs, this.spanMs);
    const out: number[] = [];
    if (bars < 1) return out;
    const end = Math.floor(now / this.bucketMs);
    const start = end - Math.max(1, Math.round(span / this.bucketMs)) + 1;
    const n = end - start + 1;
    const per: number[] = new Array(n).fill(Number.NaN);
    let i = 0;
    let held = Number.NaN;
    for (let b = start; b <= end; b++) {
      let own: [number, number, number, number] | undefined;
      while (i < s.length && s[i]![0] <= b) {
        if (s[i]![0] === b) own = s[i];
        held = s[i]![3];
        i++;
      }
      // A closed bucket with samples is their mean; after it, the sensor holds its last value.
      per[b - start] = own && b !== end ? own[1] / own[2] : held;
    }
    for (let k = 0; k < bars; k++) {
      const from = Math.floor((k * n) / bars);
      const to = Math.max(from + 1, Math.floor(((k + 1) * n) / bars));
      const chunk = per.slice(from, to).filter((v) => Number.isFinite(v));
      out.push(chunk.length ? chunk.reduce((a, v) => a + v, 0) / chunk.length : Number.NaN);
    }
    return out;
  }
}

/** Parses one series of `history/history_during_period` (minimal, compressed: `s` state, `lu`/`lc` seconds). */
export function parseHistory(rows: unknown): { at: number; value: number }[] {
  if (!Array.isArray(rows)) return [];
  const out: { at: number; value: number }[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const s = r?.s ?? r?.state;
    const t = num(r?.lu) ?? num(r?.lc);
    const at = t !== undefined ? t * 1000 : Date.parse(String(r?.last_changed ?? r?.last_updated ?? ''));
    const value = numericState({ state: String(s) });
    if (value !== undefined && Number.isFinite(at)) out.push({ at, value });
  }
  return out;
}

/** Whether the source keeps a history of this entity: numbers that measure something. */
export const wantsHistory = (e: Entity) => numericState(e) !== undefined && (e.stateClass === 'measurement' || e.stateClass === 'total' || (!!e.unit && e.domain === 'sensor'));

/* ---------- demo ---------- */

/** A small flat, for the gallery and the editor before Home Assistant is set up. */
export function demoHome(now: number, locale = 'en'): HaData {
  const es = locale.startsWith('es');
  const n = (en: string, sp: string) => (es ? sp : en);
  const ago = (ms: number) => now - ms;
  const min = 60_000;
  const raw: (Partial<Entity> & { id: string; state: string })[] = [
    { id: 'sensor.living_room_temperature', name: n('Living room temperature', 'Temperatura salón'), state: '21.4', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', changedAt: ago(4 * min) },
    { id: 'sensor.living_room_humidity', name: n('Living room humidity', 'Humedad salón'), state: '48', unit: '%', deviceClass: 'humidity', stateClass: 'measurement', changedAt: ago(9 * min) },
    { id: 'sensor.bedroom_temperature', name: n('Bedroom temperature', 'Temperatura dormitorio'), state: '19.8', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', changedAt: ago(2 * min) },
    { id: 'sensor.outdoor_temperature', name: n('Outdoor temperature', 'Temperatura exterior'), state: '11.2', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', changedAt: ago(6 * min) },
    { id: 'sensor.house_power', name: n('House power', 'Consumo de la casa'), state: '1534', unit: 'W', deviceClass: 'power', stateClass: 'measurement', changedAt: ago(0.2 * min) },
    { id: 'sensor.solar_power', name: n('Solar production', 'Producción solar'), state: '2210', unit: 'W', deviceClass: 'power', stateClass: 'measurement', changedAt: ago(0.4 * min) },
    { id: 'sensor.energy_today', name: n('Energy today', 'Energía hoy'), state: '7.84', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', changedAt: ago(1 * min) },
    { id: 'sensor.hallway_motion_battery', name: n('Hallway sensor battery', 'Batería sensor pasillo'), state: '8', unit: '%', deviceClass: 'battery', stateClass: 'measurement', changedAt: ago(30 * 3_600_000) },
    { id: 'sensor.front_door_lock_battery', name: n('Front door lock battery', 'Batería cerradura'), state: '64', unit: '%', deviceClass: 'battery', stateClass: 'measurement', changedAt: ago(3 * 3_600_000) },
    { id: 'binary_sensor.balcony_door', name: n('Balcony door', 'Puerta del balcón'), state: 'on', deviceClass: 'door', changedAt: ago(42 * min) },
    { id: 'binary_sensor.front_door', name: n('Front door', 'Puerta de entrada'), state: 'off', deviceClass: 'door', changedAt: ago(95 * min) },
    { id: 'binary_sensor.kitchen_window', name: n('Kitchen window', 'Ventana cocina'), state: 'off', deviceClass: 'window', changedAt: ago(5 * 3_600_000) },
    { id: 'binary_sensor.hallway_motion', name: n('Hallway motion', 'Movimiento pasillo'), state: 'on', deviceClass: 'motion', changedAt: ago(1 * min) },
    { id: 'binary_sensor.washing_machine_leak', name: n('Washing machine leak', 'Fuga lavadora'), state: 'off', deviceClass: 'moisture', changedAt: ago(26 * 3_600_000) },
    { id: 'lock.front_door', name: n('Front door lock', 'Cerradura entrada'), state: 'locked', changedAt: ago(95 * min) },
    { id: 'light.living_room', name: n('Living room lights', 'Luces salón'), state: 'on', changedAt: ago(37 * min) },
    { id: 'light.kitchen', name: n('Kitchen lights', 'Luces cocina'), state: 'off', changedAt: ago(70 * min) },
    { id: 'switch.coffee_machine', name: n('Coffee machine', 'Cafetera'), state: 'off', changedAt: ago(2 * 3_600_000) },
    { id: 'climate.living_room', name: n('Thermostat', 'Termostato'), state: 'heat', current: 21.4, target: 22, action: 'heating', unit: '°C', changedAt: ago(3 * 3_600_000) },
    { id: 'person.alex', name: 'Alex', state: 'home', changedAt: ago(4 * 3_600_000) },
    { id: 'person.sam', name: 'Sam', state: n('Work', 'Trabajo'), changedAt: ago(6 * 3_600_000) },
    { id: 'media_player.living_room_tv', name: n('Living room TV', 'Tele del salón'), state: 'playing', changedAt: ago(25 * min) },
    { id: 'sensor.garage_temperature', name: n('Garage temperature', 'Temperatura garaje'), state: 'unavailable', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', changedAt: ago(14 * 3_600_000) },
    { id: 'update.home_assistant_core_update', name: 'Home Assistant Core', state: 'on', changedAt: ago(20 * 3_600_000) },
  ];
  const entities: Record<string, Entity> = {};
  for (const r of raw) entities[r.id] = { domain: r.id.split('.')[0]!, name: r.id, changedAt: now, ...r } as Entity;

  // A believable day: a cosine around the mean, warmest mid-afternoon, plus a little noise.
  const history = new History();
  const hours = (at: number) => new Date(at).getHours() + new Date(at).getMinutes() / 60;
  const wave = (at: number, peak: number) => Math.cos(((hours(at) - peak) / 24) * Math.PI * 2);
  const series: Record<string, (at: number, i: number) => number> = {
    'sensor.living_room_temperature': (at) => 20.6 + 0.9 * wave(at, 18),
    'sensor.living_room_humidity': (at) => 50 - 4 * wave(at, 15),
    'sensor.bedroom_temperature': (at) => 19.4 + 0.6 * wave(at, 19),
    'sensor.outdoor_temperature': (at) => 9 + 5 * wave(at, 15),
    'sensor.house_power': (at, i) => 380 + (hours(at) > 7 && hours(at) < 9 ? 1400 : 0) + (hours(at) > 20 && hours(at) < 23 ? 900 : 0) + ((i * 37) % 11) * 25,
    'sensor.solar_power': (at) => Math.max(0, 3200 * Math.cos(((hours(at) - 14) / 12) * Math.PI)),
  };
  for (const [id, f] of Object.entries(series)) {
    history.track(id);
    let last = 0;
    for (let i = 0, at = now - HISTORY_SPAN_MS; at <= now; at += HISTORY_BUCKET_MS, i++) history.add(id, at, (last = f(at, i)), now);
    // The state is where the series ends.
    const e = entities[id]!;
    e.state = String(Math.round(last * (e.unit === 'W' ? 1 : 10)) / (e.unit === 'W' ? 1 : 10));
  }
  return { state: 'ok', version: '2026.11.1', entities, history };
}
