// The source's data crosses to each screen's thread by structured clone: it
// has to be plain (no class instances, no functions), and the widgets have to
// paint the same from the copy as from the original.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWidget } from '@kiosko/sdk/testing';
import plugin from './index.ts';
import { demoHome, History, historyHas, historyValues } from './ha.ts';

const NOW = Date.parse('2026-11-16T10:00:00');
const SOURCE = 'homeassistant/states';

/** Where `v` holds something that isn't plain data (`.history`), or undefined. */
function notPlain(v: unknown, path = ''): string | undefined {
  if (typeof v === 'function') return `${path || '.'}: a function`;
  if (!v || typeof v !== 'object') return undefined;
  const proto = Object.getPrototypeOf(v);
  if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return `${path || '.'}: a ${proto?.constructor?.name ?? 'class instance'}`;
  for (const [k, x] of Object.entries(v)) {
    const bad = notPlain(x, `${path}.${k}`);
    if (bad) return bad;
  }
  return undefined;
}

test("the demo home is plain data and survives structuredClone", () => {
  for (const locale of ['en', 'es', 'de', 'zh-Hans']) {
    const d = demoHome(NOW, locale);
    assert.equal(notPlain(d), undefined);
    assert.ok(Object.keys(d.history!.series).length > 0);
    assert.deepEqual(structuredClone(d), d);
  }
});

test('every widget paints the same from a structured clone of the data', () => {
  for (const w of plugin.widgets!) {
    for (const size of [w.size?.min, w.size?.preferred, { w: 800, h: 200 }].filter((s) => !!s)) {
      for (const locale of ['en', 'zh-Hans']) {
        const original = demoHome(NOW, locale);
        const clone = structuredClone(original);
        const a = renderWidget(w, { size, locale, now: NOW, sources: { [SOURCE]: original } });
        const b = renderWidget(w, { size, locale, now: NOW, sources: { [SOURCE]: clone } });
        const at = `${w.id} ${size.w}x${size.h} ${locale}`;
        assert.equal(a.error, undefined, at);
        assert.deepEqual(b.texts, a.texts, at);
        assert.ok(b.png().equals(a.png()), at);
      }
    }
  }
  // The entity tile with its curve and trend, over every span it offers.
  const entity = plugin.widgets!.find((w) => w.id === 'entity')!;
  const original = demoHome(NOW, 'en');
  const clone = structuredClone(original);
  for (const id of ['sensor.living_room_temperature', 'sensor.house_power', 'sensor.solar_power']) {
    for (const historyMs of [3_600_000, 6 * 3_600_000, 24 * 3_600_000]) {
      const a = renderWidget(entity, { size: { w: 480, h: 260 }, now: NOW, options: { entity: id, historyMs }, sources: { [SOURCE]: original } });
      const b = renderWidget(entity, { size: { w: 480, h: 260 }, now: NOW, options: { entity: id, historyMs }, sources: { [SOURCE]: clone } });
      assert.ok(a.texts.length >= 4, `${id}: the curve's highest and lowest are drawn`);
      assert.deepEqual(b.texts, a.texts);
      assert.ok(b.png().equals(a.png()), `${id} ${historyMs}`);
    }
  }
});

test("History emits plain data: a copy, reused while nothing changes", () => {
  const h = new History(3_600_000, 300_000);
  const t0 = Date.parse('2026-11-16T09:00:00Z');
  h.track('sensor.a');
  h.track('sensor.b');
  h.add('sensor.a', t0, 10, t0);
  h.add('sensor.b', t0, 1, t0);
  const first = h.data();
  assert.equal(notPlain(first), undefined);
  assert.equal(h.data(), first, 'the same object while nothing changed');
  assert.ok(historyHas(first, 'sensor.a'));
  assert.ok(!historyHas(first, 'sensor.c'));
  assert.ok(!historyHas(undefined, 'sensor.a'));
  h.add('sensor.a', t0 + 600_000, 20, t0 + 600_000);
  const second = h.data();
  assert.notEqual(second, first);
  // What was emitted doesn't change afterwards (Kiosko compares the new data with it).
  assert.deepEqual(first.series['sensor.a'], [[Math.floor(t0 / 300_000), 10, 1, 10]]);
  assert.equal(second.series['sensor.b'], first.series['sensor.b'], 'an unchanged series is the same array');
  assert.deepEqual(historyValues(second, 'sensor.a', t0 + 900_000, 3_600_000, 12).slice(-3), [10, 20, 20]);
  assert.deepEqual(h.values('sensor.a', t0 + 900_000, 3_600_000, 12), historyValues(structuredClone(second), 'sensor.a', t0 + 900_000, 3_600_000, 12));
  h.forget('sensor.b');
  assert.ok(!historyHas(h.data(), 'sensor.b'));
  assert.ok(historyHas(second, 'sensor.b'));
});
