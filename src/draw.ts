/**
 * What the widgets paint: list rows in the two shared layouts, a one-line
 * message for the connection states, and the history bars.
 *
 *   one-line   ● Balcony door                         Open
 *   detailed   ● Balcony door
 *               Open · 42 min
 */
import { drawMore, type Box, type Graphics, type ListPlan, type RenderContext } from '@kiosko/sdk';

export interface Row {
  /** The dot. */
  dot: string;
  title: string;
  /** Title in full ink; otherwise dimmed. */
  strong: boolean;
  /** The value or what is wrong, at the right (one line) or under the title (detailed). */
  value: string;
  valueColor: string;
  /** Detailed layout: dim, after the value (" · 42 min"). */
  meta?: string;
}

type Ctx = Pick<RenderContext<unknown, unknown>, 'box' | 'theme' | 'kit' | 't'>;

const dotAt = (g: Graphics, x: number, y: number, r: number, color: string) => {
  g.fillStyle = color;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
};

export function drawRows(g: Graphics, ctx: Ctx, plan: ListPlan, rows: Row[]): void {
  const { box, theme, kit } = ctx;
  const { colors, fonts } = theme;
  const shown = rows.slice(0, plan.shown);
  const { rowH } = plan;
  if (plan.layout === 'detailed') {
    const ts = Math.round(rowH * 0.4), ms = Math.round(rowH * 0.3);
    const dot = ts * 0.28;
    const tx = box.x + dot * 3.4;
    shown.forEach((r, i) => {
      const top = plan.rows[i]!.y;
      dotAt(g, box.x + dot * 1.1, top + ts * 0.66, dot, r.dot);
      const t1 = { size: ts, family: fonts.sans, color: r.strong ? colors.ink : colors.inkDim };
      kit.drawTracked(g, kit.truncate(g, r.title, box.x + box.w - tx, t1), tx, top + ts, t1);
      const y2 = top + ts + ms * 1.45;
      const v = { size: ms, family: fonts.sans, color: r.valueColor };
      const vw = kit.drawTracked(g, kit.truncate(g, r.value, box.x + box.w - tx, v), tx, y2, v);
      if (r.meta) {
        const mo = { size: ms, family: fonts.sans, color: colors.inkDim };
        kit.drawTracked(g, kit.truncate(g, r.meta, Math.max(0, box.x + box.w - tx - vw), mo), tx + vw, y2, mo);
      }
    });
    drawMore(g, ctx, plan, { indent: tx - box.x });
    return;
  }
  const dot = rowH * 0.2;
  const x0 = box.x + dot * 3.4;
  const vo = { size: Math.round(rowH * 0.62), family: fonts.sans };
  shown.forEach((r, i) => {
    const base = plan.rows[i]!.y + rowH * 0.72;
    dotAt(g, box.x + dot * 1.1, base - rowH * 0.22, dot, r.dot);
    // The value keeps up to half the row; the name gets the rest.
    const value = kit.truncate(g, r.value, (box.x + box.w - x0) * 0.5, vo);
    const vw = kit.drawTracked(g, value, box.x + box.w, base, { ...vo, color: r.valueColor, align: 'right' });
    const t1 = { size: Math.round(rowH * 0.66), family: fonts.sans, color: r.strong ? colors.ink : colors.inkDim };
    kit.drawTracked(g, kit.truncate(g, r.title, box.x + box.w - vw - rowH * 0.4 - x0, t1), x0, base, t1);
  });
  drawMore(g, ctx, plan, { indent: x0 - box.x });
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
    for (const [i, line] of lines.entries()) {
      kit.drawTracked(g, line, box.x, box.y + s * 1.1 + hs * 1.6 + i * hs * 1.35, ho);
    }
  }
}

/**
 * Bars from the lowest value to the highest of the series (not from zero:
 * a room going from 20.1 to 21.6 °C must show its day, not a flat block).
 * The last bar is in `strong`, the rest in `color`. Gaps (NaN) are left empty.
 */
export function drawBars(g: Graphics, box: Box, values: number[], o: { color: string; strong: string; gap?: number }): void {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length || box.w < 2 || box.h < 2) return;
  let lo = Math.min(...finite), hi = Math.max(...finite);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const minH = Math.max(1, box.h * 0.08);
  const n = values.length;
  const step = box.w / n;
  const gap = o.gap ?? (step >= 4 ? 1 : 0);
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    const h = minH + ((v - lo) / (hi - lo)) * (box.h - minH);
    g.fillStyle = i === n - 1 ? o.strong : o.color;
    g.fillRect(box.x + i * step, box.y + box.h - h, Math.max(1, step - gap), h);
  });
}
