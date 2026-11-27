/**
 * Several homes (Kiosko 0.2.12 on): the source declares profiles; Kiosko calls
 * `watch` once per profile, and each gets its own WebSocket, token, entities
 * and life. What the widgets keep between fetches (a camera's last picture,
 * a player's cover, a person's photo) is kept per home, so two homes with
 * the same entity ids never share one. Fake Home Assistants only.
 */
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { after, before, test } from 'node:test';
import { createBaseContext, validate } from '@kiosko/sdk';
import { compact, homeKey, type HaData, type RawState } from './ha.ts';
import { camera, media, people, states } from './index.ts';

const SOURCE = 'homeassistant/states';

/** Two fake homes, by WebSocket address: each takes only its token and has its own states. */
const HOMES: Record<string, { token: string; states: RawState[] }> = {
  'ws://flat.local:8123/api/websocket': {
    token: 'flat-token',
    states: [{ entity_id: 'sensor.living_room_temperature', state: '21.4', attributes: { friendly_name: 'Living room', unit_of_measurement: '°C' } }, { entity_id: 'person.ana', state: 'home', attributes: { friendly_name: 'Ana' } }],
  },
  'ws://village.local:8123/api/websocket': {
    token: 'village-token',
    states: [{ entity_id: 'sensor.living_room_temperature', state: '14.0', attributes: { friendly_name: 'Salón del pueblo', unit_of_measurement: '°C' } }, { entity_id: 'binary_sensor.well_pump', state: 'on', attributes: { friendly_name: 'Well pump' } }],
  },
};
const sockets: { url: string; sent: Record<string, unknown>[]; closed: boolean }[] = [];

/** Stands in for Node's WebSocket (the `WsLike` the connection uses) while the tests run: answers like Home Assistant for the homes above. */
class FakeWebSocket {
  private listeners: Record<string, ((ev?: { data: unknown }) => void)[]> = {};
  private rec: (typeof sockets)[number];
  constructor(url: string) {
    this.rec = { url, sent: [], closed: false };
    sockets.push(this.rec);
    queueMicrotask(() => (HOMES[url] ? this.push({ type: 'auth_required', ha_version: '2026.11.1' }) : this.emit('error')));
  }
  private emit(type: string, ev?: { data: unknown }) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
  private push(m: unknown) {
    queueMicrotask(() => this.emit('message', { data: JSON.stringify(m) }));
  }
  send(data: string) {
    const m = JSON.parse(data) as { type: string; id?: number; access_token?: string };
    this.rec.sent.push(m);
    const home = HOMES[this.rec.url]!;
    if (m.type === 'auth') this.push(m.access_token === home.token ? { type: 'auth_ok', ha_version: '2026.11.1' } : { type: 'auth_invalid', message: 'Invalid access token' });
    else if (m.type === 'get_states') this.push({ id: m.id, type: 'result', success: true, result: home.states });
    else if (m.type === 'ping') this.push({ id: m.id, type: 'pong' });
    else this.push({ id: m.id, type: 'result', success: false, error: { code: 'unknown_command', message: 'Unknown command.' } });
  }
  close() {
    this.rec.closed = true;
  }
  addEventListener(type: string, fn: (ev?: { data: unknown }) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
}

const g = globalThis as { WebSocket?: unknown };
const realWebSocket = g.WebSocket;
before(() => void (g.WebSocket = FakeWebSocket));
after(() => void (g.WebSocket = realWebSocket));

function sourceCtx(options: Record<string, unknown>, signal: AbortSignal, profile?: string) {
  return { ...createBaseContext({ now: Date.now(), locale: 'en' }), options: validate(states.options!, options).value as never, signal, intervalMs: 0, timeoutMs: 30_000, ...(profile ? { profile } : {}) };
}

/** Watches until `done` says the data is there. */
async function watchUntil(stop: Map<string, () => void>, name: string, options: Record<string, unknown>, ac: AbortController, profile?: string): Promise<HaData[]> {
  const got: HaData[] = [];
  await new Promise<void>((resolve) => {
    stop.set(name, states.watch!(sourceCtx(options, ac.signal, profile), (d) => {
      got.push(d as HaData);
      if ((d as HaData).state === 'ok' && Object.keys((d as HaData).entities).length) resolve();
    }));
  });
  return got;
}

test('source: declares profiles, in a way an older SDK ignores', () => {
  assert.equal((states as { profiles?: boolean }).profiles, true);
});

test('profiles: two homes, each its own connection, token and entities; stopping one leaves the other', async () => {
  sockets.length = 0;
  const stop = new Map<string, () => void>();
  const flat = new AbortController();
  const village = new AbortController();
  try {
    const [a, b] = await Promise.all([
      watchUntil(stop, 'flat', { url: 'http://flat.local:8123', token: 'flat-token' }, flat),
      watchUntil(stop, 'village', { url: 'http://village.local:8123', token: 'village-token' }, village, 'village'),
    ]);
    const lastA = a.at(-1)!;
    const lastB = b.at(-1)!;
    assert.equal(lastA.base, 'http://flat.local:8123');
    assert.equal(lastB.base, 'http://village.local:8123');
    assert.equal(lastA.entities['sensor.living_room_temperature']!.state, '21.4');
    assert.equal(lastB.entities['sensor.living_room_temperature']!.state, '14.0', 'the same id, each home its own value');
    assert.ok(lastA.entities['person.ana'] && !lastA.entities['binary_sensor.well_pump']);
    assert.ok(lastB.entities['binary_sensor.well_pump'] && !lastB.entities['person.ana']);
    // The entity choices of a form come from its profile's data.
    const ids = (d: HaData) => states.choices!.entities!(d, { locale: 'en', t: (x) => (typeof x === 'string' ? x : x.en ?? '') }).map((c) => c.value);
    assert.deepEqual(ids(lastA), ['person.ana', 'sensor.living_room_temperature']);
    assert.deepEqual(ids(lastB), ['binary_sensor.well_pump', 'sensor.living_room_temperature']);

    assert.equal(sockets.length, 2, 'one WebSocket per home');
    const auth = (url: string) => sockets.find((s) => s.url === url)!.sent.find((m) => m.type === 'auth');
    assert.deepEqual(auth('ws://flat.local:8123/api/websocket'), { type: 'auth', access_token: 'flat-token' });
    assert.deepEqual(auth('ws://village.local:8123/api/websocket'), { type: 'auth', access_token: 'village-token' });

    village.abort();
    stop.get('village')!();
    assert.equal(sockets.find((s) => s.url.includes('village'))!.closed, true);
    assert.equal(sockets.find((s) => s.url.includes('flat'))!.closed, false, 'the flat stays connected');
  } finally {
    flat.abort();
    village.abort();
    for (const s of stop.values()) s();
  }
});

/* ---------- widget caches, per home ---------- */

const png = (color: string) => {
  const c = createCanvas(8, 8);
  const x = c.getContext('2d');
  x.fillStyle = color;
  x.fillRect(0, 0, 8, 8);
  return c.toBuffer('image/png');
};
/** The same entities, with the same ids and picture paths, in two homes. */
const homeData = (base: string): HaData => ({
  state: 'ok',
  base,
  entities: Object.fromEntries(
    [
      compact({ entity_id: 'camera.front_door', state: 'idle', attributes: { friendly_name: 'Front door', entity_picture: '/api/camera_proxy/camera.front_door?token=t' } }),
      compact({ entity_id: 'media_player.living_room', state: 'playing', attributes: { friendly_name: 'Living room', entity_picture: '/api/media_player_proxy/media_player.living_room?token=t', media_title: 'Song', media_album_name: 'Album' } }),
      compact({ entity_id: 'person.ana', state: 'home', attributes: { friendly_name: 'Ana', entity_picture: '/api/image/serve/ana/512x512' } }),
    ].map((e) => [e.id, e]),
  ),
});
const FLAT = homeData('http://flat.local:8123');
const VILLAGE = homeData('http://village.local:8123');
/** Each home serves its pictures in its own colour. */
const COLOUR: Record<string, string> = { 'flat.local:8123': '#ff0000', 'village.local:8123': '#0000ff' };

async function withPictures<T>(run: (asked: string[]) => Promise<T>): Promise<T> {
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    asked.push(u.host + u.pathname);
    return new Response(png(COLOUR[u.host]!), { headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  try {
    return await run(asked);
  } finally {
    globalThis.fetch = real;
  }
}
const widgetCtx = (def: { options?: unknown }, options: Record<string, unknown>, d: HaData) => ({
  ...createBaseContext({ now: Date.now(), locale: 'en' }),
  options: validate(def.options as never, options).value,
  sources: { [SOURCE]: d },
  canvas: { createCanvas, loadImage },
  signal: new AbortController().signal,
  timeoutMs: 30_000,
}) as never;
/** The colour of an image's first pixel. */
function colourOf(img: unknown): string {
  const c = createCanvas(8, 8);
  const x = c.getContext('2d');
  x.drawImage(img as never, 0, 0);
  const [r, gr, b] = x.getImageData(0, 0, 1, 1).data;
  return `#${[r, gr, b].map((v) => v!.toString(16).padStart(2, '0')).join('')}`;
}

test('widget caches: the key is the home and the entity', () => {
  assert.notEqual(homeKey(FLAT, 'camera.front_door'), homeKey(VILLAGE, 'camera.front_door'));
  assert.equal(homeKey(FLAT, 'camera.front_door'), homeKey(homeData('http://flat.local:8123'), 'camera.front_door'), 'two profiles of one home share it');
});

test('media: the same player id in two homes, each its own cover', async () => {
  await withPictures(async (asked) => {
    const a = (await media.fetch!(widgetCtx(media, { entity: 'media_player.living_room' }, FLAT))) as { cover?: unknown };
    const b = (await media.fetch!(widgetCtx(media, { entity: 'media_player.living_room' }, VILLAGE))) as { cover?: unknown };
    assert.equal(colourOf(a.cover), '#ff0000');
    assert.equal(colourOf(b.cover), '#0000ff', 'not the flat\'s cover from the cache');
    assert.deepEqual(asked, ['flat.local:8123/api/media_player_proxy/media_player.living_room', 'village.local:8123/api/media_player_proxy/media_player.living_room']);
    // Each home's cover is still cached for that home.
    await media.fetch!(widgetCtx(media, { entity: 'media_player.living_room' }, VILLAGE));
    assert.equal(asked.length, 2);
  });
});

test('people: the same photo path in two homes, each its own photo', async () => {
  await withPictures(async (asked) => {
    const a = (await people.fetch!(widgetCtx(people, {}, FLAT))) as { photos: Record<string, unknown> };
    const b = (await people.fetch!(widgetCtx(people, {}, VILLAGE))) as { photos: Record<string, unknown> };
    assert.equal(colourOf(a.photos['person.ana']), '#ff0000');
    assert.equal(colourOf(b.photos['person.ana']), '#0000ff');
    assert.equal(asked.length, 2);
  });
});

test('camera: how old a picture is counts per home', async () => {
  await withPictures(async () => {
    const a = (await camera.fetch!(widgetCtx(camera, { entity: 'camera.front_door' }, FLAT))) as { changedAt: number };
    await new Promise((r) => setTimeout(r, 15));
    const b = (await camera.fetch!(widgetCtx(camera, { entity: 'camera.front_door' }, VILLAGE))) as { changedAt: number };
    assert.ok(b.changedAt > a.changedAt, 'the village picture is new, not "changed when the flat\'s did"');
    await new Promise((r) => setTimeout(r, 15));
    const a2 = (await camera.fetch!(widgetCtx(camera, { entity: 'camera.front_door' }, FLAT))) as { changedAt: number };
    assert.equal(a2.changedAt, a.changedAt, 'the flat\'s unchanged picture keeps its time');
  });
});
