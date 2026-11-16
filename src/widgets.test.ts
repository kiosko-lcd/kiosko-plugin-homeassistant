import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import * as kit from '@loksly/lcd-canvas-kit';
import { createBaseContext, DEFAULT_THEME, DEFAULT_WORKDAY, validate, type WidgetDefinition } from '@kiosko/sdk';
import plugin, { attention, entities, entity, thresholdLevel } from './index.ts';
import { demoHome, type Entity, type HaData } from './ha.ts';

const NOW = Date.parse('2026-11-16T10:00:00');
const SOURCE = 'homeassistant/states';
const home = (locale = 'en') => demoHome(NOW, locale);

/** Renders a widget and returns every text it drew, in order. */
function texts(w: WidgetDefinition<any, any>, options: Record<string, unknown>, d: HaData | undefined, size = { w: 480, h: 260 }, locale = 'en'): string[] {
  const out: string[] = [];
  const spy = { ...kit, drawTracked: (...a: Parameters<typeof kit.drawTracked>) => (out.push(a[1]), kit.drawTracked(...a)) };
  const canvas = createCanvas(size.w, size.h);
  const theme = DEFAULT_THEME;
  w.render(canvas.getContext('2d'), {
    ...createBaseContext({ now: NOW, locale, timeFormat: '24h' }), options: validate(w.options!, options).value, data: undefined, sources: { [SOURCE]: d }, working: true,
    box: { x: 0, y: 0, w: size.w, h: size.h }, theme, fonts: theme.fonts, kit: spy, canvas: { createCanvas, loadImage: (() => {}) as never }, preview: false,
  } as never);
  return out;
}

const state = (w: WidgetDefinition<any, any>, fn: 'urgent' | 'idle' | 'empty', options: Record<string, unknown>, d: HaData | undefined) =>
  w[fn]!({ options: validate(w.options!, options).value, data: undefined, sources: { [SOURCE]: d }, now: NOW, working: true, workday: DEFAULT_WORKDAY } as never);

test('the plugin: one source, three widgets, all with demos', () => {
  assert.equal(plugin.id, 'homeassistant');
  assert.deepEqual(plugin.widgets!.map((w) => w.id), ['entity', 'entities', 'attention']);
  assert.deepEqual(plugin.sources!.map((s) => s.id), ['states']);
  for (const w of plugin.widgets!) assert.ok(w.demo, w.id);
});

test('every widget paints every connection state at every size without throwing', () => {
  const datas: (HaData | undefined)[] = [
    undefined,
    { state: 'unconfigured', entities: {} },
    { state: 'connecting', entities: {} },
    { state: 'error', error: 'token refused: Invalid access token or password', entities: {} },
    { ...home(), state: 'offline', since: NOW - 120_000 },
    home(),
    home('es'),
  ];
  for (const w of [entity, entities, attention]) {
    for (const d of datas) {
      for (const size of [w.size!.min!, w.size!.preferred!, { w: 800, h: 120 }, { w: 200, h: 400 }]) {
        assert.doesNotThrow(() => texts(w, { entity: 'sensor.living_room_temperature' }, d, size), `${w.id} ${d?.state} ${size.w}x${size.h}`);
      }
    }
  }
});

test('connection states say what is going on', () => {
  assert.deepEqual(texts(entities, {}, { state: 'unconfigured', entities: {} }), ['Home Assistant not set up', 'Set its address and a token in Settings → Data sources']);
  assert.deepEqual(texts(entities, {}, { state: 'connecting', entities: {} }, undefined, 'es'), ['Conectando con Home Assistant…']);
  assert.deepEqual(texts(attention, {}, { state: 'error', error: 'getaddrinfo ENOTFOUND ha.local', entities: {} }), ['Home Assistant unreachable', 'getaddrinfo ENOTFOUND ha.local']);
  assert.ok(texts(entities, {}, { ...home(), state: 'offline', since: NOW - 120_000 }).includes('offline since 09:58'));
});

test('entity: value and unit, min and max of the history, hints when misconfigured', () => {
  const d = home();
  const temp = d.entities['sensor.living_room_temperature']!;
  const out = texts(entity, { entity: temp.id }, d, { w: 320, h: 200 });
  assert.equal(out[0], 'Living room temperature');
  assert.equal(out[1], temp.state);
  assert.equal(out[2], '°C');
  assert.match(out[3]!, /^min \d+(\.\d+)? · max \d+(\.\d+)?$/);
  assert.deepEqual(texts(entity, { entity: temp.id, name: 'Salón', showName: true, showHistory: false }, d, { w: 320, h: 200 }).slice(0, 1), ['Salón']);
  assert.deepEqual(texts(entity, { entity: '' }, d)[0], 'Choose an entity');
  assert.deepEqual(texts(entity, { entity: 'sensor.nope' }, d), ['Entity not found', 'sensor.nope']);
  // A door: its word, and how long it has been so.
  assert.deepEqual(texts(entity, { entity: 'binary_sensor.balcony_door', showName: false }, d, { w: 320, h: 200 }), ['Open', '42 min ago']);
  // The thermostat: room temperature, then target and action.
  assert.deepEqual(texts(entity, { entity: 'climate.living_room', showName: false }, d, { w: 320, h: 200 }), ['21.4', '°C', '→ 22 °C · heating']);
});

test('entity thresholds colour, and only red takes the tile', () => {
  const e = (state: string): Entity => ({ id: 'sensor.co2', domain: 'sensor', name: 'CO2', state, unit: 'ppm', changedAt: NOW });
  const above = { thresholds: 'above' as const, warn: 1000, alert: 1500 };
  assert.equal(thresholdLevel(e('800'), above), 'off');
  assert.equal(thresholdLevel(e('1200'), above), 'warn');
  assert.equal(thresholdLevel(e('1600'), above), 'alert');
  assert.equal(thresholdLevel(e('16'), { thresholds: 'below', warn: 18, alert: 15 }), 'warn');
  assert.equal(thresholdLevel(e('1600'), { ...above, thresholds: 'off' }), 'off');
  const d: HaData = { state: 'ok', entities: { 'sensor.co2': e('1600') } };
  assert.equal(state(entity, 'urgent', { entity: 'sensor.co2', ...above }, d), true);
  assert.equal(state(entity, 'urgent', { entity: 'sensor.co2', ...above, alert: 2000 }, d), false);
  // Not while offline: the value may be stale.
  assert.equal(state(entity, 'urgent', { entity: 'sensor.co2', ...above }, { ...d, state: 'offline' }), false);
});

test('entities: in the order of the patterns, states in words, hideOff', () => {
  const d = home();
  const out = texts(entities, { entities: ['binary_sensor.*door*', 'light.*'], layout: 'one-line' }, d);
  assert.deepEqual(out, ['Open', 'Balcony door', 'Closed', 'Front door', 'Off', 'Kitchen lights', 'On', 'Living room lights']);
  const on = texts(entities, { entities: ['binary_sensor.*door*', 'light.*', 'sensor.outdoor_temperature'], layout: 'one-line', hideOff: true }, d);
  assert.deepEqual(on.filter((_, i) => i % 2 === 1), ['Balcony door', 'Living room lights', 'Outdoor temperature']);
  assert.deepEqual(texts(entities, { entities: ['nothing.*'] }, d), ['No entities match']);
  assert.equal(state(entities, 'empty', { entities: ['nothing.*'] }, d), true);
  assert.equal(state(entities, 'empty', { entities: ['nothing.*'] }, { state: 'connecting', entities: {} }), false);
  assert.equal(state(entities, 'empty', { entities: ['sensor.garage_temperature'], hideUnavailable: true }, d), true);
  // Spanish.
  assert.deepEqual(texts(entities, { entities: ['binary_sensor.balcony_door'], layout: 'one-line' }, home('es'), undefined, 'es'), ['Abierta', 'Puerta del balcón']);
});

test('attention: what needs you, red takes the tile, idle and empty when all is well', () => {
  const d = home();
  const out = texts(attention, { layout: 'one-line' }, d);
  assert.deepEqual(out, ['Battery 8 %', 'Hallway sensor battery', 'Open', 'Balcony door']);
  assert.equal(state(attention, 'urgent', {}, d), false); // a battery doesn't take the tile
  const leak = structuredClone({ ...d, history: undefined });
  leak.entities['binary_sensor.washing_machine_leak']!.state = 'on';
  assert.equal(state(attention, 'urgent', {}, leak), true);
  assert.equal(texts(attention, { layout: 'one-line' }, leak)[1], 'Washing machine leak');
  const calm = { ...d, entities: Object.fromEntries(Object.entries(d.entities).filter(([id]) => !['binary_sensor.balcony_door', 'sensor.hallway_motion_battery'].includes(id))) };
  assert.equal(state(attention, 'empty', {}, calm), true);
  assert.equal(state(attention, 'idle', {}, calm), true);
  assert.equal(state(attention, 'idle', {}, d), false);
  assert.deepEqual(texts(attention, {}, calm, undefined, 'es'), ['Todo en orden en casa']);
  assert.ok(texts(attention, { includeUnavailable: true, includeUpdates: true, layout: 'one-line' }, d).includes('Update available'));
});
