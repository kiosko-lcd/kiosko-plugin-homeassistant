/**
 * What a Home Assistant media player is playing: the TV, Spotify on a
 * speaker, a Chromecast, Sonos… Its cover, title and artist, the app, and
 * how far it has got. Hides itself while nothing plays, unless told not to.
 *
 * The cover comes from Home Assistant's media player proxy, with the token in
 * the player's `entity_picture` (as a camera's picture does): it changes with
 * every track and the live connection keeps it up to date.
 */
import { defineWidget, t, type Graphics, type Image, type RenderContext } from '@kiosko/sdk';
import { readPicture } from './camera.ts';
import { alpha, drawMessage } from './draw.ts';
import { demoHome, pick, type Entity, type HaData } from './ha.ts';
import { drawIcon } from './icons.ts';

const SOURCE = 'homeassistant/states';
const dataOf = (sources: Record<string, unknown>) => sources[SOURCE] as HaData | undefined;

export interface MediaData {
  /** The cover, and which picture path it came from (to read it again only when that changes). */
  cover?: Image;
  coverOf?: string;
  /** Sample data: a drawn cover. */
  demo?: boolean;
}

const ACTIVE = new Set(['playing', 'paused', 'buffering', 'on']);

/** The player to show: the one chosen, or among several (a pattern, or empty = all), the one playing (or paused) most recently. */
export function pickPlayer(entities: Record<string, Entity>, chosen: string): Entity | undefined {
  if (chosen && !/[*!,]/.test(chosen)) return entities[chosen];
  const all = pick(entities, chosen || 'media_player.*').filter((e) => e.domain === 'media_player');
  const rank = (e: Entity) => (e.state === 'playing' ? 2 : e.state === 'paused' || e.state === 'buffering' ? 1 : 0);
  return all.sort((a, b) => rank(b) - rank(a) || b.changedAt - a.changedAt)[0];
}

/** Where a track is now, in seconds: its position moves on from when it was measured while it plays. */
export function positionNow(e: Entity, now: number): number | undefined {
  const m = e.media;
  if (m?.position === undefined) return undefined;
  const moved = e.state === 'playing' && m.positionAt ? (now - m.positionAt) / 1000 : 0;
  const p = m.position + Math.max(0, moved);
  return m.duration ? Math.min(m.duration, p) : p;
}

/** `3:07`, `1:02:45`. */
export function clock(s: number): string {
  const v = Math.max(0, Math.floor(s));
  const h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), sec = v % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export const media = defineWidget({
  id: 'media',
  name: { en: 'Now playing', es: 'Lo que suena', 'zh-Hant': '正在播放', 'zh-Hans': '正在播放' },
  description: {
    en: 'What a Home Assistant media player is playing (the TV, Spotify on a speaker, a Chromecast, Sonos…): cover, title, artist, the app and how far it has got. Of several, the one playing. Hides itself while nothing plays.',
    es: 'Lo que reproduce un media player de Home Assistant (la tele, Spotify en un altavoz, un Chromecast, Sonos…): carátula, título, artista, la app y por dónde va. De varios, el que suena. Se oculta mientras no suena nada.',
    'zh-Hant': 'Home Assistant 媒體播放器正在播放的內容（電視、喇叭上的 Spotify、Chromecast、Sonos…）：封面、標題、演出者、應用程式和播放進度。有多台時，顯示正在播放的那台。沒有播放時會自動隱藏。',
    'zh-Hans': 'Home Assistant 媒体播放器正在播放的内容（电视、音箱上的 Spotify、Chromecast、Sonos…）：封面、标题、艺人、应用和播放进度。有多个时，显示正在播放的那个。没有播放时会自动隐藏。',
  },
  icon: 'music',
  category: 'media',
  tags: ['home assistant', 'music', 'tv', 'spotify'],
  size: { min: { w: 200, h: 70 }, preferred: { w: 460, h: 160 } },
  sources: [SOURCE],
  options: t.object({
    entity: t.string({
      choices: { source: SOURCE, list: 'players' },
      placeholder: 'media_player.living_room',
      label: { en: 'Player', es: 'Reproductor', 'zh-Hant': '播放器', 'zh-Hans': '播放器' },
      help: { en: 'One, or several with patterns (media_player.*, !media_player.kitchen): the one playing is shown. Empty = all.', es: 'Uno, o varios con patrones (media_player.*, !media_player.cocina): se ve el que suena. Vacío = todos.', 'zh-Hant': '一台，或用萬用字元指定多台（media_player.*, !media_player.kitchen）：顯示正在播放的那台。留空 = 全部。', 'zh-Hans': '一个，或用通配符指定多个（media_player.*, !media_player.kitchen）：显示正在播放的那个。留空 = 全部。' },
    }),
    showCover: t.boolean({ default: true, label: { en: 'Show the cover', es: 'Mostrar la carátula', 'zh-Hant': '顯示封面', 'zh-Hans': '显示封面' } }),
    showProgress: t.boolean({ default: true, label: { en: 'Show how far it has got', es: 'Mostrar por dónde va', 'zh-Hant': '顯示播放進度', 'zh-Hans': '显示播放进度' } }),
  }),
  intervalMs: 10_000,
  timeoutMs: 20_000,
  // The cover is read again only when the player's picture changes (a new track, a new token).
  async fetch({ options, sources, signal, canvas }): Promise<MediaData> {
    const d = dataOf(sources);
    const e = d ? pickPlayer(d.entities, options.entity) : undefined;
    if (!d?.base || !e?.picture || !options.showCover) return {};
    const key = e.picture.split('?')[0] + '|' + e.media?.title + '|' + e.media?.album;
    const hit = covers.get(e.id);
    if (hit?.key === key) return { cover: hit.img, coverOf: key };
    const img = await canvas.loadImage(Buffer.from(await readPicture(d.base, e.picture, signal)));
    covers.set(e.id, { key, img });
    return { cover: img, coverOf: key };
  },
  redraw: ({ options, sources }) => {
    const d = dataOf(sources);
    const e = d ? pickPlayer(d.entities, options.entity) : undefined;
    return e?.state === 'playing' && options.showProgress ? 'second' : 'minute';
  },
  empty: ({ options, sources }) => {
    const d = dataOf(sources);
    const e = d ? pickPlayer(d.entities, options.entity) : undefined;
    return d?.state === 'ok' && (!e || !ACTIVE.has(e.state));
  },
  hideWhenEmpty: true,
  idle: ({ options, sources }) => {
    const d = dataOf(sources);
    const e = d ? pickPlayer(d.entities, options.entity) : undefined;
    return !e || e.state !== 'playing';
  },
  render(g, ctx) {
    const { options, sources, data, t: tr } = ctx;
    const d = dataOf(sources);
    const box = ctx.box;
    if (!d || d.state === 'unconfigured') return drawMessage(g, box, ctx, tr({ en: 'Home Assistant not set up', es: 'Home Assistant sin configurar', 'zh-Hant': 'Home Assistant 尚未設定', 'zh-Hans': 'Home Assistant 尚未设置' }), tr({ en: 'Set its address and a token in Settings → Data sources', es: 'Pon su dirección y un token en Ajustes → Fuentes de datos', 'zh-Hant': '請在「設定 → 資料來源」中填入其網址和權杖', 'zh-Hans': '请在“设置 → 数据源”中填写其网址和令牌' }));
    if (d.state === 'connecting') return drawMessage(g, box, ctx, tr({ en: 'Connecting to Home Assistant…', es: 'Conectando con Home Assistant…', 'zh-Hant': '正在連線 Home Assistant…', 'zh-Hans': '正在连接 Home Assistant…' }));
    const e = pickPlayer(d.entities, options.entity);
    if (!e) return drawMessage(g, box, ctx, tr({ en: 'No media player', es: 'Ningún reproductor', 'zh-Hant': '沒有媒體播放器', 'zh-Hans': '没有媒体播放器' }), options.entity || tr({ en: 'Home Assistant has none', es: 'Home Assistant no tiene ninguno', 'zh-Hant': 'Home Assistant 中沒有任何播放器', 'zh-Hans': 'Home Assistant 中没有任何播放器' }));
    if (!ACTIVE.has(e.state)) return drawMessage(g, box, ctx, tr({ en: 'Nothing playing', es: 'No suena nada', 'zh-Hant': '沒有正在播放的內容', 'zh-Hans': '没有正在播放的内容' }), e.name);
    paintPlayer(g, ctx, e, data);
  },
  demo: ({ now, locale }) => ({ sources: { [SOURCE]: demoHome(now, locale) }, data: { demo: true }, options: { entity: 'media_player.living_room_speaker' } }),
});

/** Covers already read, by player: one per player, kept while its track doesn't change. */
const covers = new Map<string, { key: string; img: Image }>();

function paintPlayer(g: Graphics, ctx: RenderContext<{ showCover: boolean; showProgress: boolean }, MediaData | undefined>, e: Entity, data: MediaData | undefined): void {
  const { box, theme, kit, options, now, t: tr } = ctx;
  const { colors, fonts } = theme;
  const m = e.media ?? {};
  const paused = e.state !== 'playing';
  // The cover: a square as tall as the tile.
  const side = options.showCover ? Math.min(box.h, box.w * 0.42) : 0;
  if (side) {
    const r = Math.max(4, side * 0.06);
    g.save();
    g.beginPath();
    g.roundRect(box.x, box.y + (box.h - side) / 2, side, side, r);
    g.clip();
    const cy = box.y + (box.h - side) / 2;
    if (data?.cover) {
      const img = data.cover;
      const s = Math.max(side / img.width, side / img.height);
      g.drawImage(img, box.x + (side - img.width * s) / 2, cy + (side - img.height * s) / 2, img.width * s, img.height * s);
    } else if (data?.demo) drawDemoCover(g, box.x, cy, side, colors.accent);
    else {
      g.fillStyle = colors.surfaceEdge;
      g.fillRect(box.x, cy, side, side);
      drawIcon(g, 'music', box.x + side * 0.3, cy + side * 0.3, side * 0.4, colors.inkDim);
    }
    if (paused) {
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(box.x, cy, side, side);
      const p = side * 0.12;
      g.fillStyle = '#fff';
      g.fillRect(box.x + side / 2 - p * 1.1, cy + side / 2 - p * 1.4, p * 0.75, p * 2.8);
      g.fillRect(box.x + side / 2 + p * 0.35, cy + side / 2 - p * 1.4, p * 0.75, p * 2.8);
    }
    g.restore();
  }
  // The words, beside it.
  const x = box.x + side + (side ? Math.max(10, box.w * 0.035) : 0);
  const w = box.x + box.w - x;
  const showBar = options.showProgress && !!m.duration;
  const ts = Math.max(13, Math.min(34, box.h * 0.2, w * 0.09));
  const ss = Math.round(ts * 0.68);
  const title = m.title || e.name;
  const lines: { text: string; o: { size: number; family: string; color: string } }[] = [
    { text: title, o: { size: ts, family: fonts.sansBold, color: colors.ink } },
    ...(m.artist ? [{ text: m.artist, o: { size: ss, family: fonts.sans, color: colors.inkDim } }] : []),
    { text: [m.album && m.album !== m.title ? m.album : '', m.app ?? (m.title ? e.name : '')].filter(Boolean).join(' · '), o: { size: Math.round(ss * 0.85), family: fonts.sans, color: colors.inkFaint } },
  ].filter((l) => l.text);
  const barH = showBar ? ss * 1.9 : 0;
  const textH = lines.reduce((a, l) => a + l.o.size * 1.25, 0);
  let y = box.y + Math.max(0, (box.h - textH - barH) / 2);
  for (const l of lines) {
    y += l.o.size * 1.05;
    kit.drawTracked(g, kit.truncate(g, l.text, w, l.o), x, y, l.o);
    y += l.o.size * 0.2;
  }
  if (showBar) {
    const pos = positionNow(e, now) ?? 0;
    const by = y + ss * 0.7;
    const bh = Math.max(3, ss * 0.22);
    g.fillStyle = alpha(colors.ink, 0.15);
    g.beginPath();
    g.roundRect(x, by, w, bh, bh / 2);
    g.fill();
    g.fillStyle = paused ? colors.inkDim : colors.accent;
    g.beginPath();
    g.roundRect(x, by, Math.max(bh, w * Math.min(1, pos / m.duration!)), bh, bh / 2);
    g.fill();
    const to = { size: Math.round(ss * 0.8), family: fonts.mono, color: colors.inkDim };
    kit.drawTracked(g, clock(pos), x, by + bh + to.size * 1.25, to);
    kit.drawTracked(g, clock(m.duration!), x + w, by + bh + to.size * 1.25, { ...to, align: 'right' });
  } else if (paused) {
    const po = { size: Math.round(ss * 0.8), family: fonts.sans, color: colors.inkDim };
    kit.drawTracked(g, tr({ en: 'Paused', es: 'En pausa', 'zh-Hant': '已暫停', 'zh-Hans': '已暂停' }), x, y + po.size * 1.4, po);
  }
}

/** The sample cover: concentric rings, like a record. */
function drawDemoCover(g: Graphics, x: number, y: number, s: number, color: string): void {
  const bg = g.createLinearGradient(x, y, x + s, y + s);
  bg.addColorStop(0, '#2b1d4f');
  bg.addColorStop(1, '#0f3b4a');
  g.fillStyle = bg;
  g.fillRect(x, y, s, s);
  for (let i = 6; i > 0; i--) {
    g.strokeStyle = alpha(color, 0.12 + i * 0.05);
    g.lineWidth = Math.max(1, s * 0.012);
    g.beginPath();
    g.arc(x + s * 0.62, y + s * 0.58, (s * 0.07) * i, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = color;
  g.beginPath();
  g.arc(x + s * 0.62, y + s * 0.58, s * 0.05, 0, Math.PI * 2);
  g.fill();
}

