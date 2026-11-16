/**
 * The live connection to Home Assistant, over its WebSocket API:
 *
 *   auth → get_states (everything, once) → subscribe_events state_changed
 *        → history/history_during_period (the last day of the numeric sensors)
 *
 * After that every change arrives as it happens (a door opening shows at
 * once, with no polling), and a ping every 30 s notices a dead connection.
 * When it drops, the last states stay on the panel, marked offline, and it
 * reconnects with a growing pause (2 s … 1 min). A refused token waits
 * 5 min before trying again, so a wrong token doesn't flood Home
 * Assistant's log with failed logins (and trip its IP ban).
 */
import { compact, History, parseHistory, wantsHistory, websocketUrl, type Entity, type HaData, type RawState } from './ha.ts';
import { matchFilter, type Filter } from '@kiosko/sdk';

/** What the connection needs of a WebSocket: the browser API, which Node ≥ 22 has built in. */
export interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error', fn: () => void): void;
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
}

export type WsFactory = (url: string) => WsLike;

export interface ConnectionOptions {
  url: string;
  token: string;
  /** Entities kept at all (empty = every one). */
  entities: Filter;
  /** Numeric entities whose last day is kept, among those kept. */
  history: Filter;
  /** Most entities with a history. */
  maxHistory: number;
}

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  now: () => number;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

const defaultWs: WsFactory = (url) => {
  const W = (globalThis as { WebSocket?: new (url: string) => WsLike }).WebSocket;
  if (!W) throw new Error('this Node has no WebSocket (Node 22 or newer is needed)');
  return new W(url);
};

export const PING_MS = 30_000;
/** Changes are gathered and handed on at most this often. */
export const FLUSH_MS = 1_000;
export const RETRY_MS = [2_000, 5_000, 10_000, 30_000, 60_000];
export const AUTH_RETRY_MS = 5 * 60_000;

/**
 * Connects and keeps connected until `signal` aborts (or the returned
 * function is called), calling `emit` with a fresh snapshot after every
 * batch of changes.
 */
export function connect(o: ConnectionOptions, emit: (d: HaData) => void, deps: { ws?: WsFactory; timers?: Timers; signal?: AbortSignal; log?: (m: string) => void } = {}): () => void {
  const timers = deps.timers ?? realTimers;
  const log = deps.log ?? (() => {});
  const history = new History();
  const entities = new Map<string, Entity>();
  let status: HaData['state'] = 'connecting';
  let error: string | undefined;
  let since: number | undefined;
  let version: string | undefined;

  if (!o.url.trim() || !o.token.trim()) {
    emit({ state: 'unconfigured', entities: {} });
    return () => {};
  }

  let stopped = false;
  let ws: WsLike | null = null;
  let attempt = 0;
  let nextId = 1;
  let ids = { states: 0, subscribe: 0, history: 0, ping: 0 };
  let awaitingPong = false;
  let retryTimer: unknown = null;
  let pingTimer: unknown = null;
  let flushTimer: unknown = null;

  const snapshot = (): HaData => ({
    state: status,
    ...(error ? { error } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(version ? { version } : {}),
    entities: Object.fromEntries(entities),
    history,
  });
  const flush = () => {
    flushTimer = null;
    if (!stopped) emit(snapshot());
  };
  /** Emits now (state changes) or within FLUSH_MS (entity changes, which come in bursts). */
  const changed = (now = false) => {
    if (stopped) return;
    if (now) {
      if (flushTimer) timers.clearTimeout(flushTimer);
      flush();
    } else if (!flushTimer) flushTimer = timers.setTimeout(flush, FLUSH_MS);
  };

  const send = (msg: Record<string, unknown>) => {
    try {
      ws?.send(JSON.stringify(msg));
    } catch (err) {
      log(`send failed: ${(err as Error).message}`);
    }
  };
  /** Sends a command; its id is recorded under `key` before sending, so an answer can never beat it. */
  const request = (msg: Record<string, unknown>, key?: keyof typeof ids) => {
    const id = nextId++;
    if (key) ids[key] = id;
    send({ id, ...msg });
  };

  const ping = () => {
    pingTimer = null;
    if (stopped || !ws) return;
    if (awaitingPong) {
      log('no answer to ping, reconnecting');
      drop('no answer from Home Assistant');
      return;
    }
    awaitingPong = true;
    request({ type: 'ping' }, 'ping');
    pingTimer = timers.setTimeout(ping, PING_MS);
  };

  const keep = (e: Entity) => matchFilter([e.id, e.name], o.entities);

  const put = (e: Entity) => {
    entities.set(e.id, e);
    if (!history.has(e.id) && history.size < o.maxHistory && wantsHistory(e) && matchFilter([e.id, e.name], o.history)) history.track(e.id);
  };

  const onStates = (rows: RawState[]) => {
    entities.clear();
    for (const r of rows) {
      const e = compact(r);
      if (keep(e)) put(e);
    }
    for (const e of entities.values()) {
      if (!history.has(e.id)) continue;
      const n = Number(e.state);
      if (Number.isFinite(n)) history.add(e.id, e.changedAt, n, timers.now());
    }
    const tracked = [...entities.keys()].filter((id) => history.has(id));
    if (tracked.length) {
      request({
        type: 'history/history_during_period',
        start_time: new Date(timers.now() - history.spanMs).toISOString(),
        entity_ids: tracked,
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      }, 'history');
    }
  };

  const onHistory = (result: Record<string, unknown>) => {
    const now = timers.now();
    for (const [id, rows] of Object.entries(result ?? {})) {
      if (!history.has(id)) continue;
      const samples = parseHistory(rows);
      // The live value may be newer than what the history API had.
      const e = entities.get(id);
      const n = e ? Number(e.state) : Number.NaN;
      if (e && Number.isFinite(n) && !samples.some((s) => s.at >= e.changedAt)) samples.push({ at: e.changedAt, value: n });
      history.fill(id, samples, now);
    }
  };

  const onEvent = (data: { entity_id?: string; new_state?: RawState | null }) => {
    const id = data?.entity_id;
    if (!id) return;
    if (!data.new_state) {
      entities.delete(id);
      history.forget(id);
      return;
    }
    const e = compact(data.new_state);
    if (!keep(e)) return;
    const prev = entities.get(id);
    put(e);
    if (history.has(id)) {
      const n = Number(e.state);
      if (Number.isFinite(n) && e.state.trim() !== '') history.add(id, Date.parse(data.new_state.last_updated ?? '') || timers.now(), n, timers.now());
    }
    // Attribute-only changes the widgets don't paint aren't worth a frame.
    if (prev && prev.state === e.state && prev.name === e.name && prev.current === e.current && prev.target === e.target && prev.action === e.action && prev.battery === e.battery) return;
    changed();
  };

  const onMessage = (raw: unknown) => {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    const batch = Array.isArray(msg) ? msg : [msg];
    for (const m of batch) handle(m);
  };

  const handle = (m: Record<string, any>) => {
    switch (m.type) {
      case 'auth_required':
        version = typeof m.ha_version === 'string' ? m.ha_version : version;
        send({ type: 'auth', access_token: o.token });
        return;
      case 'auth_ok':
        version = typeof m.ha_version === 'string' ? m.ha_version : version;
        attempt = 0;
        // Several messages per frame: far fewer round trips on a big install.
        request({ type: 'supported_features', features: { coalesce_messages: 1 } });
        request({ type: 'get_states' }, 'states');
        request({ type: 'subscribe_events', event_type: 'state_changed' }, 'subscribe');
        pingTimer = timers.setTimeout(ping, PING_MS);
        return;
      case 'auth_invalid':
        status = 'error';
        error = `token refused${m.message ? `: ${m.message}` : ''}`;
        log(error);
        changed(true);
        close(AUTH_RETRY_MS);
        return;
      case 'pong':
        awaitingPong = false;
        return;
      case 'event':
        if (m.id === ids.subscribe) onEvent(m.event?.data);
        return;
      case 'result':
        if (m.id === ids.states) {
          if (!m.success) {
            status = 'error';
            error = m.error?.message ?? 'get_states failed';
            changed(true);
            return;
          }
          onStates(Array.isArray(m.result) ? m.result : []);
          status = 'ok';
          error = undefined;
          since = undefined;
          changed(true);
        } else if (m.id === ids.history) {
          if (m.success) {
            onHistory(m.result);
            changed();
          } else log(`no history: ${m.error?.message ?? 'refused'}`);
        } else if (m.id === ids.subscribe && !m.success) {
          log(`subscribe failed: ${m.error?.message ?? 'refused'}`);
        }
        return;
    }
  };

  const clearTimers = () => {
    if (pingTimer) timers.clearTimeout(pingTimer);
    if (retryTimer) timers.clearTimeout(retryTimer);
    pingTimer = retryTimer = null;
  };

  /** Closes the socket (if any) and tries again in `ms`. */
  const close = (ms: number) => {
    clearTimers();
    const w = ws;
    ws = null;
    try {
      w?.close();
    } catch {
      /* already closed */
    }
    if (!stopped) retryTimer = timers.setTimeout(open, ms);
  };

  /** The connection is gone: keep what we had, say since when, and try again. */
  const drop = (why: string) => {
    if (stopped) return;
    const wasUp = status === 'ok';
    if (status !== 'error') {
      status = entities.size ? 'offline' : 'error';
      error = why;
      since ??= timers.now();
    }
    if (wasUp || status === 'error') changed(true);
    const ms = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!;
    attempt++;
    close(ms);
  };

  const open = () => {
    retryTimer = null;
    if (stopped) return;
    awaitingPong = false;
    ids = { states: 0, subscribe: 0, history: 0, ping: 0 };
    nextId = 1;
    let w: WsLike;
    try {
      w = (deps.ws ?? defaultWs)(websocketUrl(o.url));
    } catch (err) {
      drop((err as Error).message);
      return;
    }
    ws = w;
    if (status === 'error' && error?.startsWith('token refused')) {
      status = entities.size ? 'offline' : 'connecting';
      error = undefined;
    }
    const mine = (fn: () => void) => () => ws === w && fn();
    w.addEventListener('message', (ev) => ws === w && onMessage(ev.data));
    w.addEventListener('error', mine(() => drop('cannot reach Home Assistant')));
    w.addEventListener('close', mine(() => drop('connection closed')));
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimers();
    if (flushTimer) timers.clearTimeout(flushTimer);
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    ws = null;
  };
  deps.signal?.addEventListener('abort', stop, { once: true });

  emit(snapshot());
  open();
  return stop;
}
