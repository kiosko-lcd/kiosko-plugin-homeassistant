import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBaseContext } from '@kiosko/sdk';
import {
  compact, DEFAULT_LEVELS, demoHome, formatNumber, History, levelOf, noticeOf, notices, numericState, parseHistory, pick, stateText, wantsHistory, websocketUrl,
  type AttentionOptions, type Entity,
} from './ha.ts';

const NOW = Date.parse('2026-11-16T10:00:00Z');
const ent = (id: string, state: string, o: Partial<Entity> = {}): Entity => ({ id, domain: id.split('.')[0]!, name: id, state, changedAt: NOW - 60_000, ...o });
const ctx = (locale = 'en') => createBaseContext({ now: NOW, locale, timeFormat: '24h' });

test('compact keeps what the widgets paint', () => {
  const e = compact({
    entity_id: 'climate.living_room',
    state: 'heat',
    attributes: { friendly_name: 'Thermostat', current_temperature: 21.4, temperature: 22, hvac_action: 'heating', hvac_modes: ['off', 'heat'], unit_of_measurement: '°C' },
    last_changed: '2026-11-16T09:00:00Z',
  });
  assert.deepEqual(e, { id: 'climate.living_room', domain: 'climate', name: 'Thermostat', state: 'heat', unit: '°C', current: 21.4, target: 22, action: 'heating', changedAt: Date.parse('2026-11-16T09:00:00Z') });
  assert.equal(compact({ entity_id: 'sensor.x', state: '3' }).name, 'sensor.x');
  assert.equal(compact({ entity_id: 'sensor.x', state: '3' }).changedAt, 0);
  // `temperature` is a target only on climate entities.
  assert.equal(compact({ entity_id: 'weather.home', state: 'sunny', attributes: { temperature: 12 } }).target, undefined);
});

test('websocketUrl', () => {
  assert.equal(websocketUrl('http://homeassistant.local:8123'), 'ws://homeassistant.local:8123/api/websocket');
  assert.equal(websocketUrl('https://home.example.com/'), 'wss://home.example.com/api/websocket');
  assert.equal(websocketUrl('192.168.1.10:8123'), 'ws://192.168.1.10:8123/api/websocket');
  assert.equal(websocketUrl('wss://h.example.com/api/websocket'), 'wss://h.example.com/api/websocket');
  assert.equal(websocketUrl(' https://h.example.com/ha/ '), 'wss://h.example.com/ha/api/websocket');
});

test('numbers and units', () => {
  assert.equal(numericState({ state: '21.5' }), 21.5);
  assert.equal(numericState({ state: '-3' }), -3);
  assert.equal(numericState({ state: 'on' }), undefined);
  assert.equal(numericState({ state: '' }), undefined);
  assert.equal(numericState({ state: '2026-11-16T09:00:00Z' }), undefined);
  assert.equal(formatNumber(21.456, 'en'), '21.5');
  assert.equal(formatNumber(1534.4, 'en'), '1,534');
  assert.equal(formatNumber(7.846, 'en'), '7.85');
  assert.equal(formatNumber(21.456, 'es'), '21,5');
  assert.equal(formatNumber(21, 'en', 1), '21.0');
});

test('stateText says the state as a person would', () => {
  const en = ctx('en'), es = ctx('es');
  assert.equal(stateText(ent('sensor.t', '21.46', { unit: '°C' }), en), '21.5 °C');
  assert.equal(stateText(ent('sensor.h', '48', { unit: '%' }), es), '48 %');
  assert.equal(stateText(ent('binary_sensor.d', 'on', { deviceClass: 'door' }), en), 'Open');
  assert.equal(stateText(ent('binary_sensor.d', 'off', { deviceClass: 'window' }), es), 'Cerrada');
  // A state, not an action: 已打开, not 打开.
  assert.equal(stateText(ent('binary_sensor.d', 'on', { deviceClass: 'door' }), ctx('zh-CN')), '已打开');
  assert.equal(stateText(ent('cover.garage', 'closed'), ctx('zh-TW')), '已關閉');
  assert.equal(stateText(ent('binary_sensor.m', 'on', { deviceClass: 'motion' }), en), 'Motion');
  assert.equal(stateText(ent('binary_sensor.x', 'on'), en), 'On');
  assert.equal(stateText(ent('lock.front', 'unlocked'), en), 'Unlocked');
  assert.equal(stateText(ent('person.sam', 'not_home'), es), 'Fuera');
  assert.equal(stateText(ent('person.sam', 'Work'), en), 'Work');
  assert.equal(stateText(ent('climate.t', 'heat', { current: 21.4, action: 'heating', unit: '°C' }), en), '21.4 °C · heating');
  assert.equal(stateText(ent('climate.t', 'heat', { current: 21.4, action: 'idle', unit: '°C' }), en), '21.4 °C');
  assert.equal(stateText(ent('sensor.t', 'unavailable'), es), 'No disponible');
  assert.equal(stateText(ent('vacuum.r', 'some_new_state'), en), 'Some new state');
  assert.equal(stateText(ent('sensor.last_boot', '2026-11-16T07:00:00Z', { deviceClass: 'timestamp' }), en), '3 h ago');
});

test('levelOf: loud only when it asks for the user', () => {
  const lv = (id: string, state: string, o: Partial<Entity> = {}) => levelOf(ent(id, state, o));
  assert.equal(lv('binary_sensor.smoke', 'on', { deviceClass: 'smoke' }), 'alert');
  assert.equal(lv('binary_sensor.leak', 'on', { deviceClass: 'moisture' }), 'alert');
  assert.equal(lv('binary_sensor.leak', 'off', { deviceClass: 'moisture' }), 'off');
  assert.equal(lv('binary_sensor.door', 'on', { deviceClass: 'door' }), 'warn');
  assert.equal(lv('binary_sensor.motion', 'on', { deviceClass: 'motion' }), 'on');
  assert.equal(lv('binary_sensor.net', 'off', { deviceClass: 'connectivity' }), 'warn');
  assert.equal(lv('binary_sensor.net', 'on', { deviceClass: 'connectivity' }), 'off');
  assert.equal(lv('lock.front', 'jammed'), 'alert');
  assert.equal(lv('lock.front', 'unlocked'), 'warn');
  assert.equal(lv('lock.front', 'locked'), 'off');
  assert.equal(lv('cover.garage', 'open', { deviceClass: 'garage' }), 'warn');
  assert.equal(lv('cover.blinds', 'open', { deviceClass: 'blind' }), 'on');
  assert.equal(lv('alarm_control_panel.home', 'triggered'), 'alert');
  assert.equal(lv('alarm_control_panel.home', 'armed_away'), 'on');
  assert.equal(lv('sensor.b', '9', { deviceClass: 'battery' }), 'alert');
  assert.equal(lv('sensor.b', '15', { deviceClass: 'battery' }), 'warn');
  assert.equal(lv('sensor.b', '80', { deviceClass: 'battery' }), 'off');
  assert.equal(levelOf(ent('sensor.b', '15', { deviceClass: 'battery' }), { batteryWarn: 10, batteryAlert: 5 }), 'off');
  assert.equal(lv('sensor.t', '45', { unit: '°C' }), 'off');
  assert.equal(lv('light.k', 'on'), 'on');
  assert.equal(lv('sensor.t', 'unavailable'), 'na');
});

test('pick lists in the order of the patterns, each group by name', () => {
  const all = Object.fromEntries([
    ent('light.b', 'on', { name: 'B light' }), ent('light.a', 'off', { name: 'A light' }), ent('sensor.kitchen_temperature', '20', { name: 'Kitchen' }),
    ent('sensor.bed_temperature', '19', { name: 'Bedroom' }), ent('light.porch', 'on', { name: 'Porch' }),
  ].map((e) => [e.id, e]));
  assert.deepEqual(pick(all, ['sensor.*_temperature', 'light.*', '!light.porch']).map((e) => e.id), ['sensor.bed_temperature', 'sensor.kitchen_temperature', 'light.a', 'light.b']);
  assert.deepEqual(pick(all, '*kitchen*').map((e) => e.id), ['sensor.kitchen_temperature']);
  // By name too, without case.
  assert.deepEqual(pick(all, 'porch').map((e) => e.id), ['light.porch']);
  assert.equal(pick(all, []).length, 5);
});

const attn = (o: Partial<AttentionOptions> = {}): AttentionOptions => ({
  ...DEFAULT_LEVELS, entities: [], includeOpenings: true, includeBatteries: true, includeProblems: true, includeUnavailable: false, includeUpdates: false, openMs: 0, ...o,
});

test('notices: dangers first, then the oldest; toggles and openMs', () => {
  const all = Object.fromEntries([
    ent('binary_sensor.balcony', 'on', { deviceClass: 'door', changedAt: NOW - 3_600_000 }),
    ent('binary_sensor.bath', 'on', { deviceClass: 'window', changedAt: NOW - 60_000 }),
    ent('binary_sensor.leak', 'on', { deviceClass: 'moisture', changedAt: NOW - 30_000 }),
    ent('sensor.remote_battery', '7', { deviceClass: 'battery', changedAt: NOW - 86_400_000 }),
    ent('binary_sensor.sensor_battery_low', 'on', { deviceClass: 'battery' }),
    ent('lock.front', 'unlocked', { changedAt: NOW - 120_000 }),
    ent('binary_sensor.problem', 'on', { deviceClass: 'problem' }),
    ent('sensor.garage', 'unavailable', { changedAt: NOW - 7_200_000 }),
    ent('button.restart', 'unavailable'),
    ent('update.core', 'on'),
    ent('light.k', 'on'),
  ].map((e) => [e.id, e]));
  const ids = (o: Partial<AttentionOptions> = {}) => notices(all, attn(o), NOW).map((n) => n.entity.id);
  assert.deepEqual(ids(), ['binary_sensor.leak', 'sensor.remote_battery', 'binary_sensor.balcony', 'lock.front', 'binary_sensor.bath', 'binary_sensor.problem', 'binary_sensor.sensor_battery_low']);
  assert.ok(!ids({ includeOpenings: false }).includes('lock.front'));
  assert.ok(!ids({ includeBatteries: false }).some((id) => id.includes('battery')));
  assert.ok(!ids({ includeProblems: false }).includes('binary_sensor.problem'));
  // Unavailable: devices only, not buttons.
  assert.ok(ids({ includeUnavailable: true }).includes('sensor.garage'));
  assert.ok(!ids({ includeUnavailable: true }).includes('button.restart'));
  assert.ok(ids({ includeUpdates: true }).includes('update.core'));
  // A window open for a minute doesn't count yet with openMs 5 min; the hour-old door does.
  assert.ok(!ids({ openMs: 300_000 }).includes('binary_sensor.bath'));
  assert.ok(ids({ openMs: 300_000 }).includes('binary_sensor.balcony'));
  // Dangers stay whatever the toggles say; the filter leaves out.
  assert.deepEqual(ids({ includeOpenings: false, includeBatteries: false, includeProblems: false }), ['binary_sensor.leak']);
  assert.ok(!ids({ entities: ['!binary_sensor.balcony'] }).includes('binary_sensor.balcony'));
  assert.deepEqual(noticeOf(ent('sensor.remote_battery', '7', { deviceClass: 'battery' }), attn(), NOW)?.what, { en: 'Battery 7 %', es: 'Batería 7 %', de: 'Batterie 7 %', 'zh-Hant': '電池 7 %', 'zh-Hans': '电池 7 %' });
});

test('History: five-minute means, the last value held, trimmed to the span', () => {
  const h = new History(3_600_000, 300_000);
  const t0 = Date.parse('2026-11-16T09:00:00Z');
  h.add('sensor.x', t0, 1); // not tracked: ignored
  assert.equal(h.has('sensor.x'), false);
  h.track('sensor.x');
  h.add('sensor.x', t0, 10, t0);
  h.add('sensor.x', t0 + 60_000, 20, t0); // same bucket: mean 15
  h.add('sensor.x', t0 + 1_800_000, 30, t0 + 1_800_000);
  h.add('sensor.x', t0 + 10_000, 99, t0 + 1_800_000); // older than the newest bucket: ignored
  const now = t0 + 3_599_000;
  const v = h.values('sensor.x', now, 3_600_000, 12);
  assert.equal(v.length, 12);
  // Bucket 0 is the mean of 10 and 20; then the sensor holds 20.
  assert.deepEqual(v.slice(0, 6), [15, 20, 20, 20, 20, 20]);
  assert.deepEqual(v.slice(6), [30, 30, 30, 30, 30, 30]);
  // The open bucket is its latest value, not its mean.
  h.add('sensor.x', t0 + 3_400_000, 50, t0 + 3_400_000);
  h.add('sensor.x', t0 + 3_500_000, 60, t0 + 3_500_000);
  assert.equal(h.values('sensor.x', t0 + 3_590_000, 3_600_000, 12).at(-1), 60);
  // Once closed, the bucket is its mean, and the next ones hold its last value.
  assert.equal(h.values('sensor.x', t0 + 3_700_000, 3_600_000, 12).at(-1), 60);
  assert.equal(h.values('sensor.x', t0 + 3_700_000, 3_600_000, 12).at(-2), 55);
  // Before the first sample there is nothing.
  assert.ok(Number.isNaN(h.values('sensor.x', t0 + 600_000, 3_600_000, 12)[0]!));
  // A day later only the last value remains, still held.
  h.add('sensor.x', t0 + 86_400_000, 40, t0 + 86_400_000);
  const later = h.values('sensor.x', t0 + 86_400_000, 3_600_000, 12);
  assert.deepEqual([later[0], later.at(-2), later.at(-1)], [60, 60, 40]);
  h.forget('sensor.x');
  assert.equal(h.size, 0);
});

test('parseHistory reads the compressed minimal format', () => {
  assert.deepEqual(parseHistory([{ s: '20.5', lu: 1_763_280_000.5 }, { s: 'unavailable', lu: 1_763_280_300 }, { s: '21', lc: 1_763_280_600 }]), [
    { at: 1_763_280_000_500, value: 20.5 },
    { at: 1_763_280_600_000, value: 21 },
  ]);
  assert.deepEqual(parseHistory([{ state: '3', last_changed: '2026-11-16T09:00:00Z' }]), [{ at: Date.parse('2026-11-16T09:00:00Z'), value: 3 }]);
  assert.deepEqual(parseHistory(null), []);
});

test('wantsHistory: numbers that measure something', () => {
  assert.equal(wantsHistory(ent('sensor.t', '21', { unit: '°C' })), true);
  assert.equal(wantsHistory(ent('input_number.x', '3', { stateClass: 'measurement' })), true);
  assert.equal(wantsHistory(ent('sensor.ip', '192.168.1.2')), false);
  assert.equal(wantsHistory(ent('sensor.count', '3')), false);
  assert.equal(wantsHistory(ent('sensor.t', 'unavailable', { unit: '°C' })), false);
});

test('demo: a believable home, its states where its history ends', () => {
  const d = demoHome(NOW, 'es');
  assert.equal(d.state, 'ok');
  assert.equal(d.entities['binary_sensor.balcony_door']!.name, 'Puerta del balcón');
  const t = d.entities['sensor.living_room_temperature']!;
  const v = d.history!.values(t.id, NOW, 3_600_000, 4);
  assert.ok(Math.abs(v.at(-1)! - Number(t.state)) < 0.1);
});

test('a refused token is a hint the user reads in their language; other errors as they came', async () => {
  const { errorHint } = await import('./draw.ts');
  assert.match(errorHint('token refused: invalid', ctx('zh-TW').t)!, /^權杖遭拒/);
  assert.match(errorHint('token refused', ctx('es').t)!, /^Token rechazado/);
  assert.equal(errorHint('cannot reach Home Assistant', ctx('zh-CN').t), 'cannot reach Home Assistant');
});
