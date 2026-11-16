/**
 * The drawing pieces the widgets share: labels in tracked small caps (the
 * house style of Kiosko's cards), the history as a smooth curve over a
 * soft gradient, icons in a tinted halo, the thermostat's dial and the list
 * rows.
 */
import { drawMore, type Box, type Graphics, type ListPlan, type RenderContext } from '@kiosko/sdk';
import type { IconName } from './icons.ts';
import { drawBattery, drawIcon } from './icons.ts';

type Ctx = Pick<RenderContext<unknown, unknown>, 'theme' | 'kit' | 't'>;
type Colors = RenderContext<unknown, unknown>['theme']['colors'];

/** `#rrggbb` (or `#rgb`) with an alpha. Anything else is returned as it is. */
export function alpha(color: string, a: number): string {
  let h = color.trim();
  if (/^#[0-9a-f]{3}$/i.test(h)) h = `#${[...h.slice(1)].map((c) => c + c).join('')}`;
  if (!/^#[0-9a-f]{6}$/i.test(h)) return color;
  const n = parseInt(h.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** A label in tracked small caps, like the ones of the GPU and calendar cards. Returns its width. */
export function drawLabel(g: Graphics, ctx: Ctx, text: string, x: number, y: number, size: number, maxW: number, color = ctx.theme.colors.inkDim): number {
  const o = { size, family: ctx.theme.fonts.sansBold, smallCaps: true, tracking: size * 0.12, color };
  return ctx.kit.drawTracked(g, ctx.kit.truncate(g, text, maxW, o), x, y, o);
}

/** A dim one-liner (or two) in place of the content. */
export function drawMessage(g: Graphics, box: Box, { theme, kit }: Pick<Ctx, 'theme' | 'kit'>, text: string, hint?: string): void {
  const { colors, fonts } = theme;
  const s = Math.max(10, Math.round(Math.min(30, box.h * 0.28)));
  const o = { size: s, family: fonts.sans, color: colors.inkDim };
  kit.drawTracked(g, kit.truncate(g, text, box.w, o), box.x, box.y + s * 1.1, o);
  if (hint && box.h > s * 2.4) {
    const hs = Math.max(9, Math.round(s * 0.6));
    const ho = { size: hs, family: fonts.sans, color: colors.inkFaint };
    const lines = kit.wrapLines(g, hint, box.w, Math.max(1, Math.floor((box.h - s * 1.6) / (hs * 1.4))), ho);
    for (const [i, line] of lines.entries()) kit.drawTracked(g, line, box.x, box.y + s * 1.1 + hs * 1.6 + i * hs * 1.35, ho);
  }
}

/** A filled triangle pointing up (rising) or down, sitting on the text baseline `y`. */
export function drawTrend(g: Graphics, x: number, y: number, size: number, up: boolean, color: string): void {
  const w = size * 0.62, h = size * 0.5, top = y - size * 0.62;
  g.fillStyle = color;
  g.beginPath();
  if (up) {
    g.moveTo(x, top + h);
    g.lineTo(x + w / 2, top);
    g.lineTo(x + w, top + h);
  } else {
    g.moveTo(x, top);
    g.lineTo(x + w / 2, top + h);
    g.lineTo(x + w, top);
  }
  g.closePath();
  g.fill();
}

export interface CurveScale {
  lo: number;
  hi: number;
}

/** The vertical range of a curve: the data's, padded, never narrower than `minSpan` (a flat 21 °C mustn't look like a storm). */
export function curveScale(values: number[], minSpan: number): CurveScale | null {
  const f = values.filter((v) => Number.isFinite(v));
  if (f.length < 2) return null;
  let lo = Math.min(...f), hi = Math.max(...f);
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  const pad = (hi - lo) * 0.12;
  return { lo: lo - pad, hi: hi + pad };
}

/**
 * The history as a smooth line (quadratic joins through the midpoints, so
 * it never overshoots the data) over a gradient that fades to nothing, with
 * a dot where it ends: now. Gaps (NaN) break the line.
 */
export function drawCurve(g: Graphics, box: Box, values: number[], scale: CurveScale, o: { color: string; bg: string }): void {
  const n = values.length;
  if (n < 2 || box.w < 4 || box.h < 4) return;
  const X = (i: number) => box.x + (i / (n - 1)) * box.w;
  const Y = (v: number) => box.y + box.h - ((v - scale.lo) / (scale.hi - scale.lo)) * box.h;
  // Runs of finite values.
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  values.forEach((v, i) => {
    if (Number.isFinite(v)) run.push([X(i), Y(v)]);
    else if (run.length) (runs.push(run), (run = []));
  });
  if (run.length) runs.push(run);
  const trace = (pts: [number, number][], move: boolean) => {
    if (move) g.moveTo(pts[0]![0], pts[0]![1]);
    else g.lineTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const [x, y] = pts[i]!, [nx, ny] = pts[i + 1]!;
      g.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    }
    const last = pts[pts.length - 1]!;
    g.lineTo(last[0], last[1]);
  };
  const lw = Math.max(1.5, Math.min(3, box.h * 0.03));
  for (const pts of runs) {
    if (pts.length < 2) continue;
    // The area under the line.
    const grad = g.createLinearGradient(0, box.y, 0, box.y + box.h);
    grad.addColorStop(0, alpha(o.color, 0.32));
    grad.addColorStop(1, alpha(o.color, 0));
    g.beginPath();
    g.moveTo(pts[0]![0], box.y + box.h);
    trace(pts, false);
    g.lineTo(pts[pts.length - 1]![0], box.y + box.h);
    g.closePath();
    g.fillStyle = grad;
    g.fill();
    // The line.
    g.beginPath();
    trace(pts, true);
    g.lineWidth = lw;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.strokeStyle = o.color;
    g.stroke();
  }
  // Now: a dot with a ring of background around it, and a soft halo.
  const lastRun = runs.at(-1);
  const end = lastRun?.at(-1);
  if (end && Math.abs(end[0] - (box.x + box.w)) < 1) {
    const r = lw * 1.7;
    g.fillStyle = alpha(o.color, 0.22);
    g.beginPath();
    g.arc(end[0], end[1], r * 2.4, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = o.bg;
    g.beginPath();
    g.arc(end[0], end[1], r + lw * 0.6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = o.color;
    g.beginPath();
    g.arc(end[0], end[1], r, 0, Math.PI * 2);
    g.fill();
  }
}

/** An icon centred in a tinted disc of its own colour: how a state is shown at a glance. */
export function drawBadge(g: Graphics, icon: IconName, cx: number, cy: number, d: number, color: string, o: { tint?: number; battery?: number } = {}): void {
  g.fillStyle = alpha(color, o.tint ?? 0.14);
  g.beginPath();
  g.arc(cx, cy, d / 2, 0, Math.PI * 2);
  g.fill();
  const s = d * 0.52;
  if (icon === 'battery') drawBattery(g, cx - s / 2, cy - s / 2, s, color, o.battery ?? 0);
  else drawIcon(g, icon, cx - s / 2, cy - s / 2, s, color);
}

/**
 * A thermostat's dial: a 270° track from `min` to `max`, filled up to the
 * room temperature, and a marker at the target.
 */
export function drawDial(g: Graphics, cx: number, cy: number, r: number, o: { min: number; max: number; current?: number; target?: number; color: string; colors: Colors }): void {
  const a0 = Math.PI * 0.75, sweep = Math.PI * 1.5;
  const at = (v: number) => a0 + sweep * Math.max(0, Math.min(1, (v - o.min) / (o.max - o.min)));
  const lw = Math.max(3, r * 0.13);
  g.lineCap = 'round';
  g.lineWidth = lw;
  g.strokeStyle = alpha(o.colors.inkFaint, 0.55);
  g.beginPath();
  g.arc(cx, cy, r, a0, a0 + sweep);
  g.stroke();
  // Ticks every degree-ish, faint, inside the track.
  const steps = Math.round(o.max - o.min);
  if (steps > 0 && steps <= 60) {
    g.lineWidth = Math.max(1, lw * 0.18);
    g.strokeStyle = alpha(o.colors.inkFaint, 0.9);
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (sweep * i) / steps;
      const r1 = r - lw * (i % 5 === 0 ? 1.55 : 1.2), r2 = r - lw * 0.95;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      g.stroke();
    }
  }
  if (o.current !== undefined) {
    g.lineWidth = lw;
    g.strokeStyle = o.color;
    g.beginPath();
    g.arc(cx, cy, r, a0, Math.max(a0 + 0.001, at(o.current)));
    g.stroke();
  }
  if (o.target !== undefined) {
    const a = at(o.target);
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    g.fillStyle = o.colors.surface;
    g.beginPath();
    g.arc(x, y, lw * 0.95, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = o.colors.ink;
    g.beginPath();
    g.arc(x, y, lw * 0.62, 0, Math.PI * 2);
    g.fill();
  }
}

export interface Row {
  icon: IconName;
  /** For `icon: 'battery'`: how full. */
  battery?: number;
  /** The icon's colour (and its halo's, in `badges` rows). */
  color: string;
  title: string;
  /** Title in full ink; otherwise dimmed. */
  strong: boolean;
  /** The value or what is wrong. */
  value: string;
  /** A unit drawn smaller and dimmer after the value (`°C`, `W`). */
  unit?: string;
  valueColor: string;
  /** Dim, after the value on the second line of a detailed row, or at the far right of a one-line one (" · 42 min"). */
  meta?: string;
  /** Tints the whole row (dangers). */
  highlight?: string;
}

/**
 * Rows of a list, in the two shared layouts:
 *
 *   one-line   ⌂ Balcony door                     Open
 *   detailed   (⌂) Balcony door
 *                  Open · 42 min
 *
 * With `badges` the icon sits in a tinted disc; otherwise it is bare, with
 * a hairline between rows.
 */
export function drawRows(g: Graphics, ctx: Ctx & { box: Box }, plan: ListPlan, rows: Row[], o: { badges?: boolean; metaRight?: boolean } = {}): void {
  const { box, theme, kit } = ctx;
  const { colors, fonts } = theme;
  const shown = rows.slice(0, plan.shown);
  const { rowH } = plan;
  const detailed = plan.layout === 'detailed';
  const iconD = detailed ? rowH * 0.74 : rowH * (o.badges ? 0.82 : 0.6);
  const tx = box.x + iconD + rowH * (detailed ? 0.3 : 0.32);
  shown.forEach((r, i) => {
    const top = plan.rows[i]!.y;
    if (r.highlight) {
      g.fillStyle = alpha(r.highlight, 0.12);
      g.beginPath();
      g.roundRect(box.x - rowH * 0.12, top + rowH * 0.05, box.w + rowH * 0.24, rowH * 0.9, rowH * 0.18);
      g.fill();
    }
    const cy = top + rowH / 2;
    if (o.badges) drawBadge(g, r.icon, box.x + iconD / 2, cy, iconD, r.color, r.battery !== undefined ? { battery: r.battery } : {});
    else if (r.icon === 'battery') drawBattery(g, box.x, cy - iconD / 2, iconD, r.color, r.battery ?? 0);
    else drawIcon(g, r.icon, box.x, cy - iconD / 2, iconD, r.color);
    if (!o.badges && i > 0) {
      g.fillStyle = alpha(colors.inkFaint, 0.35);
      g.fillRect(tx, top, box.x + box.w - tx, 1);
    }
    if (detailed) {
      const ts = Math.round(rowH * 0.34), ms = Math.round(rowH * 0.27);
      const y1 = cy - rowH * 0.06, y2 = cy + rowH * 0.3;
      const t1 = { size: ts, family: fonts.sans, color: r.strong ? colors.ink : colors.inkDim };
      kit.drawTracked(g, kit.truncate(g, r.title, box.x + box.w - tx, t1), tx, y1, t1);
      const v = { size: ms, family: fonts.sans, color: r.valueColor };
      const text = r.unit ? `${r.value} ${r.unit}` : r.value;
      let x = tx + kit.drawTracked(g, kit.truncate(g, text, box.x + box.w - tx, v), tx, y2, v);
      if (r.meta && !o.metaRight) {
        const mo = { size: ms, family: fonts.sans, color: colors.inkDim };
        x += kit.drawTracked(g, kit.truncate(g, r.meta, Math.max(0, box.x + box.w - x), mo), x, y2, mo);
      } else if (r.meta) {
        const mo = { size: ms, family: fonts.sans, color: colors.inkDim, align: 'right' as const };
        kit.drawTracked(g, r.meta.replace(/^ · /, ''), box.x + box.w, y1, mo);
      }
      return;
    }
    const base = cy + rowH * 0.2;
    const vs = Math.round(rowH * 0.5);
    let right = box.x + box.w;
    if (r.meta && o.metaRight) {
      const mo = { size: Math.round(vs * 0.82), family: fonts.sans, color: colors.inkDim, align: 'right' as const };
      right -= kit.drawTracked(g, r.meta.replace(/^ · /, ''), right, base, mo) + vs * 0.7;
    }
    if (r.unit) {
      const uo = { size: Math.round(vs * 0.78), family: fonts.sans, color: colors.inkDim, align: 'right' as const };
      right -= kit.drawTracked(g, r.unit, right, base, uo) + vs * 0.22;
    }
    const vo = { size: vs, family: r.unit ? fonts.sansBold : fonts.sans, color: r.valueColor, align: 'right' as const };
    const value = kit.truncate(g, r.value, (box.x + box.w - tx) * 0.45, vo);
    right -= kit.drawTracked(g, value, right, base, vo);
    const t1 = { size: Math.round(rowH * 0.5), family: fonts.sans, color: r.strong ? colors.ink : colors.inkDim };
    kit.drawTracked(g, kit.truncate(g, r.title, right - rowH * 0.4 - tx, t1), tx, base, t1);
  });
  drawMore(g, ctx, plan, { indent: tx - box.x });
}
