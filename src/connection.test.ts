import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_RETRY_MS, connect, ENERGY_MS, FLUSH_MS, PING_MS, RETRY_MS, type ConnectionOptions, type Timers, type WsLike } from './connection.ts';
import type { HaData, RawState } from './ha.ts';

const T0 = Date.parse('2026-11-16T10:00:00Z');

/** Timers that only move when the test says so. */
function clock(): Timers & { advance: (ms: number) => void; pending: () => number } {
  let now = T0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => void due.delete(h as number),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    pending: () => due.size,
  };
}

const STATES: RawState[] = [
  { entity_id: 'sensor.living_room_temperature', state: '21.4', attributes: { friendly_name: 'Living room', unit_of_measurement: '°C', device_class: 'temperature', state_class: 'measurement' }, last_changed: '2026-11-16T09:58:00Z' },
  { entity_id: 'binary_sensor.front_door', state: 'off', attributes: { friendly_name: 'Front door', device_class: 'door' }, last_changed: '2026-11-16T08:00:00Z' },
  { entity_id: 'sensor.zigbee_linkquality', state: '120', attributes: { unit_of_measurement: 'lqi' }, last_changed: '2026-11-16T09:59:00Z' },
];

/** A fake Home Assistant behind a fake WebSocket: answers like the real one and records what it was sent. */
function fakeHa(o: { token?: string; history?: boolean; energy?: unknown } = {}) {
  const sockets: { url: string; sent: Record<string, any>[]; open: boolean; push: (m: unknown) => void; fail: () => void }[] = [];
  const factory = (url: string): WsLike => {
    const listeners: Record<string, ((ev?: any) => void)[]> = {};
    const s = {
      url, sent: [] as Record<string, any>[], open: true,
      push: (m: unknown) => listeners.message?.forEach((fn) => fn({ data: JSON.stringify(m) })),
      fail: () => {
        s.open = false;
        listeners.close?.forEach((fn) => fn());
      },
    };
    sockets.push(s);
    const ws: WsLike = {
      send(data) {
        const m = JSON.parse(data);
        s.sent.push(m);
        if (m.type === 'auth') s.push(m.access_token === (o.token ?? 'good') ? { type: 'auth_ok', ha_version: '2026.11.1' } : { type: 'auth_invalid', message: 'Invalid access token or password' });
        else if (m.type === 'get_states') s.push({ id: m.id, type: 'result', success: true, result: STATES });
        else if (m.type === 'subscribe_events') s.push({ id: m.id, type: 'result', success: true, result: null });
        else if (m.type === 'history/history_during_period') {
          if (o.history === false) s.push({ id: m.id, type: 'result', success: false, error: { code: 'unknown_command', message: 'Unknown command.' } });
          else s.push({ id: m.id, type: 'result', success: true, result: { 'sensor.living_room_temperature': [{ s: '20.1', lu: (T0 - 6 * 3_600_000) / 1000 }, { s: '21.4', lu: (T0 - 120_000) / 1000 }] } });
        } else if (m.type === 'energy/get_prefs') {
          // Like Home Assistant without the Energy dashboard set up.
          if (o.energy === undefined) s.push({ id: m.id, type: 'result', success: false, error: { code: 'not_found', message: 'No prefs' } });
          else s.push({ id: m.id, type: 'result', success: true, result: o.energy });
        } else if (m.type === 'recorder/statistics_during_period') {
          s.push({ id: m.id, type: 'result', success: true, result: Object.fromEntries(m.statistic_ids.map((id: string) => [id, [{ start: T0, end: T0 + 86_400_000, change: id.includes('solar') ? 6.5 : id.includes('export') ? 2.25 : 4 }]])) });
        } else if (m.type === 'ping') s.push({ id: m.id, type: 'pong' });
      },
      close() {
        s.open = false;
      },
      addEventListener(type: string, fn: (ev?: any) => void) {
        (listeners[type] ??= []).push(fn);
      },
    };
    // Home Assistant speaks first.
    queueMicrotask(() => s.push({ type: 'auth_required', ha_version: '2026.11.1' }));
    return ws;
  };
  /** A state_changed event on the subscription of the newest socket. */
  const change = (st: RawState) => {
    const s = sockets.at(-1)!;
    const sub = s.sent.find((m) => m.type === 'subscribe_events')!;
    s.push({ id: sub.id, type: 'event', event: { event_type: 'state_changed', data: { entity_id: st.entity_id, new_state: st } } });
  };
  return { sockets, factory, change };
}

const opts = (o: Partial<ConnectionOptions> = {}): ConnectionOptions => ({ url: 'http://ha.local:8123', token: 'good', entities: [], history: [], maxHistory: 100, ...o });
const tick = () => new Promise((r) => setImmediate(r));

test('unconfigured without an address or a token, and nothing is opened', () => {
  const ha = fakeHa();
  const out: HaData[] = [];
  connect(opts({ token: '' }), (d) => out.push(d), { ws: ha.factory, timers: clock() });
  assert.deepEqual(out.map((d) => d.state), ['unconfigured']);
  assert.equal(ha.sockets.length, 0);
});

test('authenticates, reads every state, subscribes, fills the history', async () => {
  const ha = fakeHa();
  const c = clock();
  const out: HaData[] = [];
  const stop = connect(opts({ entities: ['!*linkquality'] }), (d) => out.push(d), { ws: ha.factory, timers: c });
  assert.equal(out[0]!.state, 'connecting');
  await tick();
  const s = ha.sockets[0]!;
  assert.equal(s.url, 'ws://ha.local:8123/api/websocket');
  assert.deepEqual(s.sent.map((m) => m.type).sort(), ['auth', 'energy/get_prefs', 'get_states', 'history/history_during_period', 'subscribe_events', 'supported_features']);
  const last = out.at(-1)!;
  assert.equal(last.state, 'ok');
  assert.equal(last.version, '2026.11.1');
  assert.deepEqual(Object.keys(last.entities).sort(), ['binary_sensor.front_door', 'sensor.living_room_temperature']);
  assert.equal(last.entities['binary_sensor.front_door']!.name, 'Front door');
  // History asked only for numeric sensors with a unit, over the last day.
  const hist = s.sent.find((m) => m.type === 'history/history_during_period')!;
  assert.deepEqual(hist.entity_ids, ['sensor.living_room_temperature']);
  assert.equal(hist.start_time, new Date(T0 - 86_400_000).toISOString());
  c.advance(FLUSH_MS);
  // One bar per five-minute bucket over 12 h.
  const v = out.at(-1)!.history!.values('sensor.living_room_temperature', T0, 12 * 3_600_000, 144);
  assert.ok(Number.isNaN(v[0]!)); // nothing known 12 h ago
  assert.equal(v[72], 20.1); // 6 h ago
  assert.equal(v.at(-1), 21.4);
  stop();
});

test('changes arrive live, gathered into one emit per second', async () => {
  const ha = fakeHa();
  const c = clock();
  const out: HaData[] = [];
  const stop = connect(opts(), (d) => out.push(d), { ws: ha.factory, timers: c });
  await tick();
  c.advance(FLUSH_MS);
  const before = out.length;
  ha.change({ entity_id: 'binary_sensor.front_door', state: 'on', attributes: { friendly_name: 'Front door', device_class: 'door' }, last_changed: '2026-11-16T10:00:00Z' });
  ha.change({ entity_id: 'sensor.living_room_temperature', state: '21.6', attributes: { friendly_name: 'Living room', unit_of_measurement: '°C' }, last_changed: '2026-11-16T10:00:00Z', last_updated: '2026-11-16T10:00:00Z' });
  assert.equal(out.length, before);
  c.advance(FLUSH_MS);
  assert.equal(out.length, before + 1);
  const d = out.at(-1)!;
  assert.equal(d.entities['binary_sensor.front_door']!.state, 'on');
  assert.equal(d.history!.values('sensor.living_room_temperature', T0, 3_600_000, 12).at(-1), 21.6);
  // An attribute the widgets don't paint changing: no emit.
  ha.change({ entity_id: 'binary_sensor.front_door', state: 'on', attributes: { friendly_name: 'Front door', device_class: 'door', linkquality: 90 }, last_changed: '2026-11-16T10:00:00Z' });
  c.advance(FLUSH_MS);
  assert.equal(out.length, before + 1);
  // A removed entity goes.
  const sub = ha.sockets[0]!.sent.find((m) => m.type === 'subscribe_events')!;
  ha.sockets[0]!.push({ id: sub.id, type: 'event', event: { data: { entity_id: 'binary_sensor.front_door', new_state: null } } });
  ha.change({ entity_id: 'sensor.living_room_temperature', state: '21.7', attributes: {}, last_changed: '2026-11-16T10:00:01Z' });
  c.advance(FLUSH_MS);
  assert.equal(out.at(-1)!.entities['binary_sensor.front_door'], undefined);
  stop();
});

test('coalesced messages (an array per frame) are handled', async () => {
  const ha = fakeHa();
  const c = clock();
  const out: HaData[] = [];
  const stop = connect(opts(), (d) => out.push(d), { ws: ha.factory, timers: c });
  await tick();
  const s = ha.sockets[0]!;
  const sub = s.sent.find((m) => m.type === 'subscribe_events')!;
  const ev = (id: string, state: string) => ({ id: sub.id, type: 'event', event: { data: { entity_id: id, new_state: { entity_id: id, state, attributes: {}, last_changed: '2026-11-16T10:00:00Z' } } } });
  s.push([ev('light.a', 'on'), ev('light.b', 'off')]);
  c.advance(FLUSH_MS);
  assert.deepEqual([out.at(-1)!.entities['light.a']?.state, out.at(-1)!.entities['light.b']?.state], ['on', 'off']);
  stop();
});

test('a wrong token says so and waits five minutes before trying again', async () => {
  const ha = fakeHa();
  const c = clock();
  const out: HaData[] = [];
  const stop = connect(opts({ token: 'bad' }), (d) => out.push(d), { ws: ha.factory, timers: c });
  await tick();
  assert.equal(out.at(-1)!.state, 'error');
  assert.match(out.at(-1)!.error!, /token refused/);
  assert.equal(ha.sockets[0]!.open, false);
  c.advance(AUTH_RETRY_MS - 1);
  assert.equal(ha.sockets.length, 1);
  c.advance(1);
  assert.equal(ha.sockets.length, 2);
  stop();
});

test('dropped: keeps the last states, offline since then, reconnects with a growing pause', async () => {
  const ha = fakeHa();
  const c = clock();
  const out: HaData[] = [];
  const stop = connect(opts(), (d) => out.push(d), { ws: ha.factory, timers: c });
  await tick();
  c.advance(10_000);
  ha.sockets[0]!.fail();
  const d = out.at(-1)!;
  assert.equal(d.state, 'offline');
  assert.equal(d.since, T0 + 10_000);
  assert.ok(d.entities['sensor.living_room_temperature']);
  c.advance(RETRY_MS[0]!);
  assert.equal(ha.sockets.length, 2);
  // The second socket fails before Home Assistant answers: the next pause is longer.
  ha.sockets[1]!.fail();
  c.advance(RETRY_MS[0]!);
  assert.equal(ha.sockets.length, 2);
  c.advance(RETRY_MS[1]! - RETRY_MS[0]!);
  assert.equal(ha.sockets.length, 3);
  await tick();
  assert.equal(out.at(-1)!.state, 'ok');
  assert.equal(out.at(-1)!.since, undefined);
  stop();
});

test('never reachable: an error, not offline, since there is nothing to show', () => {
  const c = clock();
  const out: HaData[] = [];
  const stop = connect(opts(), (d) => out.push(d), { ws: () => { throw new Error('getaddrinfo ENOTFOUND ha.local'); }, timers: c });
  assert.equal(out.at(-1)!.state, 'error');
  assert.match(out.at(-1)!.error!, /ENOTFOUND/);
  stop();
  assert.equal(c.pending(), 0);
});

test('a ping without a pong drops the connection', async () => {
  const ha = fakeHa();
  const c = clock();
  const out: HaData[] = [];
  const stop = connect(opts(), (d) => out.push(d), { ws: ha.factory, timers: c });
  await tick();
  c.advance(PING_MS);
  assert.equal(ha.sockets[0]!.sent.at(-1)!.type, 'ping');
  // Answered: still up after the next one.
  c.advance(PING_MS);
  assert.equal(ha.sockets.length, 1);
  // Home Assistant goes silent.
  ha.sockets[0]!.push = () => {};
  c.advance(PING_MS * 2);
  assert.equal(out.at(-1)!.state, 'offline');
  stop();
});

test('without the history command (older Home Assistant) it still works', async () => {
  const ha = fakeHa({ history: false });
  const c = clock();
  const out: HaData[] = [];
  const logs: string[] = [];
  const stop = connect(opts(), (d) => out.push(d), { ws: ha.factory, timers: c, log: (m) => logs.push(m) });
  await tick();
  assert.equal(out.at(-1)!.state, 'ok');
  assert.ok(logs.some((l) => l.startsWith('no history')));
  stop();
});

test('stopping (or the signal aborting) closes the socket and leaves no timer', async () => {
  const ha = fakeHa();
  const c = clock();
  const ac = new AbortController();
  connect(opts(), () => {}, { ws: ha.factory, timers: c, signal: ac.signal });
  await tick();
  ac.abort();
  assert.equal(ha.sockets[0]!.open, false);
  assert.equal(c.pending(), 0);
});

test("today's energy from the Energy dashboard, read again every 5 minutes; none when it isn't set up", async () => {
  const prefs = {
    energy_sources: [
      { type: 'grid', flow_from: [{ stat_energy_from: 'sensor.grid_import' }], flow_to: [{ stat_energy_to: 'sensor.grid_export' }], power: [{ stat_rate: 'sensor.grid_power' }] },
      { type: 'solar', stat_energy_from: 'sensor.solar_energy', stat_rate: 'sensor.solar_power' },
      { type: 'gas', stat_energy_from: 'sensor.gas' },
    ],
  };
  const ha = fakeHa({ energy: prefs });
  const c = clock();
  const out: HaData[] = [];
  connect(opts(), (d) => out.push(d), { ws: ha.factory, timers: c });
  await tick();
  c.advance(FLUSH_MS);
  const e = out.at(-1)!.energy!;
  assert.deepEqual({ gridIn: e.gridIn, gridOut: e.gridOut, solar: e.solar, batteryIn: e.batteryIn }, { gridIn: 4, gridOut: 2.25, solar: 6.5, batteryIn: undefined });
  assert.deepEqual(e.power, { grid: 'sensor.grid_power', solar: 'sensor.solar_power' });
  const asks = () => ha.sockets[0]!.sent.filter((m) => m.type === 'recorder/statistics_during_period');
  assert.equal(asks().length, 1);
  assert.deepEqual(asks()[0]!.statistic_ids, ['sensor.grid_import', 'sensor.grid_export', 'sensor.solar_energy']);
  assert.deepEqual(asks()[0]!.units, { energy: 'kWh' });
  c.advance(ENERGY_MS);
  assert.equal(asks().length, 2);
  // Without a dashboard: no energy, nothing more asked.
  const bare = fakeHa();
  const out2: HaData[] = [];
  connect(opts(), (d) => out2.push(d), { ws: bare.factory, timers: clock() });
  await tick();
  assert.equal(out2.at(-1)!.energy, undefined);
  assert.equal(bare.sockets[0]!.sent.filter((m) => m.type === 'recorder/statistics_during_period').length, 0);
});

test("a camera's new token is passed on at once: the old one stops opening its picture", async () => {
  const ha = fakeHa();
  const c = clock();
  const out: HaData[] = [];
  connect(opts(), (d) => out.push(d), { ws: ha.factory, timers: c });
  await tick();
  const cam = (token: string): RawState => ({ entity_id: 'camera.porch', state: 'idle', attributes: { friendly_name: 'Porch', entity_picture: `/api/camera_proxy/camera.porch?token=${token}` }, last_changed: '2026-11-16T08:00:00Z' });
  ha.change(cam('one'));
  c.advance(FLUSH_MS);
  assert.equal(out.at(-1)!.entities['camera.porch']!.picture, '/api/camera_proxy/camera.porch?token=one');
  const n = out.length;
  ha.change(cam('two'));
  c.advance(FLUSH_MS);
  assert.equal(out.length, n + 1, 'only the token changed, and that is worth passing on');
  assert.equal(out.at(-1)!.entities['camera.porch']!.picture, '/api/camera_proxy/camera.porch?token=two');
});
