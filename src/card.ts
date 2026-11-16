/**
 * The Entity card, in three shapes:
 *
 * - a number (a sensor): its name, the value in big, how it moved in the
 *   last hour, and its history as a curve; side by side on a wide tile.
 * - a state (a door, a lock, a light, someone): its icon in a tinted halo,
 *   the state in a word and since when.
 * - a thermostat: the room temperature in big, the target and what it is
 *   doing, and a dial.
 */
import type { Box, Graphics, RenderContext } from '@kiosko/sdk';
import { curveScale, drawBadge, drawCurve, drawDial, drawLabel, drawTrend, alpha } from './draw.ts';
import { autoDecimals, formatNumber, isTemperature, levelOf, numericState, stateText, type Entity, type HaData, type Level, type LevelOptions } from './ha.ts';
import { batteryLevel, drawEntityIcon, iconFor } from './icons.ts';

export interface EntityOptions {
  entity: string;
  name: string;
  showName: boolean;
  showHistory: boolean;
  historyMs: number;
  decimals: number;
  thresholds: 'off' | 'above' | 'below';
  warn: number;
  alert: number;
}

type Ctx = RenderContext<EntityOptions, unknown>;
type Colors = Ctx['theme']['colors'];

/** The level a number reaches against the widget's thresholds, or the entity's own level. */
export function thresholdLevel(e: Entity, o: Pick<EntityOptions, 'thresholds' | 'warn' | 'alert'>, levels?: LevelOptions): Level {
  const own = levelOf(e, levels);
  const n = e.domain === 'climate' ? e.current : numericState(e);
  if (o.thresholds === 'off' || n === undefined || own === 'na') return own;
  const past = (lim: number) => (o.thresholds === 'above' ? n >= lim : n <= lim);
  return past(o.alert) ? 'alert' : past(o.warn) ? 'warn' : own;
}

/** The colour of a state: loud only when it asks for the user. */
export function stateColor(level: Level, colors: Colors): string {
  return level === 'alert' ? colors.alert : level === 'warn' ? colors.warn : level === 'on' ? colors.accent : level === 'na' ? colors.inkFaint : colors.inkDim;
}

/** Whether the card shows this entity as a number. */
export const isNumber = (e: Entity) => e.domain !== 'binary_sensor' && e.domain !== 'climate' && numericState(e) !== undefined;

/** The narrowest vertical span the curve may have, so a steady sensor draws a calm line. */
function minSpan(e: Entity, n: number): number {
  if (isTemperature(e.unit)) return 1.5;
  if (e.unit === '%') return 6;
  return Math.max(Math.abs(n) * 0.06, 10 ** -autoDecimals(n));
}

/** The largest size at which `text` (in `family`) plus `extra(size)` fits `w`. */
function fit(g: Graphics, ctx: Ctx, text: string, family: string, start: number, w: number, extra = (_s: number) => 0, tracking = -0.02): number {
  let s = Math.max(8, Math.round(start));
  const width = (sz: number) => ctx.kit.measureTracked(g, text, { size: sz, family, tracking: sz * tracking }) + extra(sz);
  const w0 = width(s);
  if (w0 > w) s = Math.max(8, Math.floor((s * w) / w0));
  while (s > 8 && width(s) > w) s--;
  return s;
}

/** The big value: the number in bold, then its unit smaller and dimmer (or the degree sign, glued). Returns its width. */
function drawValue(g: Graphics, ctx: Ctx, num: string, unit: string, x: number, base: number, size: number, color: string, dry = false): number {
  const { kit, theme } = ctx;
  const glued = isTemperature(unit);
  const big = glued ? `${num}°` : num;
  const o = { size, family: theme.fonts.sansBold, tracking: -size * 0.02, color };
  const w = dry ? kit.measureTracked(g, big, o) : kit.drawTracked(g, big, x, base, o);
  if (glued || !unit) return w;
  const uo = { size: Math.round(size * 0.36), family: theme.fonts.sans, color: theme.colors.inkDim };
  const uw = dry ? kit.measureTracked(g, unit, uo) : kit.drawTracked(g, unit, x + w + size * 0.1, base, uo);
  return w + size * 0.1 + uw;
}

/** The size of the header's label: legible on a small tile, never shouting on a big one. */
const headerSize = (box: Box) => Math.max(11, Math.min(18, Math.round(Math.min(box.h, box.w * 0.7) * 0.085)));

/** The card's header: the entity's icon and its name in small caps. Returns the height used. */
function drawHeader(g: Graphics, ctx: Ctx, e: Entity, box: Box, size: number, color: string): number {
  if (!ctx.options.showName) return 0;
  const icon = size * 1.3;
  // Never above the box: the stroke of the icon's top would spill out.
  drawEntityIcon(g, e, box.x, box.y + Math.max(1, (size * 1.25 - icon) / 2 - size * 0.12), icon, color);
  drawLabel(g, ctx, ctx.options.name || e.name, box.x + icon + size * 0.5, box.y + size * 0.95, size, box.w - icon - size * 0.5);
  return size * 1.25;
}

export function renderEntity(g: Graphics, ctx: Ctx, data: HaData, box: Box): void {
  const e = data.entities[ctx.options.entity]!;
  if (e.domain === 'climate') return renderClimate(g, ctx, e, box);
  if (isNumber(e)) return renderNumber(g, ctx, e, data, box);
  return renderState(g, ctx, e, box);
}

function renderNumber(g: Graphics, ctx: Ctx, e: Entity, data: HaData, box: Box): void {
  const { options, theme, kit, locale, now, t: tr } = ctx;
  const { colors, fonts } = theme;
  const n = numericState(e)!;
  const level = thresholdLevel(e, options);
  const loud = level === 'alert' || level === 'warn';
  const tone = loud ? stateColor(level, colors) : colors.accent;
  const dec = options.decimals;
  const num = formatNumber(n, locale, dec);
  const unit = e.unit ?? '';
  const fmtLike = (v: number) => `${formatNumber(v, locale, dec, n)}${isTemperature(unit) ? '°' : ''}`;

  // History: one point per ~5 px, never more than the five-minute buckets.
  const history = options.showHistory && data.history?.has(e.id) ? data.history : undefined;
  const points = Math.max(12, Math.min(Math.round(options.historyMs / 300_000), Math.floor(box.w / 5)));
  const values = history ? history.values(e.id, now, options.historyMs, points) : [];
  const scale = curveScale(values, minSpan(e, n));
  const hasChart = !!scale && box.h >= 84 && box.w >= 120;
  const wide = hasChart && box.w >= box.h * 2.2;

  // How it moved in the last hour.
  let trend: { up: boolean; text: string } | null = null;
  if (history) {
    const hour = history.values(e.id, now, 3_600_000, 12).filter((v) => Number.isFinite(v));
    const delta = hour.length >= 2 ? n - hour[0]! : 0;
    const shown = formatNumber(Math.abs(delta), locale, dec, n);
    if (Number(shown.replace(',', '.').replace(/[^\d.]/g, '')) > 0) trend = { up: delta > 0, text: `${shown}${isTemperature(unit) ? '°' : unit ? ` ${unit}` : ''} · ${tr({ en: '1 h', es: '1 h' })}` };
  }

  const hs = headerSize(box);
  const iconColor = loud ? tone : colors.inkDim;

  // The text column: the whole box, or the left part of a wide one.
  const colW = wide ? Math.round(Math.min(box.w * 0.4, Math.max(box.w * 0.3, box.h * 1.25))) : box.w;
  const col: Box = { x: box.x, y: box.y, w: colW, h: box.h };
  const chartH = hasChart && !wide ? Math.round(box.h * 0.42) : 0;
  const headH = drawHeader(g, ctx, e, col, hs, iconColor);
  const valueTop = box.y + (headH ? headH + hs * 0.5 : 0);
  const valueBottom = box.y + box.h - (chartH ? chartH + Math.max(6, box.h * 0.04) : 0) - (wide && trend ? hs * 1.8 : 0);
  const avail = Math.max(10, valueBottom - valueTop);

  // Trend at the right of the value (tall tiles) or under it (wide ones).
  const ts = Math.max(11, Math.round(hs * 1.1));
  const trendW = trend ? kit.measureTracked(g, trend.text, { size: ts, family: fonts.sans }) + ts * 0.9 : 0;
  const besideTrend = !!trend && !wide;
  const room = col.w - (besideTrend ? trendW + ts * 1.2 : 0);
  // As big as fits, but no more than a third of the tile: on a large tile a huge number shouts.
  const vs = fit(g, ctx, isTemperature(unit) ? `${num}°` : num, fonts.sansBold, Math.min(avail * 0.98, box.h * (hasChart && !wide ? 0.3 : 0.5), 150), room, (s) => (unit && !isTemperature(unit) ? s * 0.1 + kit.measureTracked(g, unit, { size: Math.round(s * 0.36), family: fonts.sans }) : 0));
  // Cap height ≈ 0.72 of the size: sit the digits in the middle of their space,
  // leaving room under the baseline for a decimal comma.
  const base = Math.round(Math.min(valueTop + (avail + vs * 0.72) / 2, box.y + box.h - (chartH ? chartH : 0) - vs * 0.2));
  const vw = drawValue(g, ctx, num, unit, col.x, base, vs, loud ? tone : colors.ink);
  if (trend) {
    const tx = besideTrend ? col.x + col.w - trendW : col.x;
    const ty = besideTrend ? base - vs * 0.72 + ts : base + hs * 1.7;
    if (!besideTrend || tx > col.x + vw + ts) {
      drawTrend(g, tx, ty, ts, trend.up, colors.inkDim);
      kit.drawTracked(g, trend.text, tx + ts * 0.85, ty, { size: ts, family: fonts.sans, color: colors.inkDim });
    }
  }

  if (!hasChart || !scale) return;
  // The curve, with its highest and lowest in a narrow gutter at the right.
  const f = values.filter((v) => Number.isFinite(v));
  const ls = Math.max(10, Math.min(15, Math.round((wide ? box.h : chartH) * 0.13)));
  const lo = { size: ls, family: fonts.sans, color: colors.inkDim, align: 'right' as const };
  const hiT = fmtLike(Math.max(...f)), loT = fmtLike(Math.min(...f));
  const gutter = Math.max(kit.measureTracked(g, hiT, lo), kit.measureTracked(g, loT, lo)) + ls * 0.7;
  const area: Box = wide
    ? { x: box.x + colW + Math.max(12, box.w * 0.03), y: box.y + ls * 0.6, w: box.w - colW - Math.max(12, box.w * 0.03) - gutter, h: box.h - ls * 1.2 }
    : { x: box.x, y: box.y + box.h - chartH + ls * 0.6, w: box.w - gutter, h: chartH - ls * 1.2 };
  const Y = (v: number) => area.y + area.h - ((v - scale.lo) / (scale.hi - scale.lo)) * area.h;
  // Faint guides at the highest and the lowest.
  g.fillStyle = alpha(colors.inkFaint, 0.45);
  for (const v of [Math.max(...f), Math.min(...f)]) {
    const y = Math.round(Y(v));
    for (let x = area.x; x < area.x + area.w; x += 6) g.fillRect(x, y, 2, 1);
  }
  kit.drawTracked(g, hiT, box.x + box.w, Y(Math.max(...f)) + ls * 0.36, lo);
  kit.drawTracked(g, loT, box.x + box.w, Y(Math.min(...f)) + ls * 0.36, lo);
  // The dot at "now" has a halo: keep it (and the line's width) inside the widget's box.
  g.save();
  g.beginPath();
  g.rect(box.x, box.y, box.w, box.h);
  g.clip();
  drawCurve(g, area, values, scale, { color: tone, bg: colors.surface });
  g.restore();
}

function renderState(g: Graphics, ctx: Ctx, e: Entity, box: Box): void {
  const { options, theme, kit, fmt } = ctx;
  const { colors, fonts } = theme;
  const level = thresholdLevel(e, options);
  const color = stateColor(level, colors);
  const word = stateText(e, ctx, options.decimals);
  const since = e.changedAt && e.state !== 'unavailable' ? fmt.ago(e.changedAt) : '';
  const stacked = box.w < box.h * 1.3;
  const D = Math.round(stacked ? Math.min(box.h * 0.42, box.w * 0.5) : Math.min(box.h * 0.66, box.w * 0.3));
  const battery = batteryLevel(e);
  const icon = iconFor(e);
  const tint = level === 'off' || level === 'na' ? 0.1 : 0.16;
  if (stacked) {
    drawBadge(g, icon, box.x + D / 2, box.y + D / 2, D, color, { tint, ...(battery !== undefined ? { battery } : {}) });
    let y = box.y + D + Math.max(8, box.h * 0.06);
    const rest = box.y + box.h - y;
    const ls = Math.max(10, Math.min(16, Math.round(rest * 0.16)));
    if (options.showName) {
      drawLabel(g, ctx, options.name || e.name, box.x, y + ls, ls, box.w);
      y += ls * 1.5;
    }
    const ws = fit(g, ctx, word, fonts.sansBold, Math.min(rest * 0.36, box.w * 0.3), box.w);
    kit.drawTracked(g, word, box.x, y + ws * 0.95, { size: ws, family: fonts.sansBold, tracking: -ws * 0.02, color: level === 'off' ? colors.ink : color });
    if (since) kit.drawTracked(g, kit.truncate(g, since, box.w, { size: Math.max(9, Math.round(ws * 0.5)), family: fonts.sans }), box.x, y + ws * 0.95 + ws * 0.85, { size: Math.max(9, Math.round(ws * 0.5)), family: fonts.sans, color: colors.inkDim });
    return;
  }
  drawBadge(g, icon, box.x + D / 2, box.y + box.h / 2, D, color, { tint, ...(battery !== undefined ? { battery } : {}) });
  const tx = box.x + D + Math.max(10, D * 0.26);
  const tw = box.x + box.w - tx;
  const ls = Math.max(11, Math.min(17, Math.round(box.h * 0.085)));
  const ws = fit(g, ctx, word, fonts.sansBold, Math.min(D * 0.55, box.h * 0.3), tw);
  const ss = Math.max(9, Math.min(22, Math.round(ws * 0.46)));
  const blockH = (options.showName ? ls * 1.7 : 0) + ws * 0.78 + (since ? ss * 1.7 : 0);
  let y = box.y + (box.h - blockH) / 2;
  if (options.showName) {
    drawLabel(g, ctx, options.name || e.name, tx, y + ls * 0.8, ls, tw);
    y += ls * 1.7;
  }
  y += ws * 0.78;
  kit.drawTracked(g, word, tx, y, { size: ws, family: fonts.sansBold, tracking: -ws * 0.02, color: level === 'off' ? colors.ink : color });
  if (since) kit.drawTracked(g, kit.truncate(g, since, tw, { size: ss, family: fonts.sans }), tx, y + ss * 1.7, { size: ss, family: fonts.sans, color: colors.inkDim });
}

function renderClimate(g: Graphics, ctx: Ctx, e: Entity, box: Box): void {
  const { options, theme, kit, locale, t: tr } = ctx;
  const { colors, fonts } = theme;
  const level = thresholdLevel(e, options);
  const action = e.action ?? '';
  const off = e.state === 'off';
  const tone = level === 'alert' || level === 'warn' ? stateColor(level, colors) : action === 'heating' ? colors.warn : action === 'cooling' ? colors.info : off ? colors.inkDim : colors.accent;
  const fahrenheit = e.unit === '°F';
  const t1 = (v: number) => `${formatNumber(v, locale, options.decimals, v)}°`;

  const dial = box.w >= box.h * 1.45 && box.h >= 90;
  const r = dial ? Math.round(Math.min(box.h * 0.43, box.w * 0.2)) : 0;
  const colW = dial ? box.w - r * 2 - Math.max(16, r * 0.4) : box.w;
  const col: Box = { x: box.x, y: box.y, w: colW, h: box.h };
  const hs = headerSize(box);
  const headH = drawHeader(g, ctx, e, col, hs, off ? colors.inkDim : tone);

  // What it is doing: "Heating · to 22°" (or the mode, when idle).
  const doing = action && action !== 'idle' && action !== 'off'
    ? tr({ heating: { en: 'Heating', es: 'Calentando' }, cooling: { en: 'Cooling', es: 'Enfriando' }, drying: { en: 'Drying', es: 'Secando' }, fan: { en: 'Fan', es: 'Ventilando' }, preheating: { en: 'Preheating', es: 'Precalentando' } }[action] ?? { en: action })
    : stateText({ ...e, current: undefined }, ctx);
  // Without a dial the target goes after the action.
  const target = e.target !== undefined && !off && !dial ? `${tr({ en: 'to', es: 'a' })} ${t1(e.target)}` : '';
  const ss = Math.max(11, Math.min(22, Math.round(box.h * 0.095)));
  const subH = ss * 1.9;
  const valueTop = box.y + (headH ? headH + hs * 0.5 : 0);
  const avail = Math.max(10, box.y + box.h - subH - valueTop);
  const cur = e.current !== undefined ? formatNumber(e.current, locale, options.decimals) : '–';
  const vs = fit(g, ctx, `${cur}°`, fonts.sansBold, Math.min(avail * 0.98, box.h * 0.45, 150), col.w);
  const base = Math.round(valueTop + (avail + vs * 0.72) / 2);
  drawValue(g, ctx, cur, '°', col.x, base, vs, off ? colors.inkDim : colors.ink);
  // The action in its colour, the target after it.
  const sy = box.y + box.h - ss * 0.45;
  const so = { size: fit(g, ctx, doing, fonts.sansBold, ss, col.w, undefined, 0), family: fonts.sansBold, color: tone };
  const dw = kit.drawTracked(g, kit.truncate(g, doing, col.w, so), col.x, sy, so);
  if (target) kit.drawTracked(g, kit.truncate(g, ` · ${target}`, Math.max(0, col.w - dw), { size: ss, family: fonts.sans }), col.x + dw, sy, { size: ss, family: fonts.sans, color: colors.inkDim });

  if (!dial) return;
  const lo = fahrenheit ? 50 : 10, hi = fahrenheit ? 86 : 30;
  const vals = [e.current, e.target].filter((v): v is number => v !== undefined);
  const min = Math.min(lo, ...vals.map((v) => Math.floor(v - 1))), max = Math.max(hi, ...vals.map((v) => Math.ceil(v + 1)));
  const cx = box.x + box.w - r - Math.max(4, r * 0.08), cy = box.y + box.h / 2 + r * 0.1;
  drawDial(g, cx, cy, r, { min, max, color: tone, colors, ...(e.current !== undefined ? { current: e.current } : {}), ...(e.target !== undefined && !off ? { target: e.target } : {}) });
  // In the middle: the icon, and the target under it.
  const id = r * 0.42;
  const hasTarget = e.target !== undefined && !off;
  drawEntityIcon(g, e, cx - id / 2, cy - id / 2 - (hasTarget ? r * 0.16 : 0), id, tone);
  if (hasTarget) {
    const ts = Math.max(11, Math.round(r * 0.3));
    kit.drawTracked(g, t1(e.target!), cx, cy + r * 0.3 + ts * 0.36, { size: ts, family: fonts.sansBold, color: colors.ink, align: 'center' });
  }
}
