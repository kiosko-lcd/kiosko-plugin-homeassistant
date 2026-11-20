/**
 * Home Assistant without the network: the shape of the data the source
 * hands to the widgets, how a state reads ("Open", "Abierta", "21.5 °C"),
 * how much it asks for the user (its level) and the short history of the
 * numeric sensors. Everything here is pure, so it is tested without a
 * Home Assistant.
 */
import { localize, matchFilter, filterPatterns, type Filter, type Localized } from '@kiosko/sdk';

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
  /**
   * Cameras and image entities: the path of their picture
   * (`/api/camera_proxy/camera.porch?token=…`). Its token opens that picture
   * only and Home Assistant changes it every few minutes, sending the new
   * path as a state change: the long-lived token never leaves the source.
   */
  picture?: string;
  /** Media players: what is playing. */
  media?: Media;
  /** People and device trackers: their photo (`/local/alex.jpg` or a full URL). */
  photo?: string;
}

/** What a media player is playing, as far as it says. */
export interface Media {
  title?: string;
  artist?: string;
  album?: string;
  /** The app or source: Spotify, Netflix, TV. */
  app?: string;
  /** Seconds. */
  duration?: number;
  /** Seconds, as of `positionAt`. */
  position?: number;
  /** When `position` was measured, epoch ms: while playing, it moves on from there. */
  positionAt?: number;
}

/**
 * Today's energy, from Home Assistant's Energy dashboard (its statistics, in
 * kWh), and the power sensors it has for a live flow. Absent when the
 * dashboard isn't set up (or the user can't read it).
 */
export interface EnergyToday {
  /** Bought from the grid today. */
  gridIn?: number;
  /** Sold to the grid today. */
  gridOut?: number;
  solar?: number;
  /** Into the battery. */
  batteryIn?: number;
  /** Out of the battery. */
  batteryOut?: number;
  /** When it was read, epoch ms. */
  at: number;
  /** Power sensors set in the dashboard (Home Assistant 2025.12 and later), for when the widget isn't told which. */
  power?: { grid?: string; solar?: string; battery?: string };
}

/** The statistics a dashboard's preferences point at, and its power sensors. */
export interface EnergyStats {
  gridIn: string[];
  gridOut: string[];
  solar: string[];
  batteryIn: string[];
  batteryOut: string[];
  power: { grid?: string; solar?: string; battery?: string };
}

/** Reads `energy/get_prefs`: which statistics hold each flow. Unknown shapes give empty lists. */
export function energyStats(prefs: unknown): EnergyStats {
  const out: EnergyStats = { gridIn: [], gridOut: [], solar: [], batteryIn: [], batteryOut: [], power: {} };
  const sources = (prefs as { energy_sources?: unknown[] } | null)?.energy_sources;
  if (!Array.isArray(sources)) return out;
  const id = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const rate = (s: Record<string, any>) => id(s.stat_rate) ?? id(s.power?.[0]?.stat_rate) ?? id(s.power_config?.stat_rate);
  for (const s of sources as Record<string, any>[]) {
    if (s?.type === 'grid') {
      for (const f of Array.isArray(s.flow_from) ? s.flow_from : []) if (id(f?.stat_energy_from)) out.gridIn.push(f.stat_energy_from);
      for (const f of Array.isArray(s.flow_to) ? s.flow_to : []) if (id(f?.stat_energy_to)) out.gridOut.push(f.stat_energy_to);
      const r = rate(s);
      if (r) out.power.grid ??= r;
    } else if (s?.type === 'solar') {
      if (id(s.stat_energy_from)) out.solar.push(s.stat_energy_from);
      const r = rate(s);
      if (r) out.power.solar ??= r;
    } else if (s?.type === 'battery') {
      if (id(s.stat_energy_from)) out.batteryOut.push(s.stat_energy_from);
      if (id(s.stat_energy_to)) out.batteryIn.push(s.stat_energy_to);
      const r = rate(s);
      if (r) out.power.battery ??= r;
    }
  }
  return out;
}

/** Sums today's `change` of each flow from `recorder/statistics_during_period` (period: day). */
export function energyToday(stats: EnergyStats, result: unknown, at: number): EnergyToday {
  const rows = (result ?? {}) as Record<string, { change?: number | null }[]>;
  const sum = (ids: string[]) => {
    if (!ids.length) return undefined;
    let total = 0;
    for (const id of ids) for (const r of rows[id] ?? []) if (typeof r?.change === 'number' && Number.isFinite(r.change)) total += r.change;
    return total;
  };
  const e: EnergyToday = { at };
  const put = (k: 'gridIn' | 'gridOut' | 'solar' | 'batteryIn' | 'batteryOut') => {
    const v = sum(stats[k]);
    if (v !== undefined) e[k] = v;
  };
  put('gridIn');
  put('gridOut');
  put('solar');
  put('batteryIn');
  put('batteryOut');
  const power = Object.fromEntries(Object.entries(stats.power).filter(([, v]) => v));
  if (Object.keys(power).length) e.power = power;
  return e;
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
  /** Its address for HTTP (`http://homeassistant.local:8123`), where entity pictures are read. */
  base?: string;
  /** Today's energy, when the Energy dashboard is set up. */
  energy?: EnergyToday;
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
  const picture = str(a.entity_picture);
  if (picture && (e.domain === 'camera' || e.domain === 'image' || e.domain === 'media_player')) e.picture = picture;
  if (picture && (e.domain === 'person' || e.domain === 'device_tracker')) e.photo = picture;
  if (e.domain === 'media_player') {
    const m: Media = {};
    const title = str(a.media_title);
    if (title) m.title = title;
    const artist = str(a.media_artist) ?? str(a.media_series_title);
    if (artist) m.artist = artist;
    const album = str(a.media_album_name);
    if (album) m.album = album;
    const app = str(a.app_name) ?? str(a.source);
    if (app) m.app = app;
    const duration = num(a.media_duration);
    if (duration !== undefined && duration > 0) m.duration = duration;
    const position = num(a.media_position);
    if (position !== undefined) m.position = position;
    const at = Date.parse(str(a.media_position_updated_at) ?? '');
    if (Number.isFinite(at)) m.positionAt = at;
    if (Object.keys(m).length) e.media = m;
  }
  return e;
}

/** `homeassistant.local:8123/` → `http://homeassistant.local:8123`: where its HTTP API is. */
export function httpBase(address: string): string {
  let a = address.trim().replace(/\/+$/, '').replace(/\/api\/websocket$/, '');
  if (!/^[a-z]+:\/\//i.test(a)) a = `http://${a}`;
  return a.replace(/^ws(s?):\/\//i, (_, s: string) => `http${s}://`);
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

/** How many decimals a number of this size deserves: fewer as it grows. */
export const autoDecimals = (n: number) => {
  const a = Math.abs(n);
  return a >= 100 ? 0 : a >= 10 ? 1 : 2;
};

/**
 * Decimals as Home Assistant's own cards would show them: fewer as the
 * number grows. `decimals` ≥ 0 forces them. `like` sizes the automatic
 * decimals after another number (a minimum next to its value).
 */
export function formatNumber(n: number, locale: string, decimals = -1, like = n): string {
  const max = decimals >= 0 ? decimals : autoDecimals(like);
  return new Intl.NumberFormat(locale, { maximumFractionDigits: max, minimumFractionDigits: decimals >= 0 ? decimals : 0 }).format(n);
}

/** Temperatures: the degree sign goes with the number (`21,5°`), as on a thermometer. */
export const isTemperature = (unit: string | undefined) => unit === '°C' || unit === '°F' || unit === '°';

/** `21.5 °C`, `1 534 W`, `68 %` (no space before %, as Home Assistant writes it). */
export function withUnit(text: string, unit: string | undefined): string {
  if (!unit) return text;
  return unit === '%' ? `${text} %` : `${text} ${unit}`;
}

type L = Localized;
const on_off = (on: L, off: L) => ({ on, off });

/** Binary sensors say `on`/`off`; what that means depends on what they sense. */
const BINARY: Record<string, { on: L; off: L }> = {
  battery: on_off({ en: 'Low', es: 'Baja', 'zh-Hant': '電量低', 'zh-Hans': '电量低' }, { en: 'Normal', es: 'Normal', 'zh-Hant': '正常', 'zh-Hans': '正常' }),
  battery_charging: on_off({ en: 'Charging', es: 'Cargando', 'zh-Hant': '充電中', 'zh-Hans': '充电中' }, { en: 'Not charging', es: 'Sin cargar', 'zh-Hant': '未充電', 'zh-Hans': '未充电' }),
  carbon_monoxide: on_off({ en: 'CO detected', es: 'CO detectado', 'zh-Hant': '偵測到 CO', 'zh-Hans': '检测到 CO' }, { en: 'Clear', es: 'Normal', 'zh-Hant': '正常', 'zh-Hans': '正常' }),
  cold: on_off({ en: 'Cold', es: 'Frío', 'zh-Hant': '寒冷', 'zh-Hans': '寒冷' }, { en: 'Normal', es: 'Normal', 'zh-Hant': '正常', 'zh-Hans': '正常' }),
  connectivity: on_off({ en: 'Connected', es: 'Conectado', 'zh-Hant': '已連線', 'zh-Hans': '已连接' }, { en: 'Disconnected', es: 'Desconectado', 'zh-Hant': '已中斷連線', 'zh-Hans': '已断开' }),
  door: on_off({ en: 'Open', es: 'Abierta', 'zh-Hant': '已開啟', 'zh-Hans': '已打开' }, { en: 'Closed', es: 'Cerrada', 'zh-Hant': '已關閉', 'zh-Hans': '已关闭' }),
  garage_door: on_off({ en: 'Open', es: 'Abierta', 'zh-Hant': '已開啟', 'zh-Hans': '已打开' }, { en: 'Closed', es: 'Cerrada', 'zh-Hant': '已關閉', 'zh-Hans': '已关闭' }),
  gas: on_off({ en: 'Gas detected', es: 'Gas detectado', 'zh-Hant': '偵測到瓦斯', 'zh-Hans': '检测到燃气' }, { en: 'Clear', es: 'Normal', 'zh-Hant': '正常', 'zh-Hans': '正常' }),
  heat: on_off({ en: 'Hot', es: 'Calor', 'zh-Hant': '過熱', 'zh-Hans': '过热' }, { en: 'Normal', es: 'Normal', 'zh-Hant': '正常', 'zh-Hans': '正常' }),
  light: on_off({ en: 'Light', es: 'Luz', 'zh-Hant': '明亮', 'zh-Hans': '明亮' }, { en: 'Dark', es: 'Oscuro', 'zh-Hant': '黑暗', 'zh-Hans': '黑暗' }),
  lock: on_off({ en: 'Unlocked', es: 'Sin cerrojo', 'zh-Hant': '已解鎖', 'zh-Hans': '已解锁' }, { en: 'Locked', es: 'Con cerrojo', 'zh-Hant': '已上鎖', 'zh-Hans': '已上锁' }),
  moisture: on_off({ en: 'Wet', es: 'Agua', 'zh-Hant': '有水', 'zh-Hans': '有水' }, { en: 'Dry', es: 'Seco', 'zh-Hant': '乾燥', 'zh-Hans': '干燥' }),
  motion: on_off({ en: 'Motion', es: 'Movimiento', 'zh-Hant': '有動靜', 'zh-Hans': '有动静' }, { en: 'Clear', es: 'Sin movimiento', 'zh-Hant': '無動靜', 'zh-Hans': '无动静' }),
  moving: on_off({ en: 'Moving', es: 'Moviéndose', 'zh-Hant': '移動中', 'zh-Hans': '移动中' }, { en: 'Still', es: 'Quieto', 'zh-Hant': '靜止', 'zh-Hans': '静止' }),
  occupancy: on_off({ en: 'Occupied', es: 'Ocupado', 'zh-Hant': '有人', 'zh-Hans': '有人' }, { en: 'Clear', es: 'Libre', 'zh-Hant': '無人', 'zh-Hans': '无人' }),
  opening: on_off({ en: 'Open', es: 'Abierto', 'zh-Hant': '已開啟', 'zh-Hans': '已打开' }, { en: 'Closed', es: 'Cerrado', 'zh-Hant': '已關閉', 'zh-Hans': '已关闭' }),
  plug: on_off({ en: 'Plugged in', es: 'Enchufado', 'zh-Hant': '已插電', 'zh-Hans': '已插电' }, { en: 'Unplugged', es: 'Desenchufado', 'zh-Hant': '未插電', 'zh-Hans': '未插电' }),
  power: on_off({ en: 'Power', es: 'Con corriente', 'zh-Hant': '有電', 'zh-Hans': '有电' }, { en: 'No power', es: 'Sin corriente', 'zh-Hant': '斷電', 'zh-Hans': '断电' }),
  presence: on_off({ en: 'Home', es: 'En casa', 'zh-Hant': '在家', 'zh-Hans': '在家' }, { en: 'Away', es: 'Fuera', 'zh-Hant': '外出', 'zh-Hans': '外出' }),
  problem: on_off({ en: 'Problem', es: 'Problema', 'zh-Hant': '異常', 'zh-Hans': '异常' }, { en: 'OK', es: 'Correcto', 'zh-Hant': '正常', 'zh-Hans': '正常' }),
  running: on_off({ en: 'Running', es: 'En marcha', 'zh-Hant': '運轉中', 'zh-Hans': '运行中' }, { en: 'Not running', es: 'Parado', 'zh-Hant': '已停止', 'zh-Hans': '已停止' }),
  safety: on_off({ en: 'Unsafe', es: 'Peligro', 'zh-Hant': '危險', 'zh-Hans': '危险' }, { en: 'Safe', es: 'Seguro', 'zh-Hant': '安全', 'zh-Hans': '安全' }),
  smoke: on_off({ en: 'Smoke', es: 'Humo', 'zh-Hant': '有煙霧', 'zh-Hans': '有烟雾' }, { en: 'Clear', es: 'Normal', 'zh-Hant': '正常', 'zh-Hans': '正常' }),
  sound: on_off({ en: 'Sound', es: 'Sonido', 'zh-Hant': '有聲音', 'zh-Hans': '有声音' }, { en: 'Quiet', es: 'Silencio', 'zh-Hant': '安靜', 'zh-Hans': '安静' }),
  tamper: on_off({ en: 'Tampered', es: 'Manipulado', 'zh-Hant': '遭竄改', 'zh-Hans': '被篡改' }, { en: 'Clear', es: 'Normal', 'zh-Hant': '正常', 'zh-Hans': '正常' }),
  update: on_off({ en: 'Update available', es: 'Actualización disponible', 'zh-Hant': '有可用更新', 'zh-Hans': '有可用更新' }, { en: 'Up to date', es: 'Al día', 'zh-Hant': '已是最新', 'zh-Hans': '已是最新' }),
  vibration: on_off({ en: 'Vibration', es: 'Vibración', 'zh-Hant': '震動', 'zh-Hans': '振动' }, { en: 'Still', es: 'Quieto', 'zh-Hant': '靜止', 'zh-Hans': '静止' }),
  window: on_off({ en: 'Open', es: 'Abierta', 'zh-Hant': '已開啟', 'zh-Hans': '已打开' }, { en: 'Closed', es: 'Cerrada', 'zh-Hant': '已關閉', 'zh-Hans': '已关闭' }),
};

/** Words of other domains, by state. */
const WORDS: Record<string, L> = {
  on: { en: 'On', es: 'Encendido', 'zh-Hant': '開啟', 'zh-Hans': '开启' },
  off: { en: 'Off', es: 'Apagado', 'zh-Hant': '關閉', 'zh-Hans': '关闭' },
  open: { en: 'Open', es: 'Abierto', 'zh-Hant': '已開啟', 'zh-Hans': '已打开' },
  opening: { en: 'Opening', es: 'Abriendo', 'zh-Hant': '開啟中', 'zh-Hans': '正在打开' },
  closed: { en: 'Closed', es: 'Cerrado', 'zh-Hant': '已關閉', 'zh-Hans': '已关闭' },
  closing: { en: 'Closing', es: 'Cerrando', 'zh-Hant': '關閉中', 'zh-Hans': '正在关闭' },
  locked: { en: 'Locked', es: 'Cerrada', 'zh-Hant': '已上鎖', 'zh-Hans': '已上锁' },
  unlocked: { en: 'Unlocked', es: 'Abierta', 'zh-Hant': '已解鎖', 'zh-Hans': '已解锁' },
  locking: { en: 'Locking', es: 'Cerrando', 'zh-Hant': '上鎖中', 'zh-Hans': '正在上锁' },
  unlocking: { en: 'Unlocking', es: 'Abriendo', 'zh-Hant': '解鎖中', 'zh-Hans': '正在解锁' },
  jammed: { en: 'Jammed', es: 'Atascada', 'zh-Hant': '卡住', 'zh-Hans': '卡住' },
  home: { en: 'Home', es: 'En casa', 'zh-Hant': '在家', 'zh-Hans': '在家' },
  not_home: { en: 'Away', es: 'Fuera', 'zh-Hant': '外出', 'zh-Hans': '外出' },
  playing: { en: 'Playing', es: 'Reproduciendo', 'zh-Hant': '播放中', 'zh-Hans': '播放中' },
  paused: { en: 'Paused', es: 'En pausa', 'zh-Hant': '已暫停', 'zh-Hans': '已暂停' },
  idle: { en: 'Idle', es: 'Inactivo', 'zh-Hant': '閒置', 'zh-Hans': '空闲' },
  standby: { en: 'Standby', es: 'En espera', 'zh-Hant': '待機', 'zh-Hans': '待机' },
  buffering: { en: 'Buffering', es: 'Cargando', 'zh-Hant': '緩衝中', 'zh-Hans': '缓冲中' },
  heat: { en: 'Heat', es: 'Calor', 'zh-Hant': '暖氣', 'zh-Hans': '制热' },
  cool: { en: 'Cool', es: 'Frío', 'zh-Hant': '冷氣', 'zh-Hans': '制冷' },
  heat_cool: { en: 'Heat/cool', es: 'Calor/frío', 'zh-Hant': '冷暖', 'zh-Hans': '冷暖' },
  auto: { en: 'Auto', es: 'Automático', 'zh-Hant': '自動', 'zh-Hans': '自动' },
  dry: { en: 'Dry', es: 'Deshumidificar', 'zh-Hant': '除濕', 'zh-Hans': '除湿' },
  fan_only: { en: 'Fan only', es: 'Solo ventilador', 'zh-Hant': '僅送風', 'zh-Hans': '仅送风' },
  heating: { en: 'heating', es: 'calentando', 'zh-Hant': '加熱中', 'zh-Hans': '制热中' },
  cooling: { en: 'cooling', es: 'enfriando', 'zh-Hant': '冷卻中', 'zh-Hans': '制冷中' },
  drying: { en: 'drying', es: 'secando', 'zh-Hant': '除濕中', 'zh-Hans': '除湿中' },
  fan: { en: 'fan', es: 'ventilando', 'zh-Hant': '送風中', 'zh-Hans': '送风中' },
  preheating: { en: 'preheating', es: 'precalentando', 'zh-Hant': '預熱中', 'zh-Hans': '预热中' },
  disarmed: { en: 'Disarmed', es: 'Desarmada', 'zh-Hant': '已解除警戒', 'zh-Hans': '已撤防' },
  armed_home: { en: 'Armed home', es: 'Armada en casa', 'zh-Hant': '在家警戒', 'zh-Hans': '在家布防' },
  armed_away: { en: 'Armed away', es: 'Armada', 'zh-Hant': '外出警戒', 'zh-Hans': '离家布防' },
  armed_night: { en: 'Armed night', es: 'Armada noche', 'zh-Hant': '夜間警戒', 'zh-Hans': '夜间布防' },
  armed_vacation: { en: 'Armed vacation', es: 'Armada vacaciones', 'zh-Hant': '度假警戒', 'zh-Hans': '度假布防' },
  armed_custom_bypass: { en: 'Armed', es: 'Armada', 'zh-Hant': '已警戒', 'zh-Hans': '已布防' },
  arming: { en: 'Arming', es: 'Armando', 'zh-Hant': '警戒啟動中', 'zh-Hans': '正在布防' },
  disarming: { en: 'Disarming', es: 'Desarmando', 'zh-Hant': '解除警戒中', 'zh-Hans': '正在撤防' },
  pending: { en: 'Pending', es: 'Pendiente', 'zh-Hant': '等待中', 'zh-Hans': '等待中' },
  triggered: { en: 'Triggered', es: 'Disparada', 'zh-Hant': '已觸發', 'zh-Hans': '已触发' },
  cleaning: { en: 'Cleaning', es: 'Limpiando', 'zh-Hant': '清掃中', 'zh-Hans': '清扫中' },
  docked: { en: 'Docked', es: 'En la base', 'zh-Hant': '在充電座', 'zh-Hans': '在充电座' },
  returning: { en: 'Returning', es: 'Volviendo', 'zh-Hant': '返回中', 'zh-Hans': '返回中' },
  error: { en: 'Error', es: 'Error', 'zh-Hant': '錯誤', 'zh-Hans': '错误' },
  above_horizon: { en: 'Up', es: 'Sobre el horizonte', 'zh-Hant': '地平線上', 'zh-Hans': '地平线上' },
  below_horizon: { en: 'Down', es: 'Bajo el horizonte', 'zh-Hant': '地平線下', 'zh-Hans': '地平线下' },
  unavailable: { en: 'Unavailable', es: 'No disponible', 'zh-Hant': '無法使用', 'zh-Hans': '不可用' },
  unknown: { en: 'Unknown', es: 'Desconocido', 'zh-Hant': '未知', 'zh-Hans': '未知' },
  sunny: { en: 'Sunny', es: 'Soleado', 'zh-Hant': '晴', 'zh-Hans': '晴' },
  'clear-night': { en: 'Clear', es: 'Despejado', 'zh-Hant': '晴朗', 'zh-Hans': '晴朗' },
  partlycloudy: { en: 'Partly cloudy', es: 'Parcialmente nublado', 'zh-Hant': '晴時多雲', 'zh-Hans': '多云' },
  cloudy: { en: 'Cloudy', es: 'Nublado', 'zh-Hant': '陰', 'zh-Hans': '阴' },
  rainy: { en: 'Rain', es: 'Lluvia', 'zh-Hant': '雨', 'zh-Hans': '雨' },
  pouring: { en: 'Heavy rain', es: 'Lluvia fuerte', 'zh-Hant': '大雨', 'zh-Hans': '大雨' },
  snowy: { en: 'Snow', es: 'Nieve', 'zh-Hant': '雪', 'zh-Hans': '雪' },
  fog: { en: 'Fog', es: 'Niebla', 'zh-Hant': '霧', 'zh-Hans': '雾' },
  windy: { en: 'Windy', es: 'Viento', 'zh-Hant': '有風', 'zh-Hans': '有风' },
  lightning: { en: 'Storm', es: 'Tormenta', 'zh-Hant': '雷雨', 'zh-Hans': '雷雨' },
  'lightning-rainy': { en: 'Storm', es: 'Tormenta', 'zh-Hant': '雷雨', 'zh-Hans': '雷雨' },
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
    return { entity: e, level, what: { en: `Battery ${pct}`, es: `Batería ${pct}`, 'zh-Hant': `電池 ${pct}`, 'zh-Hans': `电池 ${pct}` }, kind: 'battery' };
  }
  if (e.domain === 'binary_sensor' && e.deviceClass === 'battery') {
    return o.includeBatteries && e.state === 'on' ? { entity: e, level: 'warn', what: { en: 'Battery low', es: 'Batería baja', 'zh-Hant': '電量低', 'zh-Hans': '电量低' }, kind: 'battery' } : null;
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
  // The sample home's names: localized texts like any other, so a missing language is found (scripts/i18n-gaps.ts).
  const n = (text: Localized) => localize(text, locale);
  const ago = (ms: number) => now - ms;
  const min = 60_000;
  const raw: (Partial<Entity> & { id: string; state: string })[] = [
    { id: 'sensor.living_room_temperature', name: n({ en: 'Living room temperature', es: 'Temperatura salón', 'zh-Hant': '客廳溫度', 'zh-Hans': '客厅温度' }), state: '21.4', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', changedAt: ago(4 * min) },
    { id: 'sensor.living_room_humidity', name: n({ en: 'Living room humidity', es: 'Humedad salón', 'zh-Hant': '客廳濕度', 'zh-Hans': '客厅湿度' }), state: '48', unit: '%', deviceClass: 'humidity', stateClass: 'measurement', changedAt: ago(9 * min) },
    { id: 'sensor.bedroom_temperature', name: n({ en: 'Bedroom temperature', es: 'Temperatura dormitorio', 'zh-Hant': '臥室溫度', 'zh-Hans': '卧室温度' }), state: '19.8', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', changedAt: ago(2 * min) },
    { id: 'sensor.outdoor_temperature', name: n({ en: 'Outdoor temperature', es: 'Temperatura exterior', 'zh-Hant': '室外溫度', 'zh-Hans': '室外温度' }), state: '11.2', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', changedAt: ago(6 * min) },
    { id: 'sensor.house_power', name: n({ en: 'House power', es: 'Consumo de la casa', 'zh-Hant': '全屋用電', 'zh-Hans': '全屋用电' }), state: '1534', unit: 'W', deviceClass: 'power', stateClass: 'measurement', changedAt: ago(0.2 * min) },
    { id: 'sensor.solar_power', name: n({ en: 'Solar production', es: 'Producción solar', 'zh-Hant': '太陽能發電', 'zh-Hans': '光伏发电' }), state: '2210', unit: 'W', deviceClass: 'power', stateClass: 'measurement', changedAt: ago(0.4 * min) },
    { id: 'sensor.grid_power', name: n({ en: 'Grid power', es: 'Potencia de la red', 'zh-Hant': '市電功率', 'zh-Hans': '电网功率' }), state: '0', unit: 'W', deviceClass: 'power', stateClass: 'measurement', changedAt: ago(0.1 * min) },
    { id: 'sensor.battery_power', name: n({ en: 'Battery power', es: 'Potencia de la batería', 'zh-Hant': '電池功率', 'zh-Hans': '电池功率' }), state: '-420', unit: 'W', deviceClass: 'power', stateClass: 'measurement', changedAt: ago(0.1 * min) },
    { id: 'sensor.battery_level', name: n({ en: 'Battery level', es: 'Nivel de la batería', 'zh-Hant': '電池電量', 'zh-Hans': '电池电量' }), state: '64', unit: '%', deviceClass: 'battery', stateClass: 'measurement', changedAt: ago(3 * min) },
    { id: 'sensor.energy_today', name: n({ en: 'Energy today', es: 'Energía hoy', 'zh-Hant': '今日用電', 'zh-Hans': '今日用电' }), state: '7.84', unit: 'kWh', deviceClass: 'energy', stateClass: 'total_increasing', changedAt: ago(1 * min) },
    { id: 'sensor.hallway_motion_battery', name: n({ en: 'Hallway sensor battery', es: 'Batería sensor pasillo', 'zh-Hant': '走廊感測器電池', 'zh-Hans': '走廊传感器电池' }), state: '8', unit: '%', deviceClass: 'battery', stateClass: 'measurement', changedAt: ago(30 * 3_600_000) },
    { id: 'sensor.front_door_lock_battery', name: n({ en: 'Front door lock battery', es: 'Batería cerradura', 'zh-Hant': '大門門鎖電池', 'zh-Hans': '大门门锁电池' }), state: '64', unit: '%', deviceClass: 'battery', stateClass: 'measurement', changedAt: ago(3 * 3_600_000) },
    { id: 'binary_sensor.balcony_door', name: n({ en: 'Balcony door', es: 'Puerta del balcón', 'zh-Hant': '陽台門', 'zh-Hans': '阳台门' }), state: 'on', deviceClass: 'door', changedAt: ago(42 * min) },
    { id: 'binary_sensor.front_door', name: n({ en: 'Front door', es: 'Puerta de entrada', 'zh-Hant': '大門', 'zh-Hans': '大门' }), state: 'off', deviceClass: 'door', changedAt: ago(95 * min) },
    { id: 'binary_sensor.kitchen_window', name: n({ en: 'Kitchen window', es: 'Ventana cocina', 'zh-Hant': '廚房窗戶', 'zh-Hans': '厨房窗户' }), state: 'off', deviceClass: 'window', changedAt: ago(5 * 3_600_000) },
    { id: 'camera.porch', name: n({ en: 'Porch', es: 'Porche', 'zh-Hant': '門廊', 'zh-Hans': '门廊' }), state: 'idle', picture: '/api/camera_proxy/camera.porch?token=demo', changedAt: ago(3 * 3_600_000) },
    { id: 'binary_sensor.porch_motion', name: n({ en: 'Porch motion', es: 'Movimiento porche', 'zh-Hant': '門廊動態', 'zh-Hans': '门廊移动' }), state: 'off', deviceClass: 'motion', changedAt: ago(12 * min) },
    { id: 'binary_sensor.hallway_motion', name: n({ en: 'Hallway motion', es: 'Movimiento pasillo', 'zh-Hant': '走廊動態', 'zh-Hans': '走廊移动' }), state: 'on', deviceClass: 'motion', changedAt: ago(1 * min) },
    { id: 'binary_sensor.washing_machine_leak', name: n({ en: 'Washing machine leak', es: 'Fuga lavadora', 'zh-Hant': '洗衣機漏水', 'zh-Hans': '洗衣机漏水' }), state: 'off', deviceClass: 'moisture', changedAt: ago(26 * 3_600_000) },
    { id: 'lock.front_door', name: n({ en: 'Front door lock', es: 'Cerradura entrada', 'zh-Hant': '大門門鎖', 'zh-Hans': '大门门锁' }), state: 'locked', changedAt: ago(95 * min) },
    { id: 'light.living_room', name: n({ en: 'Living room lights', es: 'Luces salón', 'zh-Hant': '客廳燈', 'zh-Hans': '客厅灯' }), state: 'on', changedAt: ago(37 * min) },
    { id: 'light.kitchen', name: n({ en: 'Kitchen lights', es: 'Luces cocina', 'zh-Hant': '廚房燈', 'zh-Hans': '厨房灯' }), state: 'off', changedAt: ago(70 * min) },
    { id: 'switch.coffee_machine', name: n({ en: 'Coffee machine', es: 'Cafetera', 'zh-Hant': '咖啡機', 'zh-Hans': '咖啡机' }), state: 'off', changedAt: ago(2 * 3_600_000) },
    { id: 'climate.living_room', name: n({ en: 'Thermostat', es: 'Termostato', 'zh-Hant': '溫控器', 'zh-Hans': '温控器' }), state: 'heat', current: 21.4, target: 22, action: 'heating', unit: '°C', changedAt: ago(3 * 3_600_000) },
    { id: 'person.alex', name: 'Alex', state: 'home', changedAt: ago(4 * 3_600_000) },
    { id: 'person.sam', name: 'Sam', state: n({ en: 'Work', es: 'Trabajo', 'zh-Hant': '上班', 'zh-Hans': '上班' }), changedAt: ago(6 * 3_600_000) },
    { id: 'person.robin', name: 'Robin', state: 'not_home', changedAt: ago(35 * min) },
    { id: 'media_player.living_room_speaker', name: n({ en: 'Living room speaker', es: 'Altavoz del salón', 'zh-Hant': '客廳喇叭', 'zh-Hans': '客厅音箱' }), state: 'playing', picture: '/api/media_player_proxy/media_player.living_room_speaker?token=demo', media: { title: n({ en: 'Blue in Green', es: 'Blue in Green', 'zh-Hant': 'Blue in Green', 'zh-Hans': 'Blue in Green' }), artist: 'Miles Davis', album: 'Kind of Blue', app: 'Spotify', duration: 337, position: 128, positionAt: ago(0) }, changedAt: ago(3 * min) },
    { id: 'media_player.living_room_tv', name: n({ en: 'Living room TV', es: 'Tele del salón', 'zh-Hant': '客廳電視', 'zh-Hans': '客厅电视' }), state: 'playing', changedAt: ago(25 * min) },
    { id: 'sensor.garage_temperature', name: n({ en: 'Garage temperature', es: 'Temperatura garaje', 'zh-Hant': '車庫溫度', 'zh-Hans': '车库温度' }), state: 'unavailable', unit: '°C', deviceClass: 'temperature', stateClass: 'measurement', changedAt: ago(14 * 3_600_000) },
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
  // The grid makes up what the sun doesn't, with the battery charging.
  const w = (id: string) => Number(entities[id]!.state);
  entities['sensor.grid_power']!.state = String(Math.round(w('sensor.house_power') - w('sensor.solar_power') - w('sensor.battery_power')));
  const energy = { gridIn: 3.1, gridOut: 4.6, solar: 14.2, batteryIn: 3.4, batteryOut: 2.1, at: now };
  return { state: 'ok', version: '2026.11.1', base: 'http://homeassistant.local:8123', energy, entities, history };
}
