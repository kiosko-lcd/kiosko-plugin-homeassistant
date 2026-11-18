import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as kit from '@loksly/lcd-canvas-kit';
import { createBaseContext, DEFAULT_THEME, DEFAULT_WORKDAY, validate, type WidgetDefinition } from '@kiosko/sdk';
import {
  camera, clock, energy, energyStats, energyToday, flows, formatPower, homeToday, initials, media, people, pickPlayer, positionNow, ringing, watts, whereText,
} from './index.ts';
import { compact, demoHome, type Entity, type HaData } from './ha.ts';

const NOW = Date.parse('2026-11-16T10:00:00');
const SOURCE = 'homeassistant/states';
const home = (locale = 'en') => demoHome(NOW, locale);

function texts(w: WidgetDefinition<any, any>, options: Record<string, unknown>, d: HaData | undefined, data?: unknown, size = { w: 420, h: 300 }, locale = 'en'): string[] {
  const out: string[] = [];
  const spy = { ...kit, drawTracked: (...a: Parameters<typeof kit.drawTracked>) => (out.push(a[1]), kit.drawTracked(...a)) };
  const canvas = createCanvas(size.w, size.h);
  w.render(canvas.getContext('2d'), {
    ...createBaseContext({ now: NOW, locale, timeFormat: '24h' }), options: validate(w.options!, options).value, data, sources: { [SOURCE]: d }, working: true,
    box: { x: 0, y: 0, w: size.w, h: size.h }, theme: DEFAULT_THEME, fonts: DEFAULT_THEME.fonts, kit: spy, canvas: { createCanvas, loadImage }, preview: false,
  } as never);
  return out;
}
const state = (w: WidgetDefinition<any, any>, fn: 'urgent' | 'empty' | 'idle', options: Record<string, unknown>, d: HaData, now = NOW) =>
  w[fn]!({ options: validate(w.options!, options).value, data: undefined, sources: { [SOURCE]: d }, now, working: true, workday: DEFAULT_WORKDAY } as never);
const sensor = (id: string, state: string, unit = 'W'): Entity => ({ id, domain: id.split('.')[0]!, name: id, state, unit, changedAt: NOW });

/* ---------- energy ---------- */

test('flows: the sun goes to the house first, then the battery, then the grid', () => {
  // 3 kW of sun, the house takes 1.2, the battery 0.5, 1.3 sold.
  assert.deepEqual(flows({ solar: 3000, battery: -500, grid: -1300 }), { solarHome: 1200, solarGrid: 1300, solarBattery: 500, gridHome: 0, gridBattery: 0, batteryHome: 0, batteryGrid: 0, home: 1200 });
  // Night: the battery and the grid share the house.
  assert.deepEqual(flows({ solar: 0, battery: 400, grid: 300 }), { solarHome: 0, solarGrid: 0, solarBattery: 0, gridHome: 300, gridBattery: 0, batteryHome: 400, batteryGrid: 0, home: 700 });
  // Charging the battery from the grid.
  assert.equal(flows({ grid: 2000, battery: -1500 }).gridBattery, 1500);
  // Only a grid sensor.
  assert.equal(flows({ grid: 850 }).home, 850);
});

test('power and energy in words; kW sensors are converted', () => {
  assert.equal(watts(sensor('sensor.p', '1.5', 'kW')), 1500);
  assert.equal(watts(sensor('sensor.p', 'unavailable')), undefined);
  assert.equal(formatPower(850, 'en'), '850 W');
  assert.equal(formatPower(-1534, 'es'), '1,53 kW');
  assert.equal(homeToday({ gridIn: 3, gridOut: 4, solar: 14, batteryIn: 3, batteryOut: 2, at: 0 }), 12);
});

test("energy prefs: which statistics hold each flow; today's change summed", () => {
  const stats = energyStats({ energy_sources: [
    { type: 'grid', flow_from: [{ stat_energy_from: 'sensor.a' }, { stat_energy_from: 'sensor.b' }], flow_to: [{ stat_energy_to: 'sensor.out' }] },
    { type: 'battery', stat_energy_from: 'sensor.bat_out', stat_energy_to: 'sensor.bat_in', stat_rate: 'sensor.bat_power' },
  ] });
  assert.deepEqual(stats, { gridIn: ['sensor.a', 'sensor.b'], gridOut: ['sensor.out'], solar: [], batteryIn: ['sensor.bat_in'], batteryOut: ['sensor.bat_out'], power: { battery: 'sensor.bat_power' } });
  const today = energyToday(stats, { 'sensor.a': [{ change: 1.5 }], 'sensor.b': [{ change: 2 }], 'sensor.out': [{ change: null }], 'sensor.bat_in': [] }, 5);
  assert.deepEqual(today, { at: 5, gridIn: 3.5, gridOut: 0, batteryIn: 0, batteryOut: 0, power: { battery: 'sensor.bat_power' } });
  assert.deepEqual(energyStats(null), { gridIn: [], gridOut: [], solar: [], batteryIn: [], batteryOut: [], power: {} });
});

test('energy widget: the parts it has data for; the dashboard sensors when none is chosen; a hint when there are none', () => {
  const d = home();
  const all = texts(energy, { grid: 'sensor.grid_power', solar: 'sensor.solar_power', battery: 'sensor.battery_power', batteryLevel: 'sensor.battery_level' }, d);
  assert.ok(all.some((s) => /kWh/.test(s)), 'today under the parts');
  assert.ok(all.includes('64 %'), 'the battery level');
  // Only the grid: two parts, grid and house.
  const g = { ...d, energy: undefined };
  assert.deepEqual(texts(energy, { grid: 'sensor.grid_power', showToday: false }, g).length, 2);
  // From the Energy dashboard.
  const fromPrefs = { ...d, energy: { ...d.energy!, power: { grid: 'sensor.grid_power' } } };
  assert.equal(texts(energy, { showToday: false }, fromPrefs).length, 2);
  assert.deepEqual(texts(energy, {}, { ...d, energy: undefined }).slice(0, 1), ['Choose the power sensors']);
});

/* ---------- now playing ---------- */

test('now playing: of several, the one playing; where the track is now', () => {
  const d = home();
  assert.equal(pickPlayer(d.entities, '')!.id, 'media_player.living_room_speaker');
  assert.equal(pickPlayer(d.entities, 'media_player.living_room_tv')!.id, 'media_player.living_room_tv');
  assert.equal(pickPlayer(d.entities, '!media_player.living_room_speaker')!.id, 'media_player.living_room_tv');
  const e: Entity = { ...sensor('media_player.x', 'playing'), media: { duration: 200, position: 100, positionAt: NOW - 30_000 } };
  assert.equal(positionNow(e, NOW), 130);
  assert.equal(positionNow({ ...e, state: 'paused' }, NOW), 100);
  assert.equal(positionNow(e, NOW + 999_000), 200, 'never past the end');
  assert.equal(clock(187), '3:07');
  assert.equal(clock(3765), '1:02:45');
});

test('now playing: compact keeps what a player says; the widget paints it, or hides when nothing plays', () => {
  const e = compact({ entity_id: 'media_player.tv', state: 'playing', attributes: { friendly_name: 'TV', media_title: 'Episode 3', media_series_title: 'The Show', app_name: 'Netflix', media_duration: 2700, media_position: 60, media_position_updated_at: '2026-11-16T09:59:00+00:00', entity_picture: '/api/media_player_proxy/media_player.tv?token=x' } });
  assert.deepEqual(e.media, { title: 'Episode 3', artist: 'The Show', app: 'Netflix', duration: 2700, position: 60, positionAt: Date.parse('2026-11-16T09:59:00+00:00') });
  assert.equal(e.picture, '/api/media_player_proxy/media_player.tv?token=x');
  const d = home();
  const out = texts(media, { entity: 'media_player.living_room_speaker' }, d, { demo: true }, { w: 460, h: 160 });
  assert.deepEqual(out.slice(0, 3), ['Blue in Green', 'Miles Davis', 'Kind of Blue · Spotify']);
  const off = structuredClone(d);
  off.entities['media_player.living_room_speaker']!.state = 'off';
  assert.equal(state(media, 'empty', { entity: 'media_player.living_room_speaker' }, off), true);
  assert.equal(state(media, 'empty', { entity: 'media_player.living_room_speaker' }, d), false);
  assert.deepEqual(texts(media, { entity: 'media_player.living_room_speaker' }, off, undefined, { w: 460, h: 160 }), ['Nothing playing', 'Living room speaker']);
});

/* ---------- the doorbell ---------- */

test('doorbell: an event that rang in the last minute, or a sensor on; it marks the camera and makes it urgent', () => {
  const ev = (at: number): Entity => ({ ...sensor('event.front_door_ding', new Date(at).toISOString(), ''), domain: 'event' });
  assert.equal(ringing(ev(NOW - 20_000), NOW), true);
  assert.equal(ringing(ev(NOW - 90_000), NOW), false);
  assert.equal(ringing({ ...sensor('event.x', 'unknown', ''), domain: 'event' }, NOW), false);
  assert.equal(ringing(sensor('binary_sensor.ding', 'on', ''), NOW), true);
  const d = home();
  d.entities['event.front_door_ding'] = ev(NOW - 10_000);
  const o = { entity: 'camera.porch', doorbell: 'event.front_door_ding' };
  assert.equal(state(camera, 'urgent', o, d), true);
  assert.equal(state(camera, 'urgent', o, d, NOW + 120_000), false);
  assert.ok(texts(camera, o, d, { state: 'ok', demo: true, changedAt: NOW }).includes('Doorbell'));
});

/* ---------- who is home ---------- */

test('who is home: everyone with where they are; initials without a photo', () => {
  const d = home();
  assert.deepEqual(texts(people, {}, d, { photos: {} }, { w: 420, h: 160 }), ['A', 'Alex', 'Home · 4 h', 'R', 'Robin', 'Away · 35 min', 'S', 'Sam', 'Work · 6 h']);
  assert.deepEqual(texts(people, { homeFirst: true, showSince: false, people: ['person.sam', 'person.alex'] }, d, { photos: {} }, { w: 420, h: 160 }).filter((_, i) => i % 3 === 1), ['Alex', 'Sam']);
  assert.equal(initials('Alex Pérez'), 'AP');
  assert.equal(initials('sam'), 'S');
  const tr = (l: { en: string }) => l.en;
  assert.equal(whereText(sensor('person.x', 'not_home', ''), tr as never), 'Away');
  assert.equal(compact({ entity_id: 'person.alex', state: 'home', attributes: { entity_picture: '/api/image/serve/abc/512x512' } }).photo, '/api/image/serve/abc/512x512');
});

test('every new widget paints every state at every size without throwing', () => {
  const datas: (HaData | undefined)[] = [undefined, { state: 'unconfigured', entities: {} }, { state: 'connecting', entities: {} }, { ...home(), state: 'offline', since: NOW }, home(), home('es')];
  for (const w of [energy, media, people]) {
    for (const d of datas) {
      for (const size of [w.size!.min!, w.size!.preferred!, { w: 900, h: 120 }, { w: 160, h: 400 }]) {
        assert.doesNotThrow(() => texts(w, w.demo!({ now: NOW, locale: 'en', options: {} as never }).options ?? {}, d, { demo: true, photos: {} }, size), `${w.id} ${d?.state} ${size.w}x${size.h}`);
      }
    }
  }
});
