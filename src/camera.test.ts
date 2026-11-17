import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as kit from '@loksly/lcd-canvas-kit';
import { createBaseContext, DEFAULT_THEME, DEFAULT_WORKDAY, validate } from '@kiosko/sdk';
import plugin, { camera, motionOf, pictureChangedAt, placePicture, type CameraData } from './index.ts';
import { compact, demoHome, httpBase, type HaData } from './ha.ts';

const NOW = Date.parse('2026-11-16T10:00:00');
const SOURCE = 'homeassistant/states';
const home = (locale = 'en') => demoHome(NOW, locale);
const opts = (o: Record<string, unknown>) => validate(camera.options!, o).value;

/** Renders the camera and returns every text it drew, in order. */
function texts(options: Record<string, unknown>, d: HaData | undefined, data: CameraData | undefined, size = { w: 400, h: 260 }, locale = 'en'): string[] {
  const out: string[] = [];
  const spy = { ...kit, drawTracked: (...a: Parameters<typeof kit.drawTracked>) => (out.push(a[1]), kit.drawTracked(...a)) };
  const canvas = createCanvas(size.w, size.h);
  const theme = DEFAULT_THEME;
  camera.render(canvas.getContext('2d'), {
    ...createBaseContext({ now: NOW, locale, timeFormat: '24h' }), options: opts(options), data, sources: { [SOURCE]: d }, working: true,
    box: { x: 0, y: 0, w: size.w, h: size.h }, theme, fonts: theme.fonts, kit: spy, canvas: { createCanvas, loadImage }, preview: false,
  } as never);
  return out;
}

/** Runs the widget's fetch against a fake Home Assistant. */
async function fetchWith(options: Record<string, unknown>, d: HaData | undefined, answer: (url: string) => Response) {
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => (asked.push(String(url)), answer(String(url)))) as typeof fetch;
  try {
    const data = await camera.fetch!({
      ...createBaseContext({ now: NOW, locale: 'en', timeFormat: '24h' }), options: opts(options), sources: { [SOURCE]: d },
      canvas: { createCanvas, loadImage }, signal: new AbortController().signal, timeoutMs: 30_000,
    } as never);
    return { data, asked };
  } finally {
    globalThis.fetch = real;
  }
}

const png = (color: string) => {
  const c = createCanvas(64, 48);
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.fillRect(0, 0, 64, 48);
  return c.toBuffer('image/png');
};

test('the plugin has a camera widget, after the other three', () => {
  assert.deepEqual(plugin.widgets!.map((w) => w.id), ['entity', 'entities', 'attention', 'camera']);
});

test('compact keeps the picture of cameras and image entities, and nothing else', () => {
  const pic = '/api/camera_proxy/camera.porch?token=abc';
  assert.equal(compact({ entity_id: 'camera.porch', state: 'idle', attributes: { entity_picture: pic } }).picture, pic);
  assert.equal(compact({ entity_id: 'image.doorbell', state: '2026-11-16', attributes: { entity_picture: '/api/image_proxy/image.doorbell?token=x' } }).picture, '/api/image_proxy/image.doorbell?token=x');
  // A person's photo is not a camera.
  assert.equal(compact({ entity_id: 'person.alex', state: 'home', attributes: { entity_picture: '/local/alex.jpg' } }).picture, undefined);
});

test('httpBase: where the HTTP API is, whatever address was typed', () => {
  assert.equal(httpBase('http://homeassistant.local:8123/'), 'http://homeassistant.local:8123');
  assert.equal(httpBase('homeassistant.local:8123'), 'http://homeassistant.local:8123');
  assert.equal(httpBase(' https://casa.example.com '), 'https://casa.example.com');
  assert.equal(httpBase('wss://casa.example.com/api/websocket'), 'https://casa.example.com');
});

test('the motion sensor: the chosen one, or <camera>_motion as Blink names it', () => {
  const e = home().entities;
  assert.equal(motionOf(e, 'camera.porch', '')?.id, 'binary_sensor.porch_motion');
  assert.equal(motionOf(e, 'camera.porch', 'binary_sensor.hallway_motion')?.id, 'binary_sensor.hallway_motion');
  assert.equal(motionOf(e, 'camera.garden', ''), undefined);
});

test('how old a picture is counts from when it changed, not from when it was read', () => {
  const a = new Uint8Array([1, 2, 3]);
  assert.equal(pictureChangedAt('camera.t1', a, 1000), 1000);
  assert.equal(pictureChangedAt('camera.t1', a, 5000), 1000, 'the same picture again');
  assert.equal(pictureChangedAt('camera.t1', new Uint8Array([9]), 7000), 7000, 'a new one');
  assert.equal(pictureChangedAt('camera.t2', a, 8000), 8000, 'each camera on its own');
});

test('placePicture: cover fills and crops, contain fits whole; keep chooses what stays', () => {
  const box = { x: 0, y: 0, w: 400, h: 200 };
  assert.deepEqual(placePicture(box, 400, 400, 'cover', 0.5), { x: 0, y: -100, w: 400, h: 400 });
  assert.deepEqual(placePicture(box, 400, 400, 'cover', 0), { x: 0, y: 0, w: 400, h: 400 });
  assert.deepEqual(placePicture(box, 400, 400, 'contain', 0.5), { x: 100, y: 0, w: 200, h: 200 });
});

test('fetch reads the picture at the path the camera carries, with its own token, and says why when it cannot', async () => {
  const d = home();
  const ok = await fetchWith({ entity: 'camera.porch' }, d, () => new Response(png('#336')));
  assert.deepEqual(ok.asked, ['http://homeassistant.local:8123/api/camera_proxy/camera.porch?token=demo']);
  assert.equal(ok.data.state, 'ok');
  assert.equal(ok.data.img!.width, 64);
  // Nothing asked of Home Assistant until there is something to ask.
  for (const [o, data, state] of [
    [{ entity: '' }, d, 'pick'],
    [{ entity: 'camera.porch' }, undefined, 'waiting'],
    [{ entity: 'camera.porch' }, { state: 'connecting', entities: {}, base: 'http://h' } as HaData, 'waiting'],
    [{ entity: 'camera.garden' }, d, 'missing'],
    [{ entity: 'sensor.house_power' }, d, 'nopicture'],
  ] as const) {
    const r = await fetchWith(o, data, () => new Response(png('#000')));
    assert.equal(r.data.state, state, JSON.stringify(o));
    assert.deepEqual(r.asked, []);
  }
  // A refusal is an error (Kiosko keeps the last picture and shows the error).
  await assert.rejects(fetchWith({ entity: 'camera.porch' }, d, () => new Response('', { status: 403 })), /HTTP 403/);
  // While waiting for the connection it looks again soon; with a picture, every minute (or as set).
  assert.equal(camera.intervalOf!({ options: opts({}), data: { state: 'waiting' } }), 5_000);
  assert.equal(camera.intervalOf!({ options: opts({}), data: { state: 'ok' } }), undefined);
});

test('render: the picture with its name and age; motion and trouble on top; a hint when there is no picture', async () => {
  const d = home();
  const img = await loadImage(png('#456'));
  const data: CameraData = { state: 'ok', img, changedAt: NOW - 3 * 60_000 };
  assert.deepEqual(texts({ entity: 'camera.porch' }, d, data), ['3 min ago', 'Porch']);
  assert.deepEqual(texts({ entity: 'camera.porch' }, home('es'), data, undefined, 'es'), ['hace 3 min', 'Porche']);
  assert.deepEqual(texts({ entity: 'camera.porch', name: 'Entrada', showAge: false }, d, data), ['Entrada']);
  assert.deepEqual(texts({ entity: 'camera.porch', showName: false, showAge: false }, d, data), []);
  // Someone at the door: a red mark, and the widget is urgent (it takes the tile if the user lets it).
  const moving = structuredClone(d);
  moving.entities['binary_sensor.porch_motion']!.state = 'on';
  assert.ok(texts({ entity: 'camera.porch' }, moving, data).includes('Motion'));
  const urgent = (o: Record<string, unknown>, h: HaData) => camera.urgent!({ options: opts(o), data, sources: { [SOURCE]: h }, now: NOW, working: true, workday: DEFAULT_WORKDAY });
  assert.equal(urgent({ entity: 'camera.porch' }, moving), true);
  assert.equal(urgent({ entity: 'camera.porch' }, d), false);
  assert.equal(camera.takeOver, false);
  // The last picture stays when the connection drops or the camera goes away, and says so.
  assert.ok(texts({ entity: 'camera.porch' }, { ...d, state: 'offline', since: NOW - 60_000 }, data).includes('offline'));
  const gone = structuredClone(d);
  gone.entities['camera.porch']!.state = 'unavailable';
  assert.ok(texts({ entity: 'camera.porch' }, gone, data).includes('camera unavailable'));
  // No picture: why.
  assert.deepEqual(texts({ entity: '' }, d, { state: 'pick' }).slice(0, 1), ['Choose a camera']);
  assert.deepEqual(texts({ entity: 'camera.garden' }, d, { state: 'missing' }), ['Camera not found', 'camera.garden']);
  assert.deepEqual(texts({ entity: 'camera.x' }, { state: 'unconfigured', entities: {} }, undefined).slice(0, 1), ['Home Assistant not set up']);
  assert.deepEqual(texts({ entity: 'camera.porch' }, d, undefined), ['Waiting for the camera…']);
});

test('every state paints at every size without throwing', async () => {
  const img = await loadImage(png('#456'));
  const datas: [HaData | undefined, CameraData | undefined][] = [
    [undefined, undefined],
    [{ state: 'unconfigured', entities: {} }, undefined],
    [{ state: 'error', error: 'token refused', entities: {} }, undefined],
    [home(), { state: 'ok', img, changedAt: NOW }],
    [home(), { state: 'ok', demo: true, changedAt: NOW }],
    [{ ...home(), state: 'offline', since: NOW }, { state: 'ok', img }],
  ];
  for (const [d, data] of datas) {
    for (const size of [camera.size!.min!, camera.size!.preferred!, { w: 900, h: 120 }, { w: 160, h: 400 }]) {
      assert.doesNotThrow(() => texts({ entity: 'camera.porch', fit: 'contain' }, d, data, size), `${d?.state} ${data?.state} ${size.w}x${size.h}`);
    }
  }
});
