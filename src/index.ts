/**
 * Home Assistant on the panel: one shared live connection (WebSocket, no
 * polling) and three cards over it — one entity in big, a list of entities,
 * and what needs you at home (a door left open, a low battery, a leak).
 */
import { defineSource, definePlugin, defineWidget, drawEmpty, listLayout, listOptions, t, type Box, type Graphics, type RenderContext } from '@kiosko/sdk';
import { connect } from './connection.ts';
import { renderEntity, stateColor, thresholdLevel } from './card.ts';
import { drawMessage, drawRows, type Row } from './draw.ts';
import {
  demoHome, formatNumber, isTemperature, levelOf, notices, numericState, pick, stateText,
  type Entity, type HaData, type Level, type LevelOptions,
} from './ha.ts';
import { batteryLevel, iconFor } from './icons.ts';

export * from './ha.ts';
export * from './connection.ts';
export * from './draw.ts';
export * from './icons.ts';
export * from './card.ts';

const SOURCE = 'homeassistant/states';

export const states = defineSource({
  id: 'states',
  name: { en: 'Home Assistant', es: 'Home Assistant' },
  description: {
    en: 'The states of your Home Assistant entities, live over its WebSocket API (a change shows at once), and the last day of the numeric sensors for the history bars.',
    es: 'Los estados de las entidades de tu Home Assistant, en directo por su API WebSocket (un cambio se ve al momento), y el último día de los sensores numéricos para las barras de histórico.',
  },
  options: t.object({
    url: t.string({
      format: 'url', risk: 'network', placeholder: 'http://homeassistant.local:8123',
      label: { en: 'Home Assistant address', es: 'Dirección de Home Assistant' },
      help: { en: 'The one you open in the browser, e.g. http://homeassistant.local:8123 or https://home.example.com.', es: 'La que abres en el navegador, p. ej. http://homeassistant.local:8123 o https://casa.example.com.' },
    }),
    token: t.string({
      secret: true,
      label: { en: 'Long-lived access token', es: 'Token de acceso de larga duración' },
      help: {
        en: 'In Home Assistant: your profile → Security → Long-lived access tokens → Create token. A user that is not an administrator is enough.',
        es: 'En Home Assistant: tu perfil → Seguridad → Tokens de acceso de larga duración → Crear token. Basta un usuario que no sea administrador.',
      },
    }),
    entities: t.filter({
      label: { en: 'Entities to read', es: 'Entidades que leer' },
      help: { en: 'Empty = all. Ids or names, with * and !: sensor.*, binary_sensor.*, lock.*, !sensor.*_linkquality.', es: 'Vacío = todas. Ids o nombres, con * y !: sensor.*, binary_sensor.*, lock.*, !sensor.*_linkquality.' },
    }),
    history: t.filter({
      advanced: true,
      label: { en: 'Entities with history', es: 'Entidades con histórico' },
      help: { en: 'Numeric sensors whose last day is kept for the history bars. Empty = every one with a unit.', es: 'Sensores numéricos de los que se guarda el último día para las barras de histórico. Vacío = todos los que tienen unidad.' },
    }),
    maxHistory: t.integer({
      default: 100, min: 0, max: 1000, advanced: true,
      label: { en: 'Most entities with history', es: 'Máximo de entidades con histórico' },
      help: { en: 'Each costs a day of five-minute averages in memory (about 300 numbers). 0 = no history.', es: 'Cada una ocupa un día de medias de cinco minutos en memoria (unos 300 números). 0 = sin histórico.' },
    }),
  }),
  watch: (ctx, emit) => connect({ url: ctx.options.url, token: ctx.options.token, entities: ctx.options.entities, history: ctx.options.history, maxHistory: ctx.options.maxHistory }, emit, { signal: ctx.signal, log: ctx.log }),
  demo: ({ now, locale }) => demoHome(now, locale),
});

const dataOf = (sources: Record<string, unknown>) => sources[SOURCE] as HaData | undefined;
const demo = ({ now, locale }: { now: number; locale: string }) => ({ sources: { [SOURCE]: demoHome(now, locale) } });

type Ctx = Pick<RenderContext<unknown, unknown>, 'theme' | 'kit' | 't' | 'fmt'>;

/**
 * The connection states every card shares. Returns the box left for the
 * content (shorter by one line while offline), or null when the card has
 * already been painted.
 */
function frame(g: Graphics, box: Box, ctx: Ctx, data: HaData | undefined): Box | null {
  if (!data) return null;
  const tr = ctx.t;
  if (data.state === 'unconfigured') {
    drawMessage(g, box, ctx, tr({ en: 'Home Assistant not set up', es: 'Home Assistant sin configurar' }), tr({ en: 'Set its address and a token in Settings → Data sources', es: 'Pon su dirección y un token en Ajustes → Fuentes de datos' }));
    return null;
  }
  if (data.state === 'connecting') {
    drawMessage(g, box, ctx, tr({ en: 'Connecting to Home Assistant…', es: 'Conectando con Home Assistant…' }));
    return null;
  }
  if (data.state === 'error' && !Object.keys(data.entities).length) {
    drawMessage(g, box, ctx, tr({ en: 'Home Assistant unreachable', es: 'Home Assistant no responde' }), data.error);
    return null;
  }
  if (data.state === 'ok') return box;
  // Offline (or refused) with the last states known: show them, and say so.
  const { colors, fonts } = ctx.theme;
  const s = Math.max(10, Math.round(Math.min(18, box.h * 0.12)));
  const hint = data.since ? `${tr({ en: 'offline since', es: 'sin conexión desde las' })} ${ctx.fmt.time(data.since)}` : tr({ en: 'offline', es: 'sin conexión' });
  ctx.kit.drawTracked(g, ctx.kit.truncate(g, hint, box.w, { size: s, family: fonts.sans }), box.x + box.w, box.y + box.h - s * 0.25, { size: s, family: fonts.sans, color: colors.warn, align: 'right' });
  return { ...box, h: box.h - s * 1.4 };
}

/** States that come in, as opposed to a card waiting for its connection. */
const live = (d: HaData | undefined): d is HaData => !!d && (d.state === 'ok' || d.state === 'offline' || (d.state === 'error' && Object.keys(d.entities).length > 0));

const batteryFields = () => ({
  batteryWarn: t.integer({ default: 20, min: 0, max: 100, unit: '%', advanced: true, label: { en: 'Battery warning at', es: 'Batería en aviso desde' } }),
  batteryAlert: t.integer({ default: 10, min: 0, max: 100, unit: '%', advanced: true, label: { en: 'Battery alert at', es: 'Batería en alerta desde' } }),
});

/* ---------- one entity ---------- */

export const entity = defineWidget({
  id: 'entity',
  name: { en: 'Entity', es: 'Entidad' },
  description: {
    en: 'One Home Assistant entity in big: a temperature, the power the house draws, a door, the thermostat. Numeric sensors can show their last hours as bars, and turn amber or red past thresholds of your own.',
    es: 'Una entidad de Home Assistant en grande: una temperatura, lo que consume la casa, una puerta, el termostato. Los sensores numéricos pueden mostrar sus últimas horas en barras y ponerse en ámbar o rojo al pasar los umbrales que elijas.',
  },
  icon: 'gauge',
  category: 'info',
  tags: ['home assistant', 'smart home', 'sensor'],
  size: { min: { w: 140, h: 80 }, preferred: { w: 320, h: 200 } },
  sources: [SOURCE],
  options: t.object({
    entity: t.string({
      placeholder: 'sensor.living_room_temperature',
      label: { en: 'Entity', es: 'Entidad' },
      help: { en: 'Its id, as in Home Assistant → Settings → Devices & services → Entities.', es: 'Su id, como en Home Assistant → Ajustes → Dispositivos y servicios → Entidades.' },
    }),
    name: t.string({ label: { en: 'Name', es: 'Nombre' }, help: { en: 'Empty = the name in Home Assistant.', es: 'Vacío = el nombre en Home Assistant.' } }),
    showName: t.boolean({ default: true, label: { en: 'Show the name', es: 'Mostrar el nombre' } }),
    showHistory: t.boolean({ default: true, label: { en: 'Show the history', es: 'Mostrar el histórico' }, help: { en: 'Numeric sensors only, when the source keeps their history.', es: 'Solo sensores numéricos cuyo histórico guarda la fuente.' } }),
    historyMs: t.duration({ default: 24 * 3_600_000, min: 3_600_000, max: 24 * 3_600_000, label: { en: 'History span', es: 'Periodo del histórico' } }),
    decimals: t.integer({ default: -1, min: -1, max: 4, advanced: true, label: { en: 'Decimals', es: 'Decimales' }, help: { en: '-1 = automatic: fewer as the number grows.', es: '-1 = automático: menos cuanto mayor es el número.' } }),
    thresholds: t.enum(['off', 'above', 'below'], {
      default: 'off',
      label: { en: 'Thresholds', es: 'Umbrales' },
      labels: { off: { en: 'Off', es: 'No' }, above: { en: 'Warn above', es: 'Avisar por encima' }, below: { en: 'Warn below', es: 'Avisar por debajo' } },
    }),
    warn: t.number({ default: 0, min: -1e6, max: 1e6, label: { en: 'Warning (amber) at', es: 'Aviso (ámbar) en' } }),
    alert: t.number({ default: 0, min: -1e6, max: 1e6, label: { en: 'Alert (red) at', es: 'Alerta (rojo) en' }, help: { en: 'Red, and the widget keeps its tile.', es: 'Rojo, y el widget se queda con su tesela.' } }),
  }),
  redraw: 'minute',
  urgent: ({ options, sources }) => {
    const e = dataOf(sources)?.entities[options.entity];
    return !!e && dataOf(sources)?.state === 'ok' && thresholdLevel(e, options) === 'alert';
  },
  render(g, ctx) {
    const { options, sources, t: tr } = ctx;
    const data = dataOf(sources);
    const box = frame(g, ctx.box, ctx, data);
    if (!box || !data) return;
    if (!options.entity) return drawMessage(g, box, ctx, tr({ en: 'Choose an entity', es: 'Elige una entidad' }), tr({ en: 'Its id in the inspector, e.g. sensor.living_room_temperature', es: 'Su id en el inspector, p. ej. sensor.living_room_temperature' }));
    if (!data.entities[options.entity]) return drawMessage(g, box, ctx, tr({ en: 'Entity not found', es: 'Entidad no encontrada' }), options.entity);
    renderEntity(g, ctx, data, box);
  },
  demo: ({ now, locale }) => ({ ...demo({ now, locale }), options: { entity: 'sensor.living_room_temperature' } }),
});

/* ---------- a list of entities ---------- */

export const entities = defineWidget({
  id: 'entities',
  name: { en: 'Entities', es: 'Entidades' },
  description: {
    en: 'A list of Home Assistant entities and their states, picked by id or name with patterns (sensor.*_temperature, light.*). Open doors, low batteries and alarms are coloured; the rest stays quiet.',
    es: 'Una lista de entidades de Home Assistant con sus estados, elegidas por id o nombre con patrones (sensor.*_temperature, light.*). Puertas abiertas, baterías bajas y alarmas llevan color; el resto, discreto.',
  },
  icon: 'list',
  category: 'info',
  tags: ['home assistant', 'smart home'],
  size: { min: { w: 220, h: 90 }, preferred: { w: 480, h: 260 } },
  sources: [SOURCE],
  options: t.object({
    ...listOptions({ layouts: ['one-line', 'detailed'] }),
    entities: t.filter({
      label: { en: 'Entities', es: 'Entidades' },
      help: { en: 'Ids or names, in the order to list them: sensor.*_temperature, light.*, *kitchen*, !light.porch. Empty = all.', es: 'Ids o nombres, en el orden en que listarlas: sensor.*_temperature, light.*, *cocina*, !light.porch. Vacío = todas.' },
    }),
    hideOff: t.boolean({ label: { en: 'Only what is on, open or wrong', es: 'Solo lo encendido, abierto o con problemas' }, help: { en: 'Leaves out what is off or closed. Numbers always stay.', es: 'Deja fuera lo apagado o cerrado. Los números se quedan siempre.' } }),
    hideUnavailable: t.boolean({ label: { en: 'Hide unavailable entities', es: 'Ocultar las entidades no disponibles' } }),
    decimals: t.integer({ default: -1, min: -1, max: 4, advanced: true, label: { en: 'Decimals', es: 'Decimales' }, help: { en: '-1 = automatic.', es: '-1 = automático.' } }),
    ...batteryFields(),
  }),
  redraw: 'minute',
  empty: ({ options, sources }) => {
    const d = dataOf(sources);
    return live(d) && !listed(d, options).length;
  },
  render(g, ctx) {
    const { options, sources, theme, fmt, t: tr } = ctx;
    const data = dataOf(sources);
    const box = frame(g, ctx.box, ctx, data);
    if (!box || !data) return;
    const list = listed(data, options);
    if (!list.length) return drawEmpty(g, { ...ctx, box }, tr({ en: 'No entities match', es: 'Ninguna entidad coincide' }));
    const plan = listLayout(box, list.length, options, {
      sizes: { 'one-line': { min: 22, max: Math.max(22, Math.min(40, box.w / 11)) }, detailed: { min: 42, max: Math.max(42, Math.min(66, box.w / 6)) } },
      auto: (b, n) => (b.h / Math.max(1, n) >= 52 && b.h >= b.w * 0.6 ? 'detailed' : 'one-line'),
      minRows: 3,
    });
    drawRows(g, { ...ctx, box }, plan, list.map(({ e, level }) => entityRow(e, level, ctx, options.decimals)));
  },
  demo: ({ now, locale }) => ({ ...demo({ now, locale }), options: { entities: ['sensor.*_temperature', 'binary_sensor.*door*', 'lock.*', 'light.*'] } }),
});

/** One entity as a list row: its icon, its name, and its value with the unit apart. */
function entityRow(e: Entity, level: Level, ctx: RenderContext<unknown, unknown>, decimals: number): Row {
  const { theme, locale, fmt } = ctx;
  const { colors } = theme;
  const n = e.domain === 'climate' ? e.current : e.domain === 'binary_sensor' ? undefined : numericState(e);
  const heating = e.domain === 'climate' && e.action === 'heating';
  const color = heating ? colors.warn : stateColor(level, colors);
  const battery = batteryLevel(e);
  const loud = level === 'alert' || level === 'warn';
  const value = n === undefined ? stateText(e, ctx, decimals) : `${formatNumber(n, locale, decimals)}${isTemperature(e.unit) || e.domain === 'climate' ? '°' : ''}`;
  const unit = n !== undefined && e.unit && !isTemperature(e.unit) && e.domain !== 'climate' ? e.unit : undefined;
  return {
    icon: iconFor(e),
    ...(battery !== undefined ? { battery } : {}),
    color: n !== undefined && !loud && !heating ? colors.inkDim : color,
    title: e.name,
    strong: level !== 'off' && level !== 'na' || n !== undefined,
    value: e.domain === 'climate' && e.target !== undefined && e.state !== 'off' ? `${value} → ${formatNumber(e.target, locale, decimals)}°` : value,
    ...(unit ? { unit } : {}),
    valueColor: loud || heating ? color : level === 'na' ? colors.inkFaint : n !== undefined || level === 'on' ? colors.ink : colors.inkDim,
    ...(e.changedAt ? { meta: ` · ${fmt.ago(e.changedAt, { suffix: false })}` } : {}),
  };
}

function listed(data: HaData, o: { entities: string[] | string; hideOff: boolean; hideUnavailable: boolean } & LevelOptions): { e: Entity; level: Level }[] {
  return pick(data.entities, o.entities)
    .map((e) => ({ e, level: levelOf(e, o) }))
    .filter(({ e, level }) => !(o.hideUnavailable && level === 'na') && !(o.hideOff && level === 'off' && numericState(e) === undefined));
}

/* ---------- what needs you ---------- */

export const attention = defineWidget({
  id: 'attention',
  name: { en: 'Home: needs you', es: 'Casa: te necesita' },
  description: {
    en: 'Only what needs you at home: smoke, a leak or the alarm in red (and it keeps its tile until they stop), then doors and windows left open, unlocked locks, low batteries and problems. Hides itself when all is well.',
    es: 'Solo lo que te necesita en casa: humo, una fuga o la alarma en rojo (y se queda con su tesela hasta que paren), luego puertas y ventanas abiertas, cerraduras sin cerrar, baterías bajas y problemas. Se oculta cuando todo va bien.',
  },
  icon: 'shield-alert',
  category: 'info',
  tags: ['home assistant', 'smart home', 'alerts'],
  size: { min: { w: 220, h: 90 }, preferred: { w: 480, h: 220 } },
  sources: [SOURCE],
  options: t.object({
    ...listOptions({ layouts: ['one-line', 'detailed'] }),
    entities: t.filter({ label: { en: 'Entities', es: 'Entidades' }, help: { en: 'Empty = all. Leave out the ones that are fine open with !: !binary_sensor.patio_door.', es: 'Vacío = todas. Deja fuera con ! las que pueden estar abiertas: !binary_sensor.patio_door.' } }),
    includeOpenings: t.boolean({ default: true, label: { en: 'Doors, windows and locks', es: 'Puertas, ventanas y cerraduras' }, help: { en: 'Open doors, windows, garage doors and gates; unlocked locks.', es: 'Puertas, ventanas, garajes y cancelas abiertas; cerraduras sin cerrar.' } }),
    openMs: t.duration({ default: 0, label: { en: 'Open for at least', es: 'Abierta al menos' }, help: { en: 'A door counts once it has been open this long. 0 = at once.', es: 'Una puerta cuenta cuando lleva abierta este tiempo. 0 = al momento.' } }),
    includeBatteries: t.boolean({ default: true, label: { en: 'Low batteries', es: 'Baterías bajas' } }),
    includeProblems: t.boolean({ default: true, label: { en: 'Problems', es: 'Problemas' }, help: { en: 'Problem and tamper sensors, lost connections, a vacuum in error.', es: 'Sensores de problema y manipulación, conexiones perdidas, un robot aspirador en error.' } }),
    includeUnavailable: t.boolean({ label: { en: 'Unavailable devices', es: 'Dispositivos no disponibles' } }),
    includeUpdates: t.boolean({ label: { en: 'Updates available', es: 'Actualizaciones disponibles' } }),
    ...batteryFields(),
  }),
  hideWhenEmpty: true,
  redraw: 'minute',
  urgent: ({ options, sources, now }) => {
    const d = dataOf(sources);
    return d?.state === 'ok' && notices(d.entities, options, now).some((n) => n.kind === 'danger');
  },
  idle: ({ options, sources, now }) => {
    const d = dataOf(sources);
    return !live(d) || !notices(d.entities, options, now).length;
  },
  empty: ({ options, sources, now }) => {
    const d = dataOf(sources);
    return live(d) && !notices(d.entities, options, now).length;
  },
  render(g, ctx) {
    const { options, sources, theme, fmt, now, t: tr } = ctx;
    const data = dataOf(sources);
    const box = frame(g, ctx.box, ctx, data);
    if (!box || !data) return;
    const list = notices(data.entities, options, now);
    if (!list.length) return drawEmpty(g, { ...ctx, box }, tr({ en: 'All well at home', es: 'Todo en orden en casa' }));
    const plan = listLayout(box, list.length, options, {
      sizes: { 'one-line': { min: 24, max: Math.max(24, Math.min(40, box.w / 11)) }, detailed: { min: 44, max: Math.max(44, Math.min(64, box.w / 6)) } },
      auto: (b, n) => (b.h / Math.max(1, n) >= 50 ? 'detailed' : 'one-line'),
      minRows: 3,
    });
    const { colors } = theme;
    drawRows(g, { ...ctx, box }, plan, list.map((n): Row => {
      const color = stateColor(n.level, colors);
      const battery = batteryLevel(n.entity);
      return {
        icon: iconFor(n.entity),
        ...(battery !== undefined ? { battery } : {}),
        color,
        title: n.entity.name,
        strong: n.level === 'alert' || n.level === 'warn',
        value: tr(n.what),
        valueColor: n.level === 'na' ? colors.inkDim : color,
        ...(n.entity.changedAt ? { meta: ` · ${fmt.ago(n.entity.changedAt, { suffix: false })}` } : {}),
        ...(n.kind === 'danger' ? { highlight: colors.alert } : {}),
      };
    }), { badges: true, metaRight: true });
  },
  demo,
});

export default definePlugin({
  id: 'homeassistant',
  name: { en: 'Home Assistant', es: 'Home Assistant' },
  version: '0.2.1',
  description: {
    en: 'Home Assistant on the panel, live over its WebSocket API: any entity in big with its history, lists of entities, and what needs you at home (doors left open, low batteries, leaks, the alarm).',
    es: 'Home Assistant en el panel, en directo por su API WebSocket: cualquier entidad en grande con su histórico, listas de entidades y lo que te necesita en casa (puertas abiertas, baterías bajas, fugas, la alarma).',
  },
  icon: 'house',
  widgets: [entity, entities, attention],
  sources: [states],
});
