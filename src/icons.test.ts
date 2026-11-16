import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { ICON_PATHS, type IconName } from './icon-paths.ts';
import { drawBattery, drawIcon, iconFor, parsePath } from './icons.ts';
import type { Entity } from './ha.ts';

const ent = (id: string, state: string, o: Partial<Entity> = {}): Entity => ({ id, domain: id.split('.')[0]!, name: id, state, changedAt: 0, ...o });

test('parsePath: implicit linetos, relative commands, arc flags glued together or to a number', () => {
  assert.deepEqual(parsePath('M4 6H16'), [['M', 4, 6], ['H', 16]]);
  assert.deepEqual(parsePath('m12 14 4-4'), [['m', 12, 14], ['l', 4, -4]]);
  assert.deepEqual(parsePath('M10 3H7a2 2 0 00-2 2v16'), [['M', 10, 3], ['H', 7], ['a', 2, 2, 0, 0, 0, -2, 2], ['v', 16]]);
  assert.deepEqual(parsePath('a4 4 0 1 1-4 0Z'), [['a', 4, 4, 0, 1, 1, -4, 0], ['Z']]);
  assert.deepEqual(parsePath('a2 2 0 011.5 1'), [['a', 2, 2, 0, 0, 1, 1.5, 1]]);
  assert.deepEqual(parsePath('M5.636 5.636l.707.707'), [['M', 5.636, 5.636], ['l', 0.707, 0.707]]);
});

test('every icon parses and paints inside its 24 × 24 box', () => {
  for (const name of Object.keys(ICON_PATHS) as IconName[]) {
    const ops = parsePath(ICON_PATHS[name]);
    assert.ok(ops.length > 1, name);
    // Painted at 48 px in the middle of a 96 px canvas: nothing may land outside the middle 48 (plus the stroke).
    const c = createCanvas(96, 96);
    const g = c.getContext('2d');
    drawIcon(g, name, 24, 24, 48, '#ffffff');
    const px = g.getImageData(0, 0, 96, 96).data;
    let inside = 0, outside = 0;
    for (let y = 0; y < 96; y++) {
      for (let x = 0; x < 96; x++) {
        if (px[(y * 96 + x) * 4 + 3]! < 40) continue;
        if (x >= 20 && x < 76 && y >= 20 && y < 76) inside++;
        else outside++;
      }
    }
    assert.ok(inside > 40, `${name} paints something`);
    assert.equal(outside, 0, `${name} stays in its box`);
  }
});

test('a battery fills to its level', () => {
  const fill = (pct: number) => {
    const c = createCanvas(48, 48);
    const g = c.getContext('2d');
    drawBattery(g, 0, 0, 48, '#000000', pct, '#ff0000');
    const px = g.getImageData(0, 0, 48, 48).data;
    let red = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i]! > 200 && px[i + 1]! < 50) red++;
    return red;
  };
  assert.equal(fill(0), 0);
  assert.ok(fill(50) > 0);
  assert.ok(fill(100) > fill(50) * 1.6);
});

test('iconFor: by domain, device class and state', () => {
  assert.equal(iconFor(ent('sensor.t', '21', { deviceClass: 'temperature', unit: '°C' })), 'thermometer');
  assert.equal(iconFor(ent('sensor.t', '21', { unit: '°C' })), 'thermometer');
  assert.equal(iconFor(ent('sensor.p', '500', { unit: 'W' })), 'zap');
  assert.equal(iconFor(ent('sensor.b', '50', { deviceClass: 'battery', unit: '%' })), 'battery');
  assert.equal(iconFor(ent('sensor.x', 'idle')), 'circle-dot');
  assert.equal(iconFor(ent('binary_sensor.d', 'on', { deviceClass: 'door' })), 'door-open');
  assert.equal(iconFor(ent('binary_sensor.d', 'off', { deviceClass: 'door' })), 'door-closed');
  assert.equal(iconFor(ent('binary_sensor.n', 'off', { deviceClass: 'connectivity' })), 'wifi-off');
  assert.equal(iconFor(ent('light.k', 'on')), 'lightbulb');
  assert.equal(iconFor(ent('light.k', 'off')), 'lightbulb-off');
  assert.equal(iconFor(ent('lock.f', 'unlocked')), 'lock-open');
  assert.equal(iconFor(ent('cover.g', 'open', { deviceClass: 'garage' })), 'warehouse');
  assert.equal(iconFor(ent('climate.t', 'heat', { action: 'heating' })), 'flame');
  assert.equal(iconFor(ent('climate.t', 'heat', { action: 'idle' })), 'heater');
  assert.equal(iconFor(ent('person.a', 'home')), 'house');
  assert.equal(iconFor(ent('person.a', 'not_home')), 'user');
  assert.equal(iconFor(ent('alarm_control_panel.h', 'triggered')), 'siren');
  assert.equal(iconFor(ent('something.new', 'x')), 'circle-dot');
});
