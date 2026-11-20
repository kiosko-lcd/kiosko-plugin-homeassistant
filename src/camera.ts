/**
 * A Home Assistant camera on the panel: its latest picture, refreshed every
 * so often, with its name, how old the picture is and, when a motion sensor
 * goes with it, a red mark while it sees someone.
 *
 * The picture comes from Home Assistant's camera proxy, at the path the
 * camera entity carries (`entity_picture`): a short-lived token that opens
 * that camera only, which Home Assistant renews every few minutes and the
 * live connection keeps up to date. Any camera works (Blink, Reolink,
 * ONVIF, a generic MJPEG…); what the picture is depends on the camera: a
 * fresh still for one that streams, the last thumbnail for a battery one
 * like Blink, which only takes a new one on motion or when asked.
 */
import { createHash } from 'node:crypto';
import { defineWidget, t, type Box, type Graphics, type Image, type RenderContext } from '@kiosko/sdk';
import { drawMessage } from './draw.ts';
import { demoHome, type Entity, type HaData } from './ha.ts';

const SOURCE = 'homeassistant/states';
const dataOf = (sources: Record<string, unknown>) => sources[SOURCE] as HaData | undefined;

export interface CameraData {
  /** `ok`: a picture; the rest say why there is none (yet). */
  state: 'ok' | 'pick' | 'waiting' | 'missing' | 'nopicture';
  img?: Image;
  /** When the picture last changed (not when it was last read), epoch ms. */
  changedAt?: number;
  /** Sample data: paints a drawn scene instead of a picture. */
  demo?: boolean;
  /** Motion or a ring when it was read: look again sooner. */
  lively?: boolean;
}

/** How long a ring keeps the camera marked (and urgent). */
export const RING_MS = 60_000;

/**
 * Whether a doorbell is ringing: an `event` entity rang in the last RING_MS
 * (its state is when), or a binary sensor is on.
 */
export function ringing(e: Entity | undefined, now: number): boolean {
  if (!e) return false;
  if (e.domain === 'event') {
    const at = Date.parse(e.state);
    return Number.isFinite(at) && now - at >= -5_000 && now - at < RING_MS;
  }
  return e.state === 'on';
}

/** The last picture seen of each camera, so "how old" means since it changed, not since it was read. */
const seen = new Map<string, { hash: string; at: number }>();

/** When this picture of `camera` first came in: now if it differs from the last one, or when that one did. */
export function pictureChangedAt(camera: string, bytes: Uint8Array, now: number): number {
  const hash = createHash('sha1').update(bytes).digest('hex');
  const last = seen.get(camera);
  if (last?.hash === hash) return last.at;
  seen.set(camera, { hash, at: now });
  return now;
}

/**
 * Reads an entity's picture from Home Assistant: a camera's still, a media
 * player's cover, a person's photo. A path is read from Home Assistant (its
 * token is in it); a full URL as it is.
 */
export async function readPicture(base: string, path: string, signal?: AbortSignal): Promise<Uint8Array> {
  const url = /^https?:\/\//i.test(path) ? path : base + (path.startsWith('/') ? path : `/${path}`);
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) throw new Error(`Home Assistant answered HTTP ${res.status} for ${path.split('?')[0]}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** The motion sensor that goes with a camera: the one chosen, or Blink's and most integrations' `binary_sensor.<camera>_motion`. */
export function motionOf(entities: Record<string, Entity>, camera: string, chosen: string): Entity | undefined {
  if (chosen) return entities[chosen];
  const auto = `binary_sensor.${camera.split('.')[1] ?? ''}_motion`;
  return entities[auto];
}

/** Where an image of `w×h` goes in `box`: cover fills and crops, contain shows it whole; `fy` keeps the top (0) to the bottom (1) in view. */
export function placePicture(box: Box, w: number, h: number, fit: 'cover' | 'contain', fy: number): Box {
  const s = fit === 'cover' ? Math.max(box.w / w, box.h / h) : Math.min(box.w / w, box.h / h);
  const dw = w * s, dh = h * s;
  return { x: box.x + (box.w - dw) / 2, y: box.y + (box.h - dh) * fy, w: dw, h: dh };
}

const KEEP: Record<'center' | 'top' | 'bottom', number> = { top: 0, center: 0.5, bottom: 1 };

export const camera = defineWidget({
  id: 'camera',
  name: { en: 'Camera', es: 'Cámara', 'zh-Hant': '攝影機', 'zh-Hans': '摄像头' },
  description: {
    en: 'The latest picture of a Home Assistant camera (Blink, Reolink, ONVIF…), refreshed every minute, with how old it is; with a motion sensor, a red mark while it sees someone, and it can take over its tile. A still, not live video.',
    es: 'La última imagen de una cámara de Home Assistant (Blink, Reolink, ONVIF…), refrescada cada minuto, con su antigüedad; con un sensor de movimiento, una marca roja mientras ve a alguien, y puede quedarse con su tesela. Una foto, no vídeo en directo.',
    'zh-Hant': '最新一張 Home Assistant 攝影機畫面（Blink、Reolink、ONVIF…），每分鐘重新整理，並標示畫面是多久前的；搭配動作感測器時，偵測到有人會顯示紅色標記，且可佔用其方格。是靜態畫面，不是即時影像。',
    'zh-Hans': '最新一张 Home Assistant 摄像头画面（Blink、Reolink、ONVIF…），每分钟刷新，并标出画面是多久前的；配合运动传感器时，检测到有人会显示红色标记，并可占用其格子。是静态画面，不是实时视频。',
  },
  icon: 'cctv',
  category: 'media',
  tags: ['home assistant', 'camera', 'blink', 'security'],
  chrome: 'bare',
  size: { min: { w: 120, h: 80 }, preferred: { w: 400, h: 260 } },
  sources: [SOURCE],
  options: t.object({
    entity: t.string({
      choices: { source: SOURCE, list: 'cameras' },
      placeholder: 'camera.porch',
      label: { en: 'Camera', es: 'Cámara', 'zh-Hant': '攝影機', 'zh-Hans': '摄像头' },
      help: { en: 'Its id in Home Assistant: camera.something.', es: 'Su id en Home Assistant: camera.algo.', 'zh-Hant': '它在 Home Assistant 中的 id：camera.something。', 'zh-Hans': '它在 Home Assistant 中的 id：camera.something。' },
    }),
    name: t.string({ label: { en: 'Name', es: 'Nombre', 'zh-Hant': '名稱', 'zh-Hans': '名称' }, help: { en: 'Empty = the name in Home Assistant.', es: 'Vacío = el nombre en Home Assistant.', 'zh-Hant': '留空 = 使用 Home Assistant 中的名稱。', 'zh-Hans': '留空 = 使用 Home Assistant 中的名称。' } }),
    showName: t.boolean({ default: true, label: { en: 'Show the name', es: 'Mostrar el nombre', 'zh-Hant': '顯示名稱', 'zh-Hans': '显示名称' } }),
    showAge: t.boolean({ default: true, label: { en: 'Show how old the picture is', es: 'Mostrar la antigüedad de la imagen', 'zh-Hant': '顯示畫面是多久前的', 'zh-Hans': '显示画面是多久前的' }, help: { en: 'Since the picture last changed. A battery camera (Blink) only takes a new one on motion or when asked.', es: 'Desde que cambió la imagen por última vez. Una cámara de batería (Blink) solo hace otra con movimiento o cuando se le pide.', 'zh-Hant': '自畫面上次變更起算。電池供電的攝影機（Blink）只有偵測到動作或收到要求時才會拍新畫面。', 'zh-Hans': '从画面上次变化起算。电池供电的摄像头（Blink）只在检测到运动或收到请求时才拍新画面。' } }),
    motion: t.string({
      choices: { source: SOURCE, list: 'motion' },
      placeholder: 'binary_sensor.porch_motion',
      label: { en: 'Motion sensor', es: 'Sensor de movimiento', 'zh-Hant': '動作感測器', 'zh-Hans': '运动传感器' },
      help: { en: 'Empty = binary_sensor.<camera>_motion if there is one (Blink names them so).', es: 'Vacío = binary_sensor.<cámara>_motion si existe (Blink los llama así).', 'zh-Hant': '留空 = binary_sensor.<camera>_motion（若有的話；Blink 就是這樣命名）。', 'zh-Hans': '留空 = binary_sensor.<camera>_motion（如果有的话；Blink 就是这样命名的）。' },
    }),
    doorbell: t.string({
      choices: { source: SOURCE, list: 'doorbells' },
      placeholder: 'event.front_door_ding',
      label: { en: 'Doorbell', es: 'Timbre', 'zh-Hant': '門鈴', 'zh-Hans': '门铃' },
      help: { en: 'An event entity (event.*) or a binary sensor: for a minute after it rings, a mark on the picture, and the camera takes the tile if allowed.', es: 'Una entidad de evento (event.*) o un sensor binario: durante un minuto tras sonar, una marca en la imagen, y la cámara se queda con la tesela si se le deja.', 'zh-Hant': '事件實體（event.*）或二元感測器：響鈴後一分鐘內，畫面上會顯示標記；若允許，攝影機會佔用方格。', 'zh-Hans': '事件实体（event.*）或二元传感器：响铃后一分钟内，画面上会显示标记；若允许，摄像头会占用格子。' },
    }),
    fit: t.enum(['cover', 'contain'] as const, { label: { en: 'Fit', es: 'Ajuste', 'zh-Hant': '縮放', 'zh-Hans': '缩放' }, labels: { cover: { en: 'Fill (crop)', es: 'Llenar (recorta)', 'zh-Hant': '填滿（裁切）', 'zh-Hans': '填充（裁剪）' }, contain: { en: 'Whole picture', es: 'Imagen entera', 'zh-Hant': '完整畫面', 'zh-Hans': '完整画面' } } }),
    keep: t.enum(['center', 'top', 'bottom'] as const, {
      advanced: true,
      label: { en: 'Keep in view', es: 'Mantener a la vista', 'zh-Hant': '優先保留', 'zh-Hans': '优先保留' },
      labels: { center: { en: 'The centre', es: 'El centro', 'zh-Hant': '中間', 'zh-Hans': '中间' }, top: { en: 'The top', es: 'La parte de arriba', 'zh-Hant': '上方', 'zh-Hans': '上方' }, bottom: { en: 'The bottom', es: 'La parte de abajo', 'zh-Hant': '下方', 'zh-Hans': '下方' } },
      help: { en: 'What filling crops last: the sky or the ground.', es: 'Lo último que recorta al llenar: el cielo o el suelo.', 'zh-Hant': '填滿時最後才裁掉的部分：天空或地面。', 'zh-Hans': '填充时最后才裁掉的部分：天空或地面。' },
    }),
    dim: t.integer({ default: 0, min: 0, max: 90, step: 5, unit: '%', slider: true, advanced: true, label: { en: 'Darken', es: 'Oscurecer', 'zh-Hant': '調暗', 'zh-Hans': '调暗' }, help: { en: 'Keeps a bright picture from outshining everything else.', es: 'Para que una imagen clara no deslumbre al resto.', 'zh-Hant': '避免明亮的畫面蓋過其他內容。', 'zh-Hans': '避免明亮的画面盖过其他内容。' } }),
  }),
  intervalMs: 60_000,
  // Until the connection has the camera, look again soon: the first picture shouldn't wait a minute.
  // While someone moves or rings, every 10 s: the picture to look at is the one of now.
  intervalOf: ({ data }: { data: CameraData | undefined }) => (!data || data.state === 'waiting' ? 5_000 : data.lively ? 10_000 : undefined),
  timeoutMs: 30_000,
  async fetch({ options, sources, canvas, signal }): Promise<CameraData> {
    if (!options.entity) return { state: 'pick' };
    const d = dataOf(sources);
    if (!d || !d.base || !Object.keys(d.entities).length) return { state: 'waiting' };
    const e = d.entities[options.entity];
    if (!e) return { state: 'missing' };
    if (!e.picture) return { state: 'nopicture' };
    const bytes = await readPicture(d.base, e.picture, signal);
    const now = Date.now();
    const lively = motionOf(d.entities, e.id, options.motion)?.state === 'on' || ringing(options.doorbell ? d.entities[options.doorbell] : undefined, now);
    return { state: 'ok', img: await canvas.loadImage(Buffer.from(bytes)), changedAt: pictureChangedAt(options.entity, bytes, now), ...(lively ? { lively } : {}) };
  },
  redraw: 'minute',
  urgent: ({ options, sources, now }) => {
    const d = dataOf(sources);
    if (d?.state !== 'ok' || !options.entity) return false;
    return motionOf(d.entities, options.entity, options.motion)?.state === 'on' || ringing(options.doorbell ? d.entities[options.doorbell] : undefined, now);
  },
  // Off by default: a camera's tile is for looking, not for interrupting. The user turns it on.
  takeOver: false,
  render(g, ctx) {
    const { options, sources, data, theme, t: tr } = ctx;
    const { box } = ctx;
    const d = dataOf(sources);
    const e = d?.entities[options.entity];
    g.fillStyle = theme.colors.surface;
    g.fillRect(box.x, box.y, box.w, box.h);
    const pad = Math.round(Math.min(16, box.h * 0.08));
    const inner = { x: box.x + pad, y: box.y + pad, w: box.w - pad * 2, h: box.h - pad * 2 };
    if (!data?.img && !data?.demo) {
      const [text, hint] = why(d, data, options.entity, tr);
      return drawMessage(g, inner, ctx, text, hint);
    }
    g.save();
    g.beginPath();
    g.rect(box.x, box.y, box.w, box.h);
    g.clip();
    if (data.demo) drawScene(g, box);
    else {
      const at = placePicture(box, data.img!.width, data.img!.height, options.fit, KEEP[options.keep]);
      g.drawImage(data.img!, at.x, at.y, at.w, at.h);
    }
    if (options.dim > 0) {
      g.fillStyle = `rgba(0,0,0,${options.dim / 100})`;
      g.fillRect(box.x, box.y, box.w, box.h);
    }
    const stale = !d || d.state !== 'ok' || e?.state === 'unavailable';
    if (stale) {
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(box.x, box.y, box.w, box.h);
    }
    g.restore();
    const motion = d && e ? motionOf(d.entities, e.id, options.motion) : undefined;
    overlay(g, ctx, {
      name: options.showName ? options.name || e?.name || options.entity : '',
      age: options.showAge && data.changedAt ? ctx.fmt.ago(data.changedAt) : '',
      motion: motion?.state === 'on',
      ring: !!d && ringing(options.doorbell ? d.entities[options.doorbell] : undefined, ctx.now),
      stale: stale ? (e?.state === 'unavailable' ? tr({ en: 'camera unavailable', es: 'cámara no disponible', 'zh-Hant': '攝影機無法使用', 'zh-Hans': '摄像头不可用' }) : tr({ en: 'offline', es: 'sin conexión', 'zh-Hant': '離線', 'zh-Hans': '离线' })) : '',
    });
  },
  demo: ({ now, locale }) => ({
    sources: { [SOURCE]: demoHome(now, locale) },
    data: { state: 'ok', demo: true, changedAt: now - 4 * 60_000 } satisfies CameraData,
    options: { entity: 'camera.porch' },
  }),
});

/** Why there is no picture yet, and what to do about it. */
function why(d: HaData | undefined, data: CameraData | undefined, entity: string, tr: RenderContext<unknown, unknown>['t']): [string, string?] {
  if (d?.state === 'unconfigured') return [tr({ en: 'Home Assistant not set up', es: 'Home Assistant sin configurar', 'zh-Hant': 'Home Assistant 尚未設定', 'zh-Hans': 'Home Assistant 尚未设置' }), tr({ en: 'Set its address and a token in Settings → Data sources', es: 'Pon su dirección y un token en Ajustes → Fuentes de datos', 'zh-Hant': '請在「設定 → 資料來源」中填入其網址和權杖', 'zh-Hans': '请在“设置 → 数据源”中填写其网址和令牌' })];
  if (!entity || data?.state === 'pick') return [tr({ en: 'Choose a camera', es: 'Elige una cámara', 'zh-Hant': '選擇攝影機', 'zh-Hans': '选择摄像头' }), tr({ en: 'In the inspector: one of your Home Assistant cameras, e.g. camera.porch', es: 'En el inspector: una de las cámaras de tu Home Assistant, p. ej. camera.porch', 'zh-Hant': '在檢查器中：你的某台 Home Assistant 攝影機，例如 camera.porch', 'zh-Hans': '在检查器中：你的某个 Home Assistant 摄像头，例如 camera.porch' })];
  if (d?.state === 'error' && !Object.keys(d.entities).length) return [tr({ en: 'Home Assistant unreachable', es: 'Home Assistant no responde', 'zh-Hant': 'Home Assistant 無法連線', 'zh-Hans': 'Home Assistant 无法连接' }), d.error];
  if (data?.state === 'missing') return [tr({ en: 'Camera not found', es: 'Cámara no encontrada', 'zh-Hant': '找不到攝影機', 'zh-Hans': '找不到摄像头' }), entity];
  if (data?.state === 'nopicture') return [tr({ en: 'This camera has no picture', es: 'Esta cámara no tiene imagen', 'zh-Hant': '這台攝影機沒有畫面', 'zh-Hans': '这个摄像头没有画面' }), tr({ en: 'It may be off, or not a camera', es: 'Puede que esté apagada, o que no sea una cámara', 'zh-Hant': '可能已關閉，或不是攝影機', 'zh-Hans': '可能已关闭，或不是摄像头' })];
  return [tr({ en: 'Waiting for the camera…', es: 'Esperando a la cámara…', 'zh-Hant': '正在等待攝影機…', 'zh-Hans': '正在等待摄像头…' })];
}

/** The text over the picture: name and age at the bottom on a shade, motion and trouble at the top. */
function overlay(g: Graphics, ctx: RenderContext<unknown, unknown>, o: { name: string; age: string; motion: boolean; ring: boolean; stale: string }): void {
  const { box, theme, kit } = ctx;
  const { fonts, colors } = theme;
  const s = Math.max(11, Math.round(Math.min(22, box.h * 0.085, box.w * 0.05)));
  const pad = Math.round(s * 0.7);
  if (o.name || o.age) {
    const h = s * 2.6;
    const shade = g.createLinearGradient(0, box.y + box.h - h, 0, box.y + box.h);
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.72)');
    g.fillStyle = shade;
    g.fillRect(box.x, box.y + box.h - h, box.w, h);
    const base = box.y + box.h - pad;
    const ageO = { size: Math.round(s * 0.8), family: fonts.sans, color: 'rgba(255,255,255,0.75)', align: 'right' as const };
    const ageW = o.age ? kit.measureTracked(g, o.age, ageO) + pad : 0;
    if (o.age) kit.drawTracked(g, o.age, box.x + box.w - pad, base, ageO);
    if (o.name) {
      const nameO = { size: s, family: fonts.sansBold, color: '#fff' };
      kit.drawTracked(g, kit.truncate(g, o.name, box.w - pad * 2 - ageW, nameO), box.x + pad, base, nameO);
    }
  }
  let x = box.x + pad;
  const pill = (text: string, color: string, dot: boolean) => {
    const ps = Math.round(s * 0.8);
    const tw = kit.measureTracked(g, text, { size: ps, family: fonts.sansBold });
    const h = ps * 1.7, w = tw + ps * (dot ? 2.4 : 1.4);
    const y = box.y + pad;
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.beginPath();
    g.roundRect(x, y, w, h, h / 2);
    g.fill();
    if (dot) {
      g.fillStyle = color;
      g.beginPath();
      g.arc(x + ps * 0.85, y + h / 2, ps * 0.32, 0, Math.PI * 2);
      g.fill();
    }
    kit.drawTracked(g, text, x + ps * (dot ? 1.55 : 0.7), y + h / 2 + ps * 0.36, { size: ps, family: fonts.sansBold, color: dot ? '#fff' : color });
    x += w + ps * 0.5;
  };
  if (o.ring) pill(ctx.t({ en: 'Doorbell', es: 'Llaman', 'zh-Hant': '門鈴', 'zh-Hans': '门铃' }), colors.warn, true);
  if (o.motion) pill(ctx.t({ en: 'Motion', es: 'Movimiento', 'zh-Hant': '有動靜', 'zh-Hans': '有动静' }), colors.alert, true);
  if (o.motion || o.ring) {
    g.strokeStyle = o.motion ? colors.alert : colors.warn;
    g.lineWidth = Math.max(2, Math.round(s * 0.18));
    g.strokeRect(box.x + g.lineWidth / 2, box.y + g.lineWidth / 2, box.w - g.lineWidth, box.h - g.lineWidth);
  }
  if (o.stale) pill(o.stale, colors.warn, false);
}

/** The sample picture: a front door at dusk, drawn, for the gallery and the editor. */
function drawScene(g: Graphics, b: Box): void {
  const sky = g.createLinearGradient(0, b.y, 0, b.y + b.h);
  sky.addColorStop(0, '#1d2a44');
  sky.addColorStop(0.55, '#3b4a63');
  sky.addColorStop(1, '#2a2622');
  g.fillStyle = sky;
  g.fillRect(b.x, b.y, b.w, b.h);
  // The wall, the porch floor, the door with its light on.
  const floor = b.y + b.h * 0.78;
  g.fillStyle = '#5b5148';
  g.fillRect(b.x, b.y + b.h * 0.18, b.w, floor - b.y - b.h * 0.18);
  g.fillStyle = '#3a332d';
  g.fillRect(b.x, floor, b.w, b.y + b.h - floor);
  const dw = b.w * 0.2, dh = b.h * 0.5, dx = b.x + b.w * 0.42, dy = floor - dh;
  const glow = g.createRadialGradient(dx + dw / 2, dy - b.h * 0.04, 2, dx + dw / 2, dy - b.h * 0.04, b.w * 0.35);
  glow.addColorStop(0, 'rgba(255,214,150,0.55)');
  glow.addColorStop(1, 'rgba(255,214,150,0)');
  g.fillStyle = glow;
  g.fillRect(b.x, b.y, b.w, b.h);
  g.fillStyle = '#2b2018';
  g.fillRect(dx, dy, dw, dh);
  g.fillStyle = '#6e4a2f';
  g.fillRect(dx + dw * 0.08, dy + dh * 0.05, dw * 0.84, dh * 0.95);
  g.fillStyle = '#d9b26a';
  g.beginPath();
  g.arc(dx + dw * 0.78, dy + dh * 0.55, Math.max(1.5, dw * 0.04), 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffe2a8';
  g.fillRect(dx + dw / 2 - dw * 0.08, dy - b.h * 0.07, dw * 0.16, b.h * 0.04);
  // A plant pot and the doormat.
  g.fillStyle = '#2f4a33';
  g.beginPath();
  g.ellipse(b.x + b.w * 0.24, floor - b.h * 0.12, b.w * 0.05, b.h * 0.11, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#4a3b30';
  g.fillRect(b.x + b.w * 0.205, floor - b.h * 0.05, b.w * 0.07, b.h * 0.06);
  g.fillStyle = '#2a2420';
  g.fillRect(dx - dw * 0.05, floor + b.h * 0.02, dw * 1.1, b.h * 0.05);
  // A wide-angle lens darkens its corners.
  const v = g.createRadialGradient(b.x + b.w / 2, b.y + b.h / 2, Math.min(b.w, b.h) * 0.3, b.x + b.w / 2, b.y + b.h / 2, Math.max(b.w, b.h) * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.5)');
  g.fillStyle = v;
  g.fillRect(b.x, b.y, b.w, b.h);
}
