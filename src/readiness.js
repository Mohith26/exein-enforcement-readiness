// Enforcement readiness for learned runtime allowlists.
// When is a profile learned in monitor mode complete enough to block everything else?
// Pure functions, no dependencies; runs in the browser and in Node.

export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Regularized lower incomplete gamma P(a, x) (series / continued fraction, Numerical Recipes style).
function gammaln(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
export function gammaP(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 500; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break; }
    return sum * Math.exp(-x + a * Math.log(x) - gammaln(a));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-14) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gammaln(a)) * h;
}
// P(Poisson(mu) <= k) = 1 - P(k+1, mu)
export function poissonCdf(k, mu) { return k < 0 ? 0 : 1 - gammaP(k + 1, mu); }
// Exact one-sided upper confidence bound for a Poisson mean given k observed: smallest mu with P(X<=k; mu) <= alpha.
export function poissonUCB(k, conf = 0.95) {
  const alpha = 1 - conf;
  let lo = 0, hi = Math.max(10, 3 * k + 20);
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (poissonCdf(k, mid) > alpha) lo = mid; else hi = mid;
  }
  return hi;
}

// Coverage statistics for one process profile after observing days [0, k).
// behaviors: [{ id, daily: [incidences per calendar day] }]; devicesPerDay: number of device-days per calendar day.
// Device-level: units are device-days (T). Q1 = behaviors seen in exactly one device-day.
// Leave-one-out identity: averaged over held-out units, the number of behaviors a held-out unit shows
// that the other T-1 never showed is exactly Q1/T. So Q1/T estimates the expected number of
// not-yet-allowed behaviors per new device-day, which upper-bounds the false-block probability (union bound).
// Calendar-level: units are calendar days (D). Fleet-synchronized behaviors (monthly jobs, rollouts) show up
// on many devices but few days; Q1day/D catches them where device-level coverage cannot.
export function coverage(behaviors, k, devicesPerDay, conf = 0.95) {
  let T = 0;
  for (let d = 0; d < k; d++) T += devicesPerDay[d];
  let q1 = 0, q2 = 0, q1day = 0, seen = 0, incid = 0;
  const singles = [], dayOnce = [];
  for (const b of behaviors) {
    let n = 0, days = 0;
    for (let d = 0; d < k; d++) { const c = b.daily[d]; if (c > 0) { n += c; days++; } }
    if (n > 0) seen++;
    incid += n;
    if (n === 1) { q1++; singles.push(b.id); }
    if (n === 2) q2++;
    if (days === 1) { q1day++; dayOnce.push(b.id); }
  }
  const devRisk = T ? q1 / T : 1;
  const devUCB = T ? poissonUCB(q1, conf) / T : 1;
  const dayRisk = k ? q1day / k : 1;
  const dayUCB = k ? Math.min(1, poissonUCB(q1day, conf) / k) : 1;
  // Chao (2010) incidence sample coverage, for display
  const Chat = T > 1 && (q1 + q2) > 0 ? 1 - (q1 / T) * (((T - 1) * q1) / ((T - 1) * q1 + 2 * q2 || 1)) : 1;
  return { T, D: k, seen, incid, q1, q2, q1day, devRisk, devUCB, dayRisk, dayUCB, coverage: Chat, singles, dayOnce };
}

// Decision: READY if the device-level UCB is below the per-device-day risk budget AND the calendar UCB
// (probability a new calendar day brings a never-seen fleet-wide behavior) is below the per-day budget.
// `pending` = scheduled jobs declared in the firmware image (crontab) for this process that have not
// run since monitoring began: their behavior cannot be in the allowlist yet, whatever the statistics say.
export function decide(cov, budget, pending = []) {
  if (cov.seen === 0) return 'unobserved';
  if (pending.length) return 'calendar';
  if (cov.D < budget.minDays) return 'learning';
  if (cov.devUCB > budget.perDeviceDay) return 'learning';
  return 'ready';
}

// Scheduled jobs (from the firmware crontab) whose behavior has not been observed in [0, k).
export function pendingJobs(scheduled, proc, behaviors, k) {
  const byId = Object.fromEntries(behaviors.map((b) => [b.id, b]));
  return scheduled.filter((j) => j.proc === proc).filter((j) => {
    const b = byId[j.behavior];
    if (!b) return true;
    for (let d = 0; d < k; d++) if (b.daily[d] > 0) return false;
    return true;
  });
}

// Projected day when the device-level UCB crosses the budget: fit log(q1/T) = a + b log(T) on the
// discovery curve (Good-Turing rate decays roughly as a power of sample size) and solve.
export function etaDays(behaviors, k, devicesPerDay, budget, conf = 0.95) {
  const xs = [], ys = [];
  for (let d = Math.max(2, Math.floor(k / 3)); d <= k; d++) {
    const c = coverage(behaviors, d, devicesPerDay, conf);
    if (c.q1 > 0) { xs.push(Math.log(c.T)); ys.push(Math.log(c.devUCB)); }
  }
  if (xs.length < 3) return null;
  const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxy / sxx, a = my - b * mx;
  if (!(b < 0)) return null;
  const Tneed = Math.exp((Math.log(budget.perDeviceDay) - a) / b);
  const perDay = devicesPerDay[Math.max(0, k - 1)] || 1;
  let T = 0; for (let d = 0; d < k; d++) T += devicesPerDay[d];
  return Math.max(0, Math.ceil((Tneed - T) / perDay));
}

// The learned allowlist: every behavior observed at least `minCount` times in [0, k).
export function allowlist(behaviors, k, minCount = 1) {
  const s = new Set();
  for (const b of behaviors) { let n = 0; for (let d = 0; d < k; d++) n += b.daily[d]; if (n >= minCount) s.add(b.id); }
  return s;
}

// Ground truth (simulation only): probability that a device-day on calendar day d triggers at least
// one behavior outside the allowlist. pi = per-device-day probability; scheduled behaviors fire on
// listed days with probability `onDayP`.
export function trueBlockProb(behaviors, allow, d) {
  let pNone = 1;
  for (const b of behaviors) {
    if (allow.has(b.id)) continue;
    const p = b.schedule ? (b.schedule.includes(d) ? b.onDayP : 0) : b.pi;
    pNone *= 1 - p;
  }
  return 1 - pNone;
}

export function fmtPct(x, d = 2) { return (100 * x).toFixed(d) + '%'; }

// Pulsar rules-engine style export (illustrative): allow known behaviors, deny the rest for this image.
export function policyToml(proc, allow, behaviorsById) {
  const lines = [`# Learned allowlist for ${proc.image} (${allow.size} behaviors)`, `# default action for anything else: deny`, ''];
  for (const id of [...allow].sort()) {
    const b = behaviorsById[id];
    lines.push('[[rules]]', `name = "allow-${proc.name}-${b.slug}"`, `type = "${b.type}"`, `condition = 'header.image == "${proc.image}" AND ${b.cond}'`, 'action = "allow"', '');
  }
  return lines.join('\n');
}
