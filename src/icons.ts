/**
 * Line icons for entities: which one an entity gets (by domain, device
 * class and state) and how it is drawn.
 *
 * The paths are Lucide's (see icon-paths.ts), drawn by a small SVG path
 * interpreter straight onto the 2D context, so the same code paints on the
 * panel (@napi-rs/canvas, which has no global Path2D) and in the browser
 * demo.
 */
import type { Graphics } from '@kiosko/sdk';
import { ICON_PATHS, type IconName } from './icon-paths.ts';
import { numericState, type Entity } from './ha.ts';

export type { IconName };

type Op = [cmd: string, ...args: number[]];

/** Splits path data into commands with their numbers. Arc flags may come glued ("a2 2 0 00-2 2"). */
export function parsePath(d: string): Op[] {
  const ops: Op[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g;
  const tokens: string[] = [];
  for (const m of d.matchAll(re)) tokens.push(m[0]);
  const arity: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  let i = 0;
  let cmd = '';
  while (i < tokens.length) {
    const tk = tokens[i]!;
    if (/[a-z]/i.test(tk)) {
      cmd = tk;
      i++;
      if (cmd === 'z' || cmd === 'Z') {
        ops.push([cmd]);
        continue;
      }
    } else if (!cmd) {
      i++;
      continue;
    }
    const n = arity[cmd.toLowerCase()]!;
    const args: number[] = [];
    while (args.length < n && i < tokens.length && !/[a-z]/i.test(tokens[i]!)) {
      const tok = tokens[i]!;
      // Arc flags are single digits that may be glued to each other or to the next number.
      if ((cmd === 'a' || cmd === 'A') && (args.length === 3 || args.length === 4) && /^[01]./.test(tok.replace('-', 'x'))) {
        args.push(Number(tok[0]));
        tokens[i] = tok.slice(1);
        continue;
      }
      args.push(Number(tok));
      i++;
    }
    if (args.length < n) break;
    ops.push([cmd, ...args]);
    // Numbers after a moveto are linetos.
    if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
  }
  return ops;
}

/** An SVG arc (endpoint form) as a canvas ellipse (centre form), after the SVG spec's appendix. */
function arcTo(g: Graphics, x1: number, y1: number, rx: number, ry: number, rot: number, large: number, sweep: number, x2: number, y2: number): void {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) {
    g.lineTo(x2, y2);
    return;
  }
  const phi = (rot * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (k * rx * yp) / ry, cyp = (-k * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = angle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dt > 0) dt -= Math.PI * 2;
  else if (sweep && dt < 0) dt += Math.PI * 2;
  g.ellipse(cx, cy, rx, ry, phi, t1, t1 + dt, !sweep);
}

/** Traces `ops` on the current path. */
export function tracePath(g: Graphics, ops: Op[]): void {
  let x = 0, y = 0, sx = 0, sy = 0;
  let cx = 0, cy = 0; // last control point, for S and T
  let prev = '';
  for (const [cmd, ...a] of ops) {
    const rel = cmd === cmd.toLowerCase() && cmd !== 'z';
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M':
        x = ox + a[0]!; y = oy + a[1]!; sx = x; sy = y;
        g.moveTo(x, y);
        break;
      case 'L':
        x = ox + a[0]!; y = oy + a[1]!;
        g.lineTo(x, y);
        break;
      case 'H':
        x = ox + a[0]!;
        g.lineTo(x, y);
        break;
      case 'V':
        y = oy + a[0]!;
        g.lineTo(x, y);
        break;
      case 'C': {
        const [x1, y1, x2, y2, ex, ey] = [ox + a[0]!, oy + a[1]!, ox + a[2]!, oy + a[3]!, ox + a[4]!, oy + a[5]!];
        g.bezierCurveTo(x1, y1, x2, y2, ex, ey);
        cx = x2; cy = y2; x = ex; y = ey;
        break;
      }
      case 'S': {
        const [x1, y1] = 'CS'.includes(prev.toUpperCase()) ? [2 * x - cx, 2 * y - cy] : [x, y];
        const [x2, y2, ex, ey] = [ox + a[0]!, oy + a[1]!, ox + a[2]!, oy + a[3]!];
        g.bezierCurveTo(x1, y1, x2, y2, ex, ey);
        cx = x2; cy = y2; x = ex; y = ey;
        break;
      }
      case 'Q': {
        const [x1, y1, ex, ey] = [ox + a[0]!, oy + a[1]!, ox + a[2]!, oy + a[3]!];
        g.quadraticCurveTo(x1, y1, ex, ey);
        cx = x1; cy = y1; x = ex; y = ey;
        break;
      }
      case 'T': {
        const [x1, y1] = 'QT'.includes(prev.toUpperCase()) ? [2 * x - cx, 2 * y - cy] : [x, y];
        const [ex, ey] = [ox + a[0]!, oy + a[1]!];
        g.quadraticCurveTo(x1, y1, ex, ey);
        cx = x1; cy = y1; x = ex; y = ey;
        break;
      }
      case 'A': {
        const ex = ox + a[5]!, ey = oy + a[6]!;
        arcTo(g, x, y, a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, ex, ey);
        x = ex; y = ey;
        break;
      }
      case 'Z':
        g.closePath();
        x = sx; y = sy;
        break;
    }
    prev = cmd;
  }
}

const parsed = new Map<IconName, Op[]>();
const opsOf = (name: IconName) => {
  let ops = parsed.get(name);
  if (!ops) parsed.set(name, (ops = parsePath(ICON_PATHS[name])));
  return ops;
};

/**
 * Draws icon `name` in a `size` × `size` square at (x, y), stroked in
 * `color`. The stroke stays near Lucide's 2/24 of the size but never under
 * 1.25 px, so small icons don't fade on the panel.
 */
export function drawIcon(g: Graphics, name: IconName, x: number, y: number, size: number, color: string, o: { stroke?: number } = {}): void {
  const s = size / 24;
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.beginPath();
  tracePath(g, opsOf(name));
  g.lineWidth = Math.max(1.25 / s, o.stroke ?? 2);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = color;
  g.stroke();
  g.restore();
}

/** A battery whose inside fills to `pct` (0–100), in `fill`. */
export function drawBattery(g: Graphics, x: number, y: number, size: number, color: string, pct: number, fill = color): void {
  drawIcon(g, 'battery', x, y, size, color);
  const s = size / 24;
  const w = Math.max(0, Math.min(1, pct / 100)) * 12;
  if (w <= 0) return;
  g.fillStyle = fill;
  g.beginPath();
  g.roundRect(x + 4 * s, y + 8 * s, Math.max(1.2, w) * s, 8 * s, 1 * s);
  g.fill();
}

const SENSOR: Record<string, IconName> = {
  temperature: 'thermometer', humidity: 'droplets', moisture: 'droplets', power: 'zap', energy: 'zap', current: 'zap', voltage: 'zap', apparent_power: 'zap', reactive_power: 'zap', power_factor: 'zap',
  illuminance: 'sun-medium', irradiance: 'sun-medium', pressure: 'gauge', atmospheric_pressure: 'gauge', carbon_dioxide: 'wind', carbon_monoxide: 'cloud-fog', pm25: 'wind', pm10: 'wind', pm1: 'wind', aqi: 'wind',
  volatile_organic_compounds: 'wind', volatile_organic_compounds_parts: 'wind', nitrogen_dioxide: 'wind', ozone: 'wind', wind_speed: 'wind', speed: 'wind', precipitation: 'droplet', precipitation_intensity: 'droplet',
  water: 'droplet', gas: 'flame', timestamp: 'clock', duration: 'clock', signal_strength: 'activity', data_rate: 'activity', frequency: 'activity', sound_pressure: 'speaker', monetary: 'leaf',
};

const BINARY: Record<string, [on: IconName, off: IconName]> = {
  door: ['door-open', 'door-closed'], opening: ['door-open', 'door-closed'], garage_door: ['warehouse', 'warehouse'], window: ['app-window', 'app-window'],
  motion: ['footprints', 'footprints'], occupancy: ['user', 'user'], presence: ['user', 'user'], moisture: ['droplet', 'droplet'],
  smoke: ['flame', 'flame'], gas: ['cloud-fog', 'cloud-fog'], carbon_monoxide: ['cloud-fog', 'cloud-fog'], heat: ['thermometer-sun', 'thermometer'], cold: ['thermometer-snowflake', 'thermometer'],
  connectivity: ['activity', 'wifi-off'], problem: ['triangle-exclamation-point', 'circle-check'], safety: ['shield-exclamation-point', 'shield-check'], tamper: ['shield-exclamation-point', 'shield-check'],
  plug: ['plug-zap', 'plug'], power: ['plug-zap', 'plug'], lock: ['lock-open', 'lock'], light: ['sun-medium', 'sun-medium'], sound: ['speaker', 'speaker'], running: ['power', 'power'],
  update: ['circle-arrow-up', 'circle-check'], battery_charging: ['battery-charging', 'battery'], vibration: ['activity', 'activity'], moving: ['activity', 'activity'],
};

/** The icon of an entity. `battery` means: draw it with `drawBattery`. */
export function iconFor(e: Entity): IconName {
  const dc = e.deviceClass ?? '';
  const on = e.state === 'on';
  switch (e.domain) {
    case 'sensor':
    case 'number':
    case 'input_number':
      if (dc === 'battery') return 'battery';
      return SENSOR[dc] ?? (/°[CF]$/.test(e.unit ?? '') ? 'thermometer' : e.unit === '%' ? 'gauge' : /W$|Wh$|^A$|^V$/.test(e.unit ?? '') ? 'zap' : numericState(e) !== undefined ? 'gauge' : 'circle-dot');
    case 'binary_sensor': {
      if (dc === 'battery') return 'battery';
      const pair = BINARY[dc];
      return pair ? pair[on ? 0 : 1] : 'circle-dot';
    }
    case 'light':
      return on ? 'lightbulb' : 'lightbulb-off';
    case 'switch':
    case 'input_boolean':
      return on ? 'toggle-right' : 'toggle-left';
    case 'fan':
      return 'fan';
    case 'lock':
      return e.state === 'locked' || e.state === 'locking' ? 'lock' : 'lock-open';
    case 'cover':
      return dc === 'garage' ? 'warehouse' : dc === 'door' || dc === 'gate' ? (e.state === 'closed' ? 'door-closed' : 'door-open') : dc === 'window' ? 'app-window' : 'blinds';
    case 'climate':
    case 'water_heater':
      return e.action === 'heating' ? 'flame' : 'heater';
    case 'alarm_control_panel':
      return e.state === 'triggered' ? 'siren' : e.state === 'disarmed' ? 'shield' : 'shield-check';
    case 'siren':
      return 'siren';
    case 'person':
    case 'device_tracker':
      return e.state === 'home' ? 'house' : 'user';
    case 'media_player':
      return e.deviceClass === 'speaker' ? 'speaker' : 'tv';
    case 'vacuum':
      return 'bot';
    case 'update':
      return on ? 'circle-arrow-up' : 'circle-check';
    case 'sun':
      return 'sun';
    case 'weather':
      return 'cloud-sun';
    case 'automation':
    case 'script':
      return 'activity';
    case 'calendar':
      return 'calendar-clock';
    default:
      return 'circle-dot';
  }
}

/** The battery level an entity shows, if it is a battery (0–100), for `drawBattery`. */
export function batteryLevel(e: Entity): number | undefined {
  if (e.domain === 'binary_sensor' && e.deviceClass === 'battery') return e.state === 'on' ? 10 : 80;
  if (e.deviceClass !== 'battery') return undefined;
  return numericState(e);
}

/** Draws the icon of `e` (a battery filled to its level, or its line icon). */
export function drawEntityIcon(g: Graphics, e: Entity, x: number, y: number, size: number, color: string): void {
  const icon = iconFor(e);
  if (icon === 'battery') drawBattery(g, x, y, size, color, batteryLevel(e) ?? 0);
  else drawIcon(g, icon, x, y, size, color);
}
