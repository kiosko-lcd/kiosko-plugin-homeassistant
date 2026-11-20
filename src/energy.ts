/**
 * Where the house's power comes from and goes, right now: the grid, the solar
 * panels and the battery around the house, with a line for every flow that
 * runs (thicker the more it carries, with dots running along it) and today's
 * energy under each one.
 *
 * Power comes from the sensors chosen in the widget or, when not chosen, the
 * ones set in Home Assistant's Energy dashboard (2025.12 and later); today's
 * kWh from the dashboard's statistics. Just a grid sensor is enough: the
 * diagram has only the parts it has data for.
 */
import { defineWidget, t } from '@kiosko/sdk';
import { alpha, drawMessage } from './draw.ts';
import { demoHome, formatNumber, numericState, type EnergyToday, type Entity, type HaData } from './ha.ts';
import { drawIcon } from './icons.ts';
import type { IconName } from './icon-paths.ts';

const SOURCE = 'homeassistant/states';
const dataOf = (sources: Record<string, unknown>) => sources[SOURCE] as HaData | undefined;

/** Power in watts, signed as the widget wants it: grid + = bought, battery + = discharging. */
export interface Powers {
  grid?: number;
  solar?: number;
  battery?: number;
}

export interface Flows {
  solarHome: number;
  solarGrid: number;
  solarBattery: number;
  gridHome: number;
  gridBattery: number;
  batteryHome: number;
  batteryGrid: number;
  /** What the house uses. */
  home: number;
}

/** Splits the power among the flows, as Home Assistant's energy card does: the sun first to the house, then the battery, then the grid. */
export function flows(p: Powers): Flows {
  const solar = Math.max(0, p.solar ?? 0);
  const gridIn = Math.max(0, p.grid ?? 0);
  const gridOut = Math.max(0, -(p.grid ?? 0));
  const batOut = Math.max(0, p.battery ?? 0);
  const batIn = Math.max(0, -(p.battery ?? 0));
  const solarBattery = Math.min(solar, batIn);
  const gridBattery = Math.min(gridIn, batIn - solarBattery);
  const solarGrid = Math.min(solar - solarBattery, gridOut);
  const batteryGrid = Math.min(batOut, gridOut - solarGrid);
  const solarHome = Math.max(0, solar - solarBattery - solarGrid);
  const gridHome = Math.max(0, gridIn - gridBattery);
  const batteryHome = Math.max(0, batOut - batteryGrid);
  return { solarHome, solarGrid, solarBattery, gridHome, gridBattery, batteryHome, batteryGrid, home: solarHome + gridHome + batteryHome };
}

/** A power sensor's state in watts (kW and MW converted), or undefined. */
export function watts(e: Entity | undefined): number | undefined {
  if (!e) return undefined;
  const n = numericState(e);
  if (n === undefined) return undefined;
  const u = (e.unit ?? 'W').trim();
  return u === 'kW' ? n * 1000 : u === 'MW' ? n * 1e6 : n;
}

/** `850 W`, `1,53 kW`. */
export function formatPower(w: number, locale: string): string {
  const a = Math.abs(w);
  return a < 1000 ? `${formatNumber(Math.round(a), locale, 0)} W` : `${formatNumber(a / 1000, locale, a < 10_000 ? 2 : 1)} kW`;
}

/** `4,2 kWh`. */
export const formatEnergy = (kwh: number, locale: string) => `${formatNumber(kwh, locale, kwh < 10 ? 1 : 0)} kWh`;

/** What the house used today: what came in, less what went out. */
export function homeToday(e: EnergyToday): number | undefined {
  if (e.gridIn === undefined && e.solar === undefined && e.batteryOut === undefined) return undefined;
  return Math.max(0, (e.gridIn ?? 0) + (e.solar ?? 0) + (e.batteryOut ?? 0) - (e.gridOut ?? 0) - (e.batteryIn ?? 0));
}

/** Below this a flow is noise: no line, no dots. */
const IDLE_W = 10;

export const energy = defineWidget({
  id: 'energy',
  name: { en: 'Energy flow', es: 'Flujo de energía', 'zh-Hant': '能源流向', 'zh-Hans': '能源流向' },
  description: {
    en: 'Where the power comes from and goes, now: the grid, the solar panels and the battery around the house, a line for every flow (thicker the more it carries) and today\'s kWh from the Energy dashboard. A grid sensor is enough to start.',
    es: 'De dónde viene la energía y adónde va, ahora: la red, las placas y la batería alrededor de la casa, una línea por cada flujo (más gruesa cuanto más lleva) y los kWh de hoy del panel de Energía. Basta un sensor de la red para empezar.',
    'zh-Hant': '電力現在從哪裡來、往哪裡去：房子周圍是電網、太陽能板和電池，每股流向一條線（流量越大越粗），以及能源儀表板中今天的 kWh。只要有電網感測器就能開始。',
    'zh-Hans': '电力现在从哪里来、到哪里去：房子周围是电网、太阳能板和电池，每股流向一条线（流量越大越粗），以及能源仪表盘中今天的 kWh。只需一个电网传感器即可开始。',
  },
  icon: 'zap',
  category: 'info',
  tags: ['home assistant', 'energy', 'solar', 'battery'],
  size: { min: { w: 220, h: 140 }, preferred: { w: 420, h: 300 } },
  sources: [SOURCE],
  options: t.object({
    grid: t.string({
      choices: { source: SOURCE, list: 'power' },
      placeholder: 'sensor.grid_power',
      label: { en: 'Grid power', es: 'Potencia de la red', 'zh-Hant': '電網功率', 'zh-Hans': '电网功率' },
      help: { en: 'W or kW, positive while buying. Empty = the one in the Energy dashboard.', es: 'W o kW, positiva al comprar. Vacío = la del panel de Energía.', 'zh-Hant': 'W 或 kW，買電時為正。留空 = 使用能源儀表板中的設定。', 'zh-Hans': 'W 或 kW，买电时为正。留空 = 使用能源仪表盘中的设置。' },
    }),
    gridExportPositive: t.boolean({ label: { en: 'The grid sensor is positive while selling', es: 'El sensor de la red es positivo al vender', 'zh-Hant': '電網感測器在賣電時為正', 'zh-Hans': '电网传感器在卖电时为正' } }),
    solar: t.string({ choices: { source: SOURCE, list: 'power' }, placeholder: 'sensor.solar_power', label: { en: 'Solar power', es: 'Potencia solar', 'zh-Hant': '太陽能功率', 'zh-Hans': '太阳能功率' }, help: { en: 'Empty = the one in the Energy dashboard, or none.', es: 'Vacío = la del panel de Energía, o ninguna.', 'zh-Hant': '留空 = 使用能源儀表板中的設定，或不使用。', 'zh-Hans': '留空 = 使用能源仪表盘中的设置，或不使用。' } }),
    battery: t.string({ choices: { source: SOURCE, list: 'power' }, placeholder: 'sensor.battery_power', label: { en: 'Battery power', es: 'Potencia de la batería', 'zh-Hant': '電池功率', 'zh-Hans': '电池功率' }, help: { en: 'Positive while discharging. Empty = the one in the Energy dashboard, or none.', es: 'Positiva al descargar. Vacío = la del panel de Energía, o ninguna.', 'zh-Hant': '放電時為正。留空 = 使用能源儀表板中的設定，或不使用。', 'zh-Hans': '放电时为正。留空 = 使用能源仪表盘中的设置，或不使用。' } }),
    batteryChargePositive: t.boolean({ label: { en: 'The battery sensor is positive while charging', es: 'El sensor de la batería es positivo al cargar', 'zh-Hant': '電池感測器在充電時為正', 'zh-Hans': '电池传感器在充电时为正' } }),
    batteryLevel: t.string({ choices: { source: SOURCE, list: 'entities' }, placeholder: 'sensor.battery_state_of_charge', label: { en: 'Battery level', es: 'Nivel de la batería', 'zh-Hant': '電池電量', 'zh-Hans': '电池电量' }, help: { en: 'Its %, shown in the battery.', es: 'Su %, que se ve en la batería.', 'zh-Hant': '其百分比，顯示在電池圖示中。', 'zh-Hans': '其百分比，显示在电池图标中。' } }),
    showToday: t.boolean({ default: true, label: { en: "Today's energy", es: 'La energía de hoy', 'zh-Hant': "今天的電量", 'zh-Hans': "今天的电量" }, help: { en: 'From the Energy dashboard, under each part.', es: 'Del panel de Energía, bajo cada parte.', 'zh-Hant': '來自能源儀表板，顯示在各部分下方。', 'zh-Hans': '来自能源仪表盘，显示在各部分下方。' } }),
    moving: t.boolean({ default: true, label: { en: 'Moving dots', es: 'Puntos en movimiento', 'zh-Hant': '流動光點', 'zh-Hans': '流动光点' }, help: { en: 'Repaints the tile every second.', es: 'Vuelve a pintar la tesela cada segundo.', 'zh-Hant': '每秒重繪方格一次。', 'zh-Hans': '每秒重绘格子一次。' } }),
  }),
  redraw: ({ options }) => (options.moving ? 'second' : 'minute'),
  render(g, ctx) {
    const { options, sources, t: tr, theme, locale } = ctx;
    const d = dataOf(sources);
    const box = ctx.box;
    if (!d || d.state === 'unconfigured') return drawMessage(g, box, ctx, tr({ en: 'Home Assistant not set up', es: 'Home Assistant sin configurar', 'zh-Hant': 'Home Assistant 尚未設定', 'zh-Hans': 'Home Assistant 尚未设置' }), tr({ en: 'Set its address and a token in Settings → Data sources', es: 'Pon su dirección y un token en Ajustes → Fuentes de datos', 'zh-Hant': '請在「設定 → 資料來源」中填入其網址和權杖', 'zh-Hans': '请在“设置 → 数据源”中填写其网址和令牌' }));
    if (d.state === 'connecting') return drawMessage(g, box, ctx, tr({ en: 'Connecting to Home Assistant…', es: 'Conectando con Home Assistant…', 'zh-Hant': '正在連線 Home Assistant…', 'zh-Hans': '正在连接 Home Assistant…' }));
    const ids = { grid: options.grid || d.energy?.power?.grid, solar: options.solar || d.energy?.power?.solar, battery: options.battery || d.energy?.power?.battery };
    const raw = { grid: watts(ids.grid ? d.entities[ids.grid] : undefined), solar: watts(ids.solar ? d.entities[ids.solar] : undefined), battery: watts(ids.battery ? d.entities[ids.battery] : undefined) };
    if (raw.grid === undefined && raw.solar === undefined && raw.battery === undefined) {
      return drawMessage(g, box, ctx, tr({ en: 'Choose the power sensors', es: 'Elige los sensores de potencia', 'zh-Hant': '選擇功率感測器', 'zh-Hans': '选择功率传感器' }), tr({ en: 'At least the grid one, in the inspector (or set them in the Energy dashboard of Home Assistant).', es: 'Al menos el de la red, en el inspector (o ponlos en el panel de Energía de Home Assistant).', 'zh-Hant': '至少要有電網的，在檢查器中設定（或在 Home Assistant 的能源儀表板中設定）。', 'zh-Hans': '至少要有电网的，在检查器中设置（或在 Home Assistant 的能源仪表盘中设置）。' }));
    }
    const p: Powers = {
      ...(raw.grid !== undefined ? { grid: options.gridExportPositive ? -raw.grid : raw.grid } : {}),
      ...(raw.solar !== undefined ? { solar: raw.solar } : {}),
      ...(raw.battery !== undefined ? { battery: options.batteryChargePositive ? -raw.battery : raw.battery } : {}),
    };
    const f = flows(p);
    const level = options.batteryLevel ? numericState(d.entities[options.batteryLevel] ?? { state: '' }) : undefined;
    const today = options.showToday ? d.energy : undefined;
    const { colors } = theme;
    const C = { grid: colors.info, solar: colors.warn, battery: colors.ok, home: colors.ink };
    const has = { solar: p.solar !== undefined, battery: p.battery !== undefined, grid: p.grid !== undefined };

    // Where each part goes: the house on the right, the grid on the left, the sun above, the battery below.
    const rowH = Math.max(11, Math.min(20, box.h * 0.07));
    const textH = rowH * (today ? 2.5 : 1.4);
    const r = Math.max(10, Math.min(box.w * 0.085, box.h / (has.solar && has.battery ? 5.4 : has.solar || has.battery ? 3.6 : 2.6)));
    // The grid and the house in the middle row, their text under them.
    const midY = has.solar && has.battery ? box.y + box.h / 2 - textH * 0.3 : has.solar ? box.y + box.h - textH - r - 4 : has.battery ? box.y + r + 4 : box.y + (box.h - textH) / 2;
    // Not wider than about twice its height: on a wide tile it stays a diagram, centred.
    const span = Math.min(box.w, Math.max(box.h * 2.1, 280));
    const left = box.x + (box.w - span) / 2;
    // Room for the rings' stroke, inside the box.
    const m = r + Math.max(2, r * 0.12) / 2 + 1;
    const at = {
      grid: { x: left + m, y: midY },
      home: { x: left + span - m, y: midY },
      solar: { x: left + span / 2, y: box.y + m },
      battery: { x: left + span / 2, y: box.y + box.h - m },
    };

    // The flows first, under the circles.
    const maxW = Math.max(1000, ...Object.values(f));
    const line = (from: { x: number; y: number }, to: { x: number; y: number }, w: number, color: string, bend: number) => {
      const on = w >= IDLE_W;
      const mx = (from.x + to.x) / 2 + (to.y - from.y) * bend;
      const my = (from.y + to.y) / 2 - (to.x - from.x) * bend;
      g.strokeStyle = on ? alpha(color, 0.75) : alpha(colors.inkFaint, 0.5);
      g.lineWidth = on ? Math.max(1.5, Math.min(r * 0.22, 1.5 + (w / maxW) * r * 0.2)) : 1;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(from.x, from.y);
      g.quadraticCurveTo(mx, my, to.x, to.y);
      g.stroke();
      if (!on) return;
      // Dots along it, one every so far, faster the more it carries.
      const len = Math.hypot(to.x - from.x, to.y - from.y);
      const n = Math.max(2, Math.round(len / (r * 1.4)));
      const speed = 0.12 + 0.35 * Math.min(1, w / maxW);
      const phase = options.moving ? ((ctx.now / 1000) * speed) % 1 : 0.5 / n;
      g.fillStyle = color;
      for (let i = 0; i < n; i++) {
        const tt = (i / n + phase) % 1;
        const x = (1 - tt) ** 2 * from.x + 2 * (1 - tt) * tt * mx + tt ** 2 * to.x;
        const y = (1 - tt) ** 2 * from.y + 2 * (1 - tt) * tt * my + tt ** 2 * to.y;
        g.beginPath();
        g.arc(x, y, Math.max(1.5, g.lineWidth * 0.9), 0, Math.PI * 2);
        g.fill();
      }
    };
    if (has.grid) line(at.grid, at.home, f.gridHome, C.grid, 0);
    if (has.solar) {
      line(at.solar, at.home, f.solarHome, C.solar, -0.12);
      if (has.grid) line(at.solar, at.grid, f.solarGrid, C.solar, 0.12);
      if (has.battery) line(at.solar, at.battery, f.solarBattery, C.solar, 0);
    }
    if (has.battery) {
      line(at.battery, at.home, f.batteryHome, C.battery, 0.12);
      if (has.grid) {
        if (f.gridBattery >= IDLE_W) line(at.grid, at.battery, f.gridBattery, C.grid, 0.12);
        else line(at.battery, at.grid, f.batteryGrid, C.battery, -0.12);
      }
    }

    // The parts: a ring, its icon, its power and today's energy under it.
    const node = (pos: { x: number; y: number }, icon: IconName, color: string, value: string, sub: string[], active: boolean, place: 'below-left' | 'below-right' | 'below' | 'right', fill?: number) => {
      g.fillStyle = theme.colors.surface;
      g.beginPath();
      g.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      g.fill();
      if (fill !== undefined) {
        // The battery's level, as a ring filling clockwise from the top.
        g.strokeStyle = alpha(color, 0.25);
        g.lineWidth = Math.max(2, r * 0.12);
        g.beginPath();
        g.arc(pos.x, pos.y, r, 0, Math.PI * 2);
        g.stroke();
        g.strokeStyle = color;
        g.beginPath();
        g.arc(pos.x, pos.y, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * Math.max(0, Math.min(100, fill))) / 100);
        g.stroke();
      } else {
        g.strokeStyle = active ? color : alpha(color, 0.35);
        g.lineWidth = Math.max(1.5, r * 0.08);
        g.beginPath();
        g.arc(pos.x, pos.y, r, 0, Math.PI * 2);
        g.stroke();
      }
      const s = r * 0.95;
      drawIcon(g, icon, pos.x - s / 2, pos.y - s / 2, s, active ? color : alpha(color, 0.6));
      // Its text: beside the sun (the lines leave it no room below), under the
      // rest, flush with the edge for the parts at the sides.
      const vs = Math.round(rowH);
      const so = { size: Math.round(vs * 0.78), family: theme.fonts.sans, color: theme.colors.inkDim };
      const vo = { size: vs, family: theme.fonts.sansBold, color: active ? theme.colors.ink : theme.colors.inkDim };
      let tx: number, ty: number, align: 'left' | 'right' | 'center', maxTw: number;
      if (place === 'right') [tx, ty, align, maxTw] = [pos.x + r * 1.25, pos.y - vs * 0.1, 'left', box.x + box.w - pos.x - r * 1.3];
      else if (place === 'below-left') [tx, ty, align, maxTw] = [pos.x - r, pos.y + r + vs * 1.15, 'left', span / 2 - r];
      else if (place === 'below-right') [tx, ty, align, maxTw] = [pos.x + r, pos.y + r + vs * 1.15, 'right', span / 2 - r];
      else [tx, ty, align, maxTw] = [pos.x, pos.y + r + vs * 1.15, 'center', span * 0.4];
      ctx.kit.drawTracked(g, ctx.kit.truncate(g, value, maxTw, vo), tx, ty, { ...vo, align });
      sub.forEach((line, i) => ctx.kit.drawTracked(g, ctx.kit.truncate(g, line, maxTw, so), tx, ty + vs * 1.1 * (i + 1), { ...so, align }));
    };
    const kwh = (n: number | undefined) => (n === undefined ? undefined : formatEnergy(n, locale));
    const both = (a?: string, b?: string) => [a, b].filter(Boolean).join('  ');
    if (has.grid) {
      const v = p.grid! >= 0 ? formatPower(p.grid!, locale) : `${formatPower(p.grid!, locale)} ↑`;
      node(at.grid, 'utility-pole', C.grid, v, today ? [both(today.gridIn !== undefined ? `↓ ${kwh(today.gridIn)}` : '', today.gridOut ? `↑ ${kwh(today.gridOut)}` : '')].filter(Boolean) : [], Math.abs(p.grid!) >= IDLE_W, 'below-left');
    }
    if (has.solar) node(at.solar, 'sun', C.solar, formatPower(p.solar!, locale), today?.solar !== undefined ? [kwh(today.solar)!] : [], p.solar! >= IDLE_W, 'right');
    if (has.battery) {
      const b = p.battery!;
      const v = `${formatPower(b, locale)}${b >= IDLE_W ? ' ↓' : b <= -IDLE_W ? ' ↑' : ''}`;
      const sub = level !== undefined ? [`${formatNumber(level, locale, 0)} %`] : today ? [both(today.batteryOut !== undefined ? `↓ ${kwh(today.batteryOut)}` : '', today.batteryIn !== undefined ? `↑ ${kwh(today.batteryIn)}` : '')].filter(Boolean) : [];
      node(at.battery, 'battery', C.battery, v, sub, Math.abs(b) >= IDLE_W, 'right', level);
    }
    const home = today ? homeToday(today) : undefined;
    node(at.home, 'house', C.home, formatPower(f.home, locale), home !== undefined ? [kwh(home)!] : [], f.home >= IDLE_W, 'below-right');

    if (d.state !== 'ok') {
      const s = Math.max(10, Math.round(rowH * 0.8));
      ctx.kit.drawTracked(g, tr({ en: 'offline', es: 'sin conexión', 'zh-Hant': '離線', 'zh-Hans': '离线' }), box.x + box.w, box.y + s, { size: s, family: theme.fonts.sans, color: theme.colors.warn, align: 'right' });
    }
  },
  demo: ({ now, locale }) => ({ sources: { [SOURCE]: demoHome(now, locale) }, options: { grid: 'sensor.grid_power', solar: 'sensor.solar_power', battery: 'sensor.battery_power', batteryLevel: 'sensor.battery_level' } }),
});



