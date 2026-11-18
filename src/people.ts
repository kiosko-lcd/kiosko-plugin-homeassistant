/**
 * Who is home: the people Home Assistant knows (person.*), with their photo,
 * where they are (home, away, or the zone: Work, School) and since when.
 */
import { defineWidget, t, type Graphics, type Image, type RenderContext } from '@kiosko/sdk';
import { readPicture } from './camera.ts';
import { alpha, drawMessage } from './draw.ts';
import { demoHome, pick, type Entity, type HaData } from './ha.ts';

const SOURCE = 'homeassistant/states';
const dataOf = (sources: Record<string, unknown>) => sources[SOURCE] as HaData | undefined;

export interface PeopleData {
  /** Photos read, by person. */
  photos: Record<string, Image>;
}

/** Photos already read, by path: they hardly ever change. */
const photos = new Map<string, Image>();

export function peopleOf(d: HaData, filter: string[] | string): Entity[] {
  return pick(d.entities, filter).filter((e) => e.domain === 'person');
}

/** The letters for a face without a photo, as Home Assistant draws them: "Alex Pérez" → AP, "Sam" → S. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0]![0]! + words[words.length - 1]![0]! : words[0]![0]!).toUpperCase();
}

export const people = defineWidget({
  id: 'people',
  name: { en: 'Who is home', es: 'Quién está en casa' },
  description: {
    en: 'The people Home Assistant knows, with their photo: at home, away or in a zone of yours (Work, School), and since when.',
    es: 'Las personas que conoce Home Assistant, con su foto: en casa, fuera o en una de tus zonas (Trabajo, Colegio), y desde cuándo.',
  },
  icon: 'users',
  category: 'info',
  tags: ['home assistant', 'presence', 'family'],
  size: { min: { w: 140, h: 80 }, preferred: { w: 420, h: 160 } },
  sources: [SOURCE],
  options: t.object({
    people: t.filter({ choices: { source: SOURCE, list: 'people' }, label: { en: 'People', es: 'Personas' }, help: { en: 'In this order. Empty = everyone.', es: 'En este orden. Vacío = todas.' } }),
    showSince: t.boolean({ default: true, label: { en: 'Since when', es: 'Desde cuándo' } }),
    homeFirst: t.boolean({ label: { en: 'Who is home first', es: 'Primero quien está en casa' } }),
  }),
  intervalMs: 30 * 60_000,
  async fetch({ options, sources, canvas, signal }): Promise<PeopleData> {
    const d = dataOf(sources);
    const out: PeopleData = { photos: {} };
    if (!d?.base) return out;
    for (const e of peopleOf(d, options.people)) {
      if (!e.photo) continue;
      // The path without its token: the same photo, whatever the token.
      const key = e.photo.split('?')[0]!;
      try {
        let img = photos.get(key);
        if (!img) {
          img = await canvas.loadImage(Buffer.from(await readPicture(d.base, e.photo, signal)));
          photos.set(key, img);
        }
        out.photos[e.id] = img;
      } catch {
        // No photo: initials instead.
      }
    }
    return out;
  },
  redraw: 'minute',
  render(g, ctx) {
    const { options, sources, data, t: tr } = ctx;
    const d = dataOf(sources);
    const box = ctx.box;
    if (!d || d.state === 'unconfigured') return drawMessage(g, box, ctx, tr({ en: 'Home Assistant not set up', es: 'Home Assistant sin configurar' }), tr({ en: 'Set its address and a token in Settings → Data sources', es: 'Pon su dirección y un token en Ajustes → Fuentes de datos' }));
    if (d.state === 'connecting') return drawMessage(g, box, ctx, tr({ en: 'Connecting to Home Assistant…', es: 'Conectando con Home Assistant…' }));
    let list = peopleOf(d, options.people);
    if (!list.length) return drawMessage(g, box, ctx, tr({ en: 'Nobody', es: 'Nadie' }), tr({ en: 'Home Assistant has no people (Settings → People)', es: 'Home Assistant no tiene personas (Ajustes → Personas)' }));
    if (options.homeFirst) list = [...list].sort((a, b) => Number(b.state === 'home') - Number(a.state === 'home'));
    paintPeople(g, ctx, list, data?.photos ?? {});
  },
  demo: ({ now, locale }) => ({ sources: { [SOURCE]: demoHome(now, locale) } }),
});

/** Where someone is, in words: at home, away, or the zone's name as Home Assistant says it. */
export function whereText(e: Entity, tr: RenderContext<unknown, unknown>['t']): string {
  if (e.state === 'home') return tr({ en: 'Home', es: 'En casa' });
  if (e.state === 'not_home') return tr({ en: 'Away', es: 'Fuera' });
  if (e.state === 'unknown' || e.state === 'unavailable') return tr({ en: 'Unknown', es: 'Sin datos' });
  return e.state;
}

function paintPeople(g: Graphics, ctx: RenderContext<{ showSince: boolean }, unknown>, list: Entity[], faces: Record<string, Image>): void {
  const { box, theme, kit, fmt, options, t: tr } = ctx;
  const { colors, fonts } = theme;
  const n = list.length;
  // One row of faces, as big as fits: by width (n of them) and by height (face + two lines).
  const gap = Math.max(8, box.w * 0.03);
  const cell = (box.w - gap * (n - 1)) / n;
  const face = Math.max(18, Math.min(cell * 0.78, (box.h) / 1.75));
  const ns = Math.max(10, Math.min(20, face * 0.26, cell * 0.14));
  const totalW = n * Math.min(cell, face * 2.2) + gap * (n - 1);
  let x = box.x + (box.w - totalW) / 2;
  const w = Math.min(cell, face * 2.2);
  const top = box.y + Math.max(0, (box.h - face - ns * 2.6) / 2);
  for (const e of list) {
    const cx = x + w / 2, cy = top + face / 2;
    const home = e.state === 'home';
    const ring = home ? colors.ok : e.state === 'not_home' || e.state === 'unknown' || e.state === 'unavailable' ? colors.inkFaint : colors.info;
    g.save();
    g.beginPath();
    g.arc(cx, cy, face / 2, 0, Math.PI * 2);
    g.clip();
    const img = faces[e.id];
    if (img) {
      const s = Math.max(face / img.width, face / img.height);
      g.drawImage(img, cx - (img.width * s) / 2, cy - (img.height * s) / 2, img.width * s, img.height * s);
      if (!home) {
        g.fillStyle = 'rgba(0,0,0,0.45)';
        g.fillRect(cx - face / 2, cy - face / 2, face, face);
      }
    } else {
      g.fillStyle = alpha(ring, home ? 0.25 : 0.12);
      g.fillRect(cx - face / 2, cy - face / 2, face, face);
      const io = { size: Math.round(face * 0.36), family: fonts.sansBold, color: home ? colors.ink : colors.inkDim, align: 'center' as const };
      kit.drawTracked(g, initials(e.name), cx, cy + io.size * 0.36, io);
    }
    g.restore();
    g.strokeStyle = ring;
    g.lineWidth = Math.max(2, face * 0.05);
    g.beginPath();
    g.arc(cx, cy, face / 2, 0, Math.PI * 2);
    g.stroke();
    const no = { size: Math.round(ns), family: fonts.sansBold, color: home ? colors.ink : colors.inkDim, align: 'center' as const };
    kit.drawTracked(g, kit.truncate(g, e.name, w, no), cx, top + face + ns * 1.25, no);
    const where = whereText(e, tr) + (options.showSince && e.changedAt ? ` · ${fmt.ago(e.changedAt, { suffix: false })}` : '');
    const wo = { size: Math.round(ns * 0.8), family: fonts.sans, color: home ? colors.ok : colors.inkDim, align: 'center' as const };
    kit.drawTracked(g, kit.truncate(g, where, w, wo), cx, top + face + ns * 2.35, wo);
    x += w + gap;
  }
}
