/**
 * Home Assistant on the panel: one shared live connection (WebSocket, no
 * polling) and the cards over it: one entity in big, a list of entities,
 * what needs you at home (a door left open, a low battery, a leak), a
 * camera's latest picture, the energy flow, what's playing and who is home.
 */
import { defineSource, definePlugin, defineWidget, drawEmpty, listLayout, listOptions, t, type Box, type Graphics, type RenderContext } from '@kiosko/sdk';
import { connect } from './connection.ts';
import { renderEntity, stateColor, thresholdLevel } from './card.ts';
import { drawMessage, drawRows, errorHint, type Row } from './draw.ts';
import {
  demoHome, formatNumber, isTemperature, levelOf, notices, numericState, pick, stateText,
  type Entity, type HaData, type Level, type LevelOptions,
} from './ha.ts';
import { batteryLevel, iconFor } from './icons.ts';
import { camera } from './camera.ts';
import { energy } from './energy.ts';
import { media } from './media.ts';
import { people } from './people.ts';

export * from './ha.ts';
export * from './connection.ts';
export * from './draw.ts';
export * from './icons.ts';
export * from './card.ts';
export * from './camera.ts';
export * from './energy.ts';
export * from './media.ts';
export * from './people.ts';

const SOURCE = 'homeassistant/states';

export const states = defineSource({
  id: 'states',
  name: { en: 'Home Assistant', es: 'Home Assistant', de: 'Home Assistant', 'zh-Hant': 'Home Assistant', 'zh-Hans': 'Home Assistant' },
  description: {
    en: 'The states of your Home Assistant entities, live over its WebSocket API (a change shows at once), and the last day of the numeric sensors for the history bars.',
    es: 'Los estados de las entidades de tu Home Assistant, en directo por su API WebSocket (un cambio se ve al momento), y el último día de los sensores numéricos para las barras de histórico.',
    de: 'Die Zustände deiner Home-Assistant-Entitäten, live über die WebSocket-API (eine Änderung ist sofort zu sehen), und der letzte Tag der numerischen Sensoren für die Verlaufsbalken.',
    'zh-Hant': '你的 Home Assistant 實體狀態，透過其 WebSocket API 即時取得（變更會立即顯示），以及數值感測器最近一天的資料，供歷史長條使用。',
    'zh-Hans': '你的 Home Assistant 实体状态，通过其 WebSocket API 实时获取（变化会立即显示），以及数值传感器最近一天的数据，用于历史柱状图。',
  },
  options: t.object({
    url: t.string({
      format: 'url', risk: 'network', placeholder: 'http://homeassistant.local:8123',
      label: { en: 'Home Assistant address', es: 'Dirección de Home Assistant', de: 'Home-Assistant-Adresse', 'zh-Hant': 'Home Assistant 網址', 'zh-Hans': 'Home Assistant 网址' },
      help: { en: 'The one you open in the browser, e.g. http://homeassistant.local:8123 or https://home.example.com.', es: 'La que abres en el navegador, p. ej. http://homeassistant.local:8123 o https://casa.example.com.', de: 'Die, die du im Browser öffnest, z. B. http://homeassistant.local:8123 oder https://zuhause.example.com.', 'zh-Hant': '你在瀏覽器中開啟的網址，例如 http://homeassistant.local:8123 或 https://home.example.com。', 'zh-Hans': '你在浏览器中打开的网址，例如 http://homeassistant.local:8123 或 https://home.example.com。' },
    }),
    token: t.string({
      secret: true,
      label: { en: 'Long-lived access token', es: 'Token de acceso de larga duración', de: 'Langlebiger Zugriffstoken', 'zh-Hant': '長期存取權杖', 'zh-Hans': '长期访问令牌' },
      help: {
        en: 'In Home Assistant: your profile → Security → Long-lived access tokens → Create token. A user that is not an administrator is enough.',
        es: 'En Home Assistant: tu perfil → Seguridad → Tokens de acceso de larga duración → Crear token. Basta un usuario que no sea administrador.',
        de: 'In Home Assistant: dein Profil → Sicherheit → Langlebige Zugriffstoken → Token erstellen. Ein Benutzer ohne Administratorrechte genügt.',
        'zh-Hant': '在 Home Assistant 中：你的個人資料 → 安全性 → 長期存取權杖 → 建立權杖。非管理員使用者即可。',
        'zh-Hans': '在 Home Assistant 中：你的个人资料 → 安全 → 长期访问令牌 → 创建令牌。非管理员用户即可。',
      },
    }),
    entities: t.filter({
      label: { en: 'Entities to read', es: 'Entidades que leer', de: 'Zu lesende Entitäten', 'zh-Hant': '要讀取的實體', 'zh-Hans': '要读取的实体' },
      help: { en: 'Empty = all. Ids or names, with * and !: sensor.*, binary_sensor.*, lock.*, !sensor.*_linkquality.', es: 'Vacío = todas. Ids o nombres, con * y !: sensor.*, binary_sensor.*, lock.*, !sensor.*_linkquality.', de: 'Leer = alle. IDs oder Namen, mit * und !: sensor.*, binary_sensor.*, lock.*, !sensor.*_linkquality.', 'zh-Hant': '留空 = 全部。填 id 或名稱，可用 * 和 !：sensor.*, binary_sensor.*, lock.*, !sensor.*_linkquality。', 'zh-Hans': '留空 = 全部。填 id 或名称，支持 * 和 !：sensor.*, binary_sensor.*, lock.*, !sensor.*_linkquality。' },
    }),
    history: t.filter({
      advanced: true,
      label: { en: 'Entities with history', es: 'Entidades con histórico', de: 'Entitäten mit Verlauf', 'zh-Hant': '保留歷史的實體', 'zh-Hans': '保留历史的实体' },
      help: { en: 'Numeric sensors whose last day is kept for the history bars. Empty = every one with a unit.', es: 'Sensores numéricos de los que se guarda el último día para las barras de histórico. Vacío = todos los que tienen unidad.', de: 'Numerische Sensoren, deren letzter Tag für die Verlaufsbalken gespeichert wird. Leer = alle mit Einheit.', 'zh-Hant': '保留最近一天資料、用於歷史長條的數值感測器。留空 = 所有有單位的感測器。', 'zh-Hans': '保留最近一天数据、用于历史柱状图的数值传感器。留空 = 所有带单位的传感器。' },
    }),
    maxHistory: t.integer({
      default: 100, min: 0, max: 1000, advanced: true,
      label: { en: 'Most entities with history', es: 'Máximo de entidades con histórico', de: 'Höchstzahl an Entitäten mit Verlauf', 'zh-Hant': '保留歷史的實體上限', 'zh-Hans': '保留历史的实体上限' },
      help: { en: 'Each costs a day of five-minute averages in memory (about 300 numbers). 0 = no history.', es: 'Cada una ocupa un día de medias de cinco minutos en memoria (unos 300 números). 0 = sin histórico.', de: 'Jede belegt einen Tag an Fünf-Minuten-Mittelwerten im Speicher (etwa 300 Zahlen). 0 = kein Verlauf.', 'zh-Hant': '每個實體會在記憶體中佔用一天的五分鐘平均值（約 300 個數字）。0 = 不保留歷史。', 'zh-Hans': '每个实体会在内存中占用一天的五分钟平均值（约 300 个数字）。0 = 不保留历史。' },
    }),
  }),
  watch: (ctx, emit) => connect({ url: ctx.options.url, token: ctx.options.token, entities: ctx.options.entities, history: ctx.options.history, maxHistory: ctx.options.maxHistory }, emit, { signal: ctx.signal, log: ctx.log }),
  demo: ({ now, locale }) => demoHome(now, locale),
  // Every entity it reads, by name, grouped by domain: for the entity field and the filters.
  choices: {
    entities: (d: HaData) =>
      Object.values(d?.entities ?? {})
        .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name))
        .map((e) => ({ value: e.id, label: e.name, group: e.domain })),
    // The cameras, for the camera widget; and the motion sensors to go with them.
    cameras: (d: HaData) =>
      Object.values(d?.entities ?? {})
        .filter((e) => e.picture)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => ({ value: e.id, label: e.name, group: e.domain })),
    // Doorbells: event entities (their state is when they last rang) and binary sensors.
    doorbells: (d: HaData) =>
      Object.values(d?.entities ?? {})
        .filter((e) => (e.domain === 'event' && (e.deviceClass === 'doorbell' || /ding|ring|doorbell|timbre/i.test(e.id))) || (e.domain === 'binary_sensor' && /ding|ring|doorbell|timbre/i.test(e.id)))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => ({ value: e.id, label: e.name, group: e.domain })),
    people: (d: HaData) =>
      Object.values(d?.entities ?? {})
        .filter((e) => e.domain === 'person')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => ({ value: e.id, label: e.name })),
    players: (d: HaData) =>
      Object.values(d?.entities ?? {})
        .filter((e) => e.domain === 'media_player')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => ({ value: e.id, label: e.name })),
    // Power sensors, for the energy flow.
    power: (d: HaData) =>
      Object.values(d?.entities ?? {})
        .filter((e) => e.deviceClass === 'power' || ['W', 'kW', 'MW'].includes(e.unit ?? ''))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => ({ value: e.id, label: e.name })),
    motion: (d: HaData) =>
      Object.values(d?.entities ?? {})
        .filter((e) => e.domain === 'binary_sensor' && ['motion', 'occupancy', 'presence'].includes(e.deviceClass ?? ''))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => ({ value: e.id, label: e.name })),
  },
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
    drawMessage(g, box, ctx, tr({ en: 'Home Assistant not set up', es: 'Home Assistant sin configurar', de: 'Home Assistant nicht eingerichtet', 'zh-Hant': 'Home Assistant 尚未設定', 'zh-Hans': 'Home Assistant 尚未设置' }), tr({ en: 'Set its address and a token in Settings → Data sources', es: 'Pon su dirección y un token en Ajustes → Fuentes de datos', de: 'Adresse und Token unter Einstellungen → Datenquellen eintragen', 'zh-Hant': '請在「設定 → 資料來源」中填入其網址和權杖', 'zh-Hans': '请在“设置 → 数据源”中填写其网址和令牌' }));
    return null;
  }
  if (data.state === 'connecting') {
    drawMessage(g, box, ctx, tr({ en: 'Connecting to Home Assistant…', es: 'Conectando con Home Assistant…', de: 'Verbinde mit Home Assistant…', 'zh-Hant': '正在連線 Home Assistant…', 'zh-Hans': '正在连接 Home Assistant…' }));
    return null;
  }
  if (data.state === 'error' && !Object.keys(data.entities).length) {
    drawMessage(g, box, ctx, tr({ en: 'Home Assistant unreachable', es: 'Home Assistant no responde', de: 'Home Assistant nicht erreichbar', 'zh-Hant': 'Home Assistant 無法連線', 'zh-Hans': 'Home Assistant 无法连接' }), errorHint(data.error, tr));
    return null;
  }
  if (data.state === 'ok') return box;
  // Offline (or refused) with the last states known: show them, and say so.
  const { colors, fonts } = ctx.theme;
  const s = Math.max(10, Math.round(Math.min(18, box.h * 0.12)));
  const hint = data.since ? `${tr({ en: 'offline since', es: 'sin conexión desde las', de: 'offline seit', 'zh-Hant': '離線始於', 'zh-Hans': '离线始于' })} ${ctx.fmt.time(data.since)}` : tr({ en: 'offline', es: 'sin conexión', de: 'offline', 'zh-Hant': '離線', 'zh-Hans': '离线' });
  ctx.kit.drawTracked(g, ctx.kit.truncate(g, hint, box.w, { size: s, family: fonts.sans }), box.x + box.w, box.y + box.h - s * 0.25, { size: s, family: fonts.sans, color: colors.warn, align: 'right' });
  return { ...box, h: box.h - s * 1.4 };
}

/** States that come in, as opposed to a card waiting for its connection. */
const live = (d: HaData | undefined): d is HaData => !!d && (d.state === 'ok' || d.state === 'offline' || (d.state === 'error' && Object.keys(d.entities).length > 0));

const batteryFields = () => ({
  batteryWarn: t.integer({ default: 20, min: 0, max: 100, unit: '%', advanced: true, label: { en: 'Battery warning at', es: 'Batería en aviso desde', de: 'Batteriewarnung ab', 'zh-Hant': '電池警告門檻', 'zh-Hans': '电池警告阈值' } }),
  batteryAlert: t.integer({ default: 10, min: 0, max: 100, unit: '%', advanced: true, label: { en: 'Battery alert at', es: 'Batería en alerta desde', de: 'Batteriealarm ab', 'zh-Hant': '電池警報門檻', 'zh-Hans': '电池告警阈值' } }),
});

/* ---------- one entity ---------- */

export const entity = defineWidget({
  id: 'entity',
  name: { en: 'Entity', es: 'Entidad', de: 'Entität', 'zh-Hant': '實體', 'zh-Hans': '实体' },
  description: {
    en: 'One Home Assistant entity in big: a temperature, the power the house draws, a door, the thermostat. Numeric sensors can show their last hours as bars, and turn amber or red past thresholds of your own.',
    es: 'Una entidad de Home Assistant en grande: una temperatura, lo que consume la casa, una puerta, el termostato. Los sensores numéricos pueden mostrar sus últimas horas en barras y ponerse en ámbar o rojo al pasar los umbrales que elijas.',
    de: 'Eine Home-Assistant-Entität in groß: eine Temperatur, der Stromverbrauch des Hauses, eine Tür, das Thermostat. Numerische Sensoren können ihre letzten Stunden als Balken zeigen und jenseits eigener Schwellenwerte gelb oder rot werden.',
    'zh-Hant': '以大字顯示一個 Home Assistant 實體：溫度、家中的用電功率、一扇門、溫控器。數值感測器可用長條顯示最近幾小時，超過你設定的門檻時會變成琥珀色或紅色。',
    'zh-Hans': '以大字显示一个 Home Assistant 实体：温度、家里的用电功率、一扇门、温控器。数值传感器可用柱状图显示最近几小时，超过你设定的阈值时会变为琥珀色或红色。',
  },
  icon: 'gauge',
  category: 'info',
  tags: ['home assistant', 'smart home', 'sensor'],
  size: { min: { w: 140, h: 80 }, preferred: { w: 320, h: 200 } },
  sources: [SOURCE],
  options: t.object({
    entity: t.string({
      choices: { source: SOURCE, list: 'entities' },
      placeholder: 'sensor.living_room_temperature',
      label: { en: 'Entity', es: 'Entidad', de: 'Entität', 'zh-Hant': '實體', 'zh-Hans': '实体' },
      help: { en: 'Its id, as in Home Assistant → Settings → Devices & services → Entities.', es: 'Su id, como en Home Assistant → Ajustes → Dispositivos y servicios → Entidades.', de: 'Ihre ID, wie unter Home Assistant → Einstellungen → Geräte & Dienste → Entitäten.', 'zh-Hant': '它的 id，即 Home Assistant → 設定 → 裝置與服務 → 實體中所列的。', 'zh-Hans': '它的 id，即 Home Assistant → 设置 → 设备与服务 → 实体中所列的。' },
    }),
    name: t.string({ label: { en: 'Name', es: 'Nombre', de: 'Name', 'zh-Hant': '名稱', 'zh-Hans': '名称' }, help: { en: 'Empty = the name in Home Assistant.', es: 'Vacío = el nombre en Home Assistant.', de: 'Leer = der Name in Home Assistant.', 'zh-Hant': '留空 = 使用 Home Assistant 中的名稱。', 'zh-Hans': '留空 = 使用 Home Assistant 中的名称。' } }),
    showName: t.boolean({ default: true, label: { en: 'Show the name', es: 'Mostrar el nombre', de: 'Namen anzeigen', 'zh-Hant': '顯示名稱', 'zh-Hans': '显示名称' } }),
    showHistory: t.boolean({ default: true, label: { en: 'Show the history', es: 'Mostrar el histórico', de: 'Verlauf anzeigen', 'zh-Hant': '顯示歷史', 'zh-Hans': '显示历史' }, help: { en: 'Numeric sensors only, when the source keeps their history.', es: 'Solo sensores numéricos cuyo histórico guarda la fuente.', de: 'Nur numerische Sensoren, deren Verlauf die Datenquelle speichert.', 'zh-Hant': '僅限數值感測器，且資料來源有保留其歷史時。', 'zh-Hans': '仅限数值传感器，且数据源保留了其历史时。' } }),
    historyMs: t.duration({ default: 24 * 3_600_000, min: 3_600_000, max: 24 * 3_600_000, label: { en: 'History span', es: 'Periodo del histórico', de: 'Verlaufszeitraum', 'zh-Hant': '歷史範圍', 'zh-Hans': '历史范围' } }),
    decimals: t.integer({ default: -1, min: -1, max: 4, advanced: true, label: { en: 'Decimals', es: 'Decimales', de: 'Nachkommastellen', 'zh-Hant': '小數位數', 'zh-Hans': '小数位数' }, help: { en: '-1 = automatic: fewer as the number grows.', es: '-1 = automático: menos cuanto mayor es el número.', de: '-1 = automatisch: weniger, je größer die Zahl.', 'zh-Hant': '-1 = 自動：數字越大，小數位越少。', 'zh-Hans': '-1 = 自动：数字越大，小数位越少。' } }),
    thresholds: t.enum(['off', 'above', 'below'], {
      default: 'off',
      label: { en: 'Thresholds', es: 'Umbrales', de: 'Schwellenwerte', 'zh-Hant': '門檻', 'zh-Hans': '阈值' },
      labels: { off: { en: 'Off', es: 'No', de: 'Aus', 'zh-Hant': '關閉', 'zh-Hans': '关闭' }, above: { en: 'Warn above', es: 'Avisar por encima', de: 'Warnen über', 'zh-Hant': '高於時警告', 'zh-Hans': '高于时警告' }, below: { en: 'Warn below', es: 'Avisar por debajo', de: 'Warnen unter', 'zh-Hant': '低於時警告', 'zh-Hans': '低于时警告' } },
    }),
    warn: t.number({ default: 0, min: -1e6, max: 1e6, label: { en: 'Warning (amber) at', es: 'Aviso (ámbar) en', de: 'Warnung (gelb) bei', 'zh-Hant': '警告（琥珀色）門檻', 'zh-Hans': '警告（琥珀色）阈值' } }),
    alert: t.number({ default: 0, min: -1e6, max: 1e6, label: { en: 'Alert (red) at', es: 'Alerta (rojo) en', de: 'Alarm (rot) bei', 'zh-Hant': '警報（紅色）門檻', 'zh-Hans': '告警（红色）阈值' }, help: { en: 'Red, and the widget keeps its tile.', es: 'Rojo, y el widget se queda con su tesela.', de: 'Rot, und das Widget behält seine Kachel.', 'zh-Hant': '紅色，且小工具會保有其方格。', 'zh-Hans': '红色，且小组件会保留其格子。' } }),
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
    if (!options.entity) return drawMessage(g, box, ctx, tr({ en: 'Choose an entity', es: 'Elige una entidad', de: 'Entität wählen', 'zh-Hant': '選擇實體', 'zh-Hans': '选择实体' }), tr({ en: 'Its id in the inspector, e.g. sensor.living_room_temperature', es: 'Su id en el inspector, p. ej. sensor.living_room_temperature', de: 'Ihre ID im Inspektor, z. B. sensor.living_room_temperature', 'zh-Hant': '在檢查器中填入其 id，例如 sensor.living_room_temperature', 'zh-Hans': '在检查器中填写其 id，例如 sensor.living_room_temperature' }));
    if (!data.entities[options.entity]) return drawMessage(g, box, ctx, tr({ en: 'Entity not found', es: 'Entidad no encontrada', de: 'Entität nicht gefunden', 'zh-Hant': '找不到實體', 'zh-Hans': '找不到实体' }), options.entity);
    renderEntity(g, ctx, data, box);
  },
  demo: ({ now, locale }) => ({ ...demo({ now, locale }), options: { entity: 'sensor.living_room_temperature' } }),
});

/* ---------- a list of entities ---------- */

export const entities = defineWidget({
  id: 'entities',
  name: { en: 'Entities', es: 'Entidades', de: 'Entitäten', 'zh-Hant': '實體', 'zh-Hans': '实体' },
  description: {
    en: 'A list of Home Assistant entities and their states, picked by id or name with patterns (sensor.*_temperature, light.*). Open doors, low batteries and alarms are coloured; the rest stays quiet.',
    es: 'Una lista de entidades de Home Assistant con sus estados, elegidas por id o nombre con patrones (sensor.*_temperature, light.*). Puertas abiertas, baterías bajas y alarmas llevan color; el resto, discreto.',
    de: 'Eine Liste von Home-Assistant-Entitäten mit ihren Zuständen, ausgewählt nach ID oder Name mit Mustern (sensor.*_temperature, light.*). Offene Türen, schwache Batterien und Alarme sind farbig; der Rest bleibt unauffällig.',
    'zh-Hant': '一份 Home Assistant 實體及其狀態的清單，依 id 或名稱以萬用字元挑選（sensor.*_temperature, light.*）。開著的門、電量低的電池和警報會以顏色標示；其餘保持低調。',
    'zh-Hans': '一个 Home Assistant 实体及其状态的列表，按 id 或名称用通配符挑选（sensor.*_temperature, light.*）。开着的门、电量低的电池和警报会用颜色标出；其余保持低调。',
  },
  icon: 'list',
  category: 'info',
  tags: ['home assistant', 'smart home'],
  size: { min: { w: 220, h: 90 }, preferred: { w: 480, h: 260 } },
  sources: [SOURCE],
  options: t.object({
    ...listOptions({ layouts: ['one-line', 'detailed'] }),
    entities: t.filter({
      choices: { source: SOURCE, list: 'entities' },
      label: { en: 'Entities', es: 'Entidades', de: 'Entitäten', 'zh-Hant': '實體', 'zh-Hans': '实体' },
      help: { en: 'Ids or names, in the order to list them: sensor.*_temperature, light.*, *kitchen*, !light.porch. Empty = all.', es: 'Ids o nombres, en el orden en que listarlas: sensor.*_temperature, light.*, *cocina*, !light.porch. Vacío = todas.', de: 'IDs oder Namen, in der Reihenfolge der Liste: sensor.*_temperature, light.*, *küche*, !light.porch. Leer = alle.', 'zh-Hant': 'id 或名稱，依列出的順序：sensor.*_temperature, light.*, *kitchen*, !light.porch。留空 = 全部。', 'zh-Hans': 'id 或名称，按列出的顺序：sensor.*_temperature, light.*, *kitchen*, !light.porch。留空 = 全部。' },
    }),
    hideOff: t.boolean({ label: { en: 'Only what is on, open or wrong', es: 'Solo lo encendido, abierto o con problemas', de: 'Nur was an, offen oder gestört ist', 'zh-Hant': '只顯示開著或異常的', 'zh-Hans': '只显示开着或异常的' }, help: { en: 'Leaves out what is off or closed. Numbers always stay.', es: 'Deja fuera lo apagado o cerrado. Los números se quedan siempre.', de: 'Lässt weg, was aus oder geschlossen ist. Zahlen bleiben immer.', 'zh-Hant': '略過已關閉或關上的項目。數值一律保留。', 'zh-Hans': '略过已关闭或关上的项目。数值始终保留。' } }),
    hideUnavailable: t.boolean({ label: { en: 'Hide unavailable entities', es: 'Ocultar las entidades no disponibles', de: 'Nicht verfügbare Entitäten ausblenden', 'zh-Hant': '隱藏無法使用的實體', 'zh-Hans': '隐藏不可用的实体' } }),
    decimals: t.integer({ default: -1, min: -1, max: 4, advanced: true, label: { en: 'Decimals', es: 'Decimales', de: 'Nachkommastellen', 'zh-Hant': '小數位數', 'zh-Hans': '小数位数' }, help: { en: '-1 = automatic.', es: '-1 = automático.', de: '-1 = automatisch.', 'zh-Hant': '-1 = 自動。', 'zh-Hans': '-1 = 自动。' } }),
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
    if (!list.length) return drawEmpty(g, { ...ctx, box }, tr({ en: 'No entities match', es: 'Ninguna entidad coincide', de: 'Keine passenden Entitäten', 'zh-Hant': '沒有符合的實體', 'zh-Hans': '没有匹配的实体' }));
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
  name: { en: 'Home: needs you', es: 'Casa: te necesita', de: 'Zuhause: braucht dich', 'zh-Hant': '居家：需要你處理', 'zh-Hans': '家里：需要你处理' },
  description: {
    en: 'Only what needs you at home: smoke, a leak or the alarm in red (and it keeps its tile until they stop), then doors and windows left open, unlocked locks, low batteries and problems. Hides itself when all is well.',
    es: 'Solo lo que te necesita en casa: humo, una fuga o la alarma en rojo (y se queda con su tesela hasta que paren), luego puertas y ventanas abiertas, cerraduras sin cerrar, baterías bajas y problemas. Se oculta cuando todo va bien.',
    de: 'Nur, was zu Hause deine Aufmerksamkeit braucht: Rauch, ein Leck oder die Alarmanlage in Rot (dann behält es seine Kachel, bis es aufhört), danach offene Türen und Fenster, entriegelte Schlösser, schwache Batterien und Probleme. Blendet sich aus, wenn alles in Ordnung ist.',
    'zh-Hant': '只顯示家中需要你處理的事：煙霧、漏水或警報觸發（紅色，且會一直保有其方格直到解除），接著是沒關的門窗、未上鎖的鎖、電量低的電池和異常。一切正常時會自動隱藏。',
    'zh-Hans': '只显示家里需要你处理的事：烟雾、漏水或警报触发（红色，并会一直占用其格子直到解除），然后是没关的门窗、未上锁的锁、电量低的电池和异常。一切正常时会自动隐藏。',
  },
  icon: 'shield-alert',
  category: 'info',
  tags: ['home assistant', 'smart home', 'alerts'],
  size: { min: { w: 220, h: 90 }, preferred: { w: 480, h: 220 } },
  sources: [SOURCE],
  options: t.object({
    ...listOptions({ layouts: ['one-line', 'detailed'] }),
    entities: t.filter({ choices: { source: SOURCE, list: 'entities' }, label: { en: 'Entities', es: 'Entidades', de: 'Entitäten', 'zh-Hant': '實體', 'zh-Hans': '实体' }, help: { en: 'Empty = all. Leave out the ones that are fine open with !: !binary_sensor.patio_door.', es: 'Vacío = todas. Deja fuera con ! las que pueden estar abiertas: !binary_sensor.patio_door.', de: 'Leer = alle. Mit ! weglassen, was offen sein darf: !binary_sensor.patio_door.', 'zh-Hant': '留空 = 全部。可以開著的，用 ! 排除：!binary_sensor.patio_door。', 'zh-Hans': '留空 = 全部。可以开着的，用 ! 排除：!binary_sensor.patio_door。' } }),
    includeOpenings: t.boolean({ default: true, label: { en: 'Doors, windows and locks', es: 'Puertas, ventanas y cerraduras', de: 'Türen, Fenster und Schlösser', 'zh-Hant': '門、窗和鎖', 'zh-Hans': '门、窗和锁' }, help: { en: 'Open doors, windows, garage doors and gates; unlocked locks.', es: 'Puertas, ventanas, garajes y cancelas abiertas; cerraduras sin cerrar.', de: 'Offene Türen, Fenster, Garagentore und Tore; entriegelte Schlösser.', 'zh-Hant': '開著的門、窗、車庫門和大門；未上鎖的鎖。', 'zh-Hans': '开着的门、窗、车库门和大门；未上锁的锁。' } }),
    openMs: t.duration({ default: 0, label: { en: 'Open for at least', es: 'Abierta al menos', de: 'Offen seit mindestens', 'zh-Hant': '已開啟至少', 'zh-Hans': '已打开至少' }, help: { en: 'A door counts once it has been open this long. 0 = at once.', es: 'Una puerta cuenta cuando lleva abierta este tiempo. 0 = al momento.', de: 'Eine Tür zählt, sobald sie so lange offen ist. 0 = sofort.', 'zh-Hant': '門開著這麼久之後才算數。0 = 立即。', 'zh-Hans': '门开着这么久之后才算。0 = 立即。' } }),
    includeBatteries: t.boolean({ default: true, label: { en: 'Low batteries', es: 'Baterías bajas', de: 'Schwache Batterien', 'zh-Hant': '電量低的電池', 'zh-Hans': '电量低的电池' } }),
    includeProblems: t.boolean({ default: true, label: { en: 'Problems', es: 'Problemas', de: 'Probleme', 'zh-Hant': '異常', 'zh-Hans': '异常' }, help: { en: 'Problem and tamper sensors, lost connections, a vacuum in error.', es: 'Sensores de problema y manipulación, conexiones perdidas, un robot aspirador en error.', de: 'Problem- und Manipulationssensoren, verlorene Verbindungen, ein Saugroboter mit Fehler.', 'zh-Hant': '異常與防拆感測器、連線中斷、出錯的掃地機器人。', 'zh-Hans': '异常和防拆传感器、连接中断、出错的扫地机器人。' } }),
    includeUnavailable: t.boolean({ label: { en: 'Unavailable devices', es: 'Dispositivos no disponibles', de: 'Nicht verfügbare Geräte', 'zh-Hant': '無法使用的裝置', 'zh-Hans': '不可用的设备' } }),
    includeUpdates: t.boolean({ label: { en: 'Updates available', es: 'Actualizaciones disponibles', de: 'Verfügbare Updates', 'zh-Hant': '有可用更新', 'zh-Hans': '有可用更新' } }),
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
    if (!list.length) return drawEmpty(g, { ...ctx, box }, tr({ en: 'All well at home', es: 'Todo en orden en casa', de: 'Zuhause alles in Ordnung', 'zh-Hant': '家中一切正常', 'zh-Hans': '家里一切正常' }));
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
  name: { en: 'Home Assistant', es: 'Home Assistant', de: 'Home Assistant', 'zh-Hant': 'Home Assistant', 'zh-Hans': 'Home Assistant' },
  version: '0.2.3',
  languages: ['en', 'es', 'de', 'zh-Hant', 'zh-Hans'],
  sdk: '^0.2.0',
  permissions: { network: ['user'] },
  description: {
    en: 'Home Assistant on the panel, live over its WebSocket API: any entity in big with its history, lists of entities, what needs you at home (doors left open, low batteries, leaks, the alarm), your cameras (with the doorbell), the energy flow, what\'s playing and who is home.',
    es: 'Home Assistant en el panel, en directo por su API WebSocket: cualquier entidad en grande con su histórico, listas de entidades, lo que te necesita en casa (puertas abiertas, baterías bajas, fugas, la alarma), tus cámaras (con el timbre), el flujo de energía, lo que suena y quién está en casa.',
    de: 'Home Assistant auf dem Panel, live über die WebSocket-API: jede Entität in groß mit Verlauf, Listen von Entitäten, was zu Hause deine Aufmerksamkeit braucht (offene Türen, schwache Batterien, Lecks, die Alarmanlage), deine Kameras (mit Türklingel), der Energiefluss, was gerade läuft und wer zu Hause ist.',
    'zh-Hant': '在面板上顯示 Home Assistant，透過其 WebSocket API 即時更新：以大字顯示任一實體及其歷史、實體清單、家中需要你處理的事（沒關的門、電量低的電池、漏水、警報）、你的攝影機（含門鈴）、能源流向、正在播放的內容，以及誰在家。',
    'zh-Hans': '在副屏上显示 Home Assistant，通过其 WebSocket API 实时更新：以大字显示任一实体及其历史、实体列表、家里需要你处理的事（没关的门、电量低的电池、漏水、警报）、你的摄像头（含门铃）、能源流向、正在播放的内容，以及谁在家。',
  },
  icon: 'house',
  widgets: [entity, entities, attention, camera, energy, media, people],
  sources: [states],
});
