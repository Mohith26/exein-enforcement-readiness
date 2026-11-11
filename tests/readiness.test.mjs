import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rng, poissonUCB, poissonCdf, coverage, decide, pendingJobs, allowlist, trueBlockProb, etaDays, policyToml } from '../src/readiness.js';
import { simulate, computeResults, realized, decisions, BUDGET } from '../scripts/generate.mjs';

const fleet = simulate();

test('Poisson upper bound matches known values and is monotone', () => {
  assert.ok(Math.abs(poissonUCB(0) - 2.9957) < 1e-3); // -ln(0.05)
  assert.ok(Math.abs(poissonUCB(5) - 10.513) < 1e-2);
  let prev = 0;
  for (let k = 0; k < 40; k++) { const u = poissonUCB(k); assert.ok(u > prev); assert.ok(u > k); prev = u; }
});

test('Poisson CDF agrees with direct summation (randomized)', () => {
  const R = rng(1);
  for (let i = 0; i < 200; i++) {
    const k = Math.floor(R() * 30), mu = R() * 25 + 0.01;
    let term = Math.exp(-mu), s = term;
    for (let j = 1; j <= k; j++) { term *= mu / j; s += term; }
    assert.ok(Math.abs(poissonCdf(k, mu) - s) < 1e-9);
  }
});

test('coverage counts singletons, doubletons and single-day behaviors', () => {
  const beh = [
    { id: 'a', daily: [5, 4, 6] },
    { id: 'b', daily: [1, 0, 0] },
    { id: 'c', daily: [0, 2, 0] },
    { id: 'd', daily: [0, 0, 0] },
    { id: 'e', daily: [0, 1, 1] },
  ];
  const c = coverage(beh, 3, [10, 10, 10]);
  assert.equal(c.T, 30); assert.equal(c.seen, 4); assert.equal(c.q1, 1); assert.equal(c.q2, 2); assert.equal(c.q1day, 2);
  assert.deepEqual(c.singles, ['b']); assert.ok(Math.abs(c.devRisk - 1 / 30) < 1e-12);
});

test('leave-one-out identity: mean count of behaviors unique to a held-out unit equals Q1/T (randomized)', () => {
  const R = rng(2);
  for (let trial = 0; trial < 100; trial++) {
    const T = 5 + Math.floor(R() * 40), S = 3 + Math.floor(R() * 30);
    const pis = Array.from({ length: S }, () => R() ** 4);
    const X = Array.from({ length: T }, () => pis.map((p) => R() < p));
    let q1 = 0;
    for (let s = 0; s < S; s++) { let n = 0; for (let t = 0; t < T; t++) n += X[t][s]; if (n === 1) q1++; }
    let loo = 0;
    for (let t = 0; t < T; t++) for (let s = 0; s < S; s++) {
      if (!X[t][s]) continue;
      let other = 0; for (let u = 0; u < T; u++) if (u !== t && X[u][s]) other++;
      if (other === 0) loo++;
    }
    assert.ok(Math.abs(loo / T - q1 / T) < 1e-12);
  }
});

test('Q1/T tracks the true expected number of unseen behaviors in the next device-day (Monte Carlo)', () => {
  const R = rng(3);
  const S = 200, pis = Array.from({ length: S }, (_, i) => 0.02 * Math.pow(i + 1, -1.2));
  const T = 3000; let estSum = 0, trueSum = 0;
  for (let rep = 0; rep < 60; rep++) {
    const n = new Array(S).fill(0);
    for (let t = 0; t < T; t++) for (let s = 0; s < S; s++) if (R() < pis[s]) n[s]++;
    estSum += n.filter((x) => x === 1).length / T;
    trueSum += pis.reduce((a, p, s) => a + (n[s] === 0 ? p : 0), 0);
  }
  const est = estSum / 60, tru = trueSum / 60;
  assert.ok(Math.abs(est - tru) / tru < 0.15, `est ${est} true ${tru}`);
});

test('95% upper bound covers the true unseen rate in at least ~95% of randomized fleets', () => {
  const R = rng(4);
  let miss = 0; const N = 300;
  for (let rep = 0; rep < N; rep++) {
    const S = 80, top = 0.001 + R() * 0.004, sExp = 1.1 + R() * 0.5;
    const pis = Array.from({ length: S }, (_, i) => top * Math.pow(i + 1, -sExp));
    const T = 2000 + Math.floor(R() * 6000);
    const n = new Array(S).fill(0);
    for (let s = 0; s < S; s++) { // binomial via Poisson approximation for speed
      const lam = pis[s] * T; let k = 0, p = Math.exp(-lam), c = p; const u = R();
      while (u > c && k < 1000) { k++; p *= lam / k; c += p; }
      n[s] = k;
    }
    const q1 = n.filter((x) => x === 1).length;
    const ucb = poissonUCB(q1) / T;
    const tru = pis.reduce((a, p, s) => a + (n[s] === 0 ? p : 0), 0);
    if (tru > ucb) miss++;
  }
  assert.ok(miss / N <= 0.08, `miss rate ${miss / N}`);
});

test('decision rule: unobserved, pending scheduled job, minimum window, budget', () => {
  const base = { seen: 5, D: 20, devUCB: 0.0005 };
  assert.equal(decide({ ...base, seen: 0 }, BUDGET), 'unobserved');
  assert.equal(decide(base, BUDGET, [{ label: 'monthly' }]), 'calendar');
  assert.equal(decide({ ...base, D: 7 }, BUDGET), 'learning');
  assert.equal(decide({ ...base, devUCB: 0.01 }, BUDGET), 'learning');
  assert.equal(decide(base, BUDGET), 'ready');
});

test('firmware-declared monthly job keeps crond out of enforcement until it has run (1 Nov = day 30)', () => {
  const crond = fleet.procs.find((p) => p.name === 'crond');
  assert.equal(pendingJobs(fleet.scheduled, 'crond', crond.behaviors, 21).length, 1);
  assert.equal(pendingJobs(fleet.scheduled, 'crond', crond.behaviors, 31).length, 0);
  assert.equal(decisions(fleet, 21).crond.status, 'calendar');
});

test('true block probability is zero with a complete allowlist and grows as behaviors are removed', () => {
  const p = fleet.procs.find((x) => x.name === 'dropbear');
  const all = new Set(p.behaviors.map((b) => b.id));
  assert.equal(trueBlockProb(p.behaviors, all, 5), 0);
  const learned = allowlist(p.behaviors, 14);
  const p14 = trueBlockProb(p.behaviors, learned, 20);
  const p3 = trueBlockProb(p.behaviors, allowlist(p.behaviors, 3), 20);
  assert.ok(p14 > 0 && p3 >= p14);
});

test('gated enforcement never blocks more than enforcing everything, at every cutoff', () => {
  for (const k of [7, 14, 21, 27]) {
    const dec = decisions(fleet, k);
    const ready = new Set(Object.keys(dec).filter((n) => dec[n].status === 'ready'));
    const g = realized(fleet, k, 14, ready), n = realized(fleet, k, 14, new Set(fleet.procs.map((p) => p.name)));
    assert.ok(g.blockedDeviceDays <= n.blockedDeviceDays);
  }
});

test('projected time-to-ready is finite for learning profiles and zero for ready ones', () => {
  const dec = decisions(fleet, 21);
  for (const [name, d] of Object.entries(dec)) {
    if (d.status === 'ready') assert.equal(d.eta, 0);
    if (d.status === 'learning') assert.ok(d.eta === null || d.eta > 0, name);
  }
  const dropbear = fleet.procs.find((p) => p.name === 'dropbear');
  assert.ok(etaDays(dropbear.behaviors, 21, fleet.devicesPerDay, BUDGET) > 0);
});

test('policy export has one allow rule per learned behavior', () => {
  const p = fleet.procs.find((x) => x.name === 'mosquitto');
  const allow = allowlist(p.behaviors, 21);
  const byId = Object.fromEntries(p.behaviors.map((b) => [b.id, b]));
  const toml = policyToml(p, allow, byId);
  assert.equal((toml.match(/\[\[rules\]\]/g) || []).length, allow.size);
  assert.ok(toml.includes('action = "allow"'));
});

test('generator is deterministic and matches committed data', () => {
  const committed = JSON.parse(readFileSync(new URL('../data/fleet.json', import.meta.url)));
  const slim = { ...fleet, procs: fleet.procs.map((p) => ({ ...p, behaviors: p.behaviors.map(({ events, ...b }) => ({ ...b, rareEvents: events.length })) })) };
  assert.deepEqual(JSON.parse(JSON.stringify(slim)), committed);
});

test('headline reproduces data/results.json', () => {
  const committed = JSON.parse(readFileSync(new URL('../data/results.json', import.meta.url)));
  const res = computeResults(fleet);
  assert.deepEqual(res.headline, committed.headline);
  assert.deepEqual(res.backtest, committed.backtest);
  assert.equal(res.headline.gatedFalseBlocks, 3);
  assert.equal(res.headline.naiveFalseBlocks, 631);
  // the bound held at every cutoff: realized rate of the gated set <= predicted union-bound UCB
  for (const b of res.backtest) assert.ok(b.gated.rate <= b.predictedUCB + 1e-12, `k=${b.cutoffDay}`);
});
