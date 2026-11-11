import { coverage, decide, pendingJobs, etaDays, allowlist, policyToml } from './src/readiness.js';

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const STORE = 'exein-readiness-v1';
const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
let fleet = null, results = null, model = null;
const state = {
  day: saved.day ?? null,
  budget: saved.budget ?? 0.001,
  modes: saved.modes || {},
  log: saved.log || [],
  cur: 0,
};
const persist = () => localStorage.setItem(STORE, JSON.stringify({ day: state.day, budget: state.budget, modes: state.modes, log: state.log.slice(0, 20) }));
const STATUS = {
  ready: { label: 'Ready to enforce', icon: 'shield-check' },
  learning: { label: 'Learning', icon: 'loader' },
  calendar: { label: 'Waiting on schedule', icon: 'calendar-clock' },
  unobserved: { label: 'Not observed', icon: 'circle-dashed' },
};
const pct = (x, d = 3) => (100 * x).toFixed(d) + '%';
const dateOf = (d) => { const t = new Date(Date.UTC(2026, 9, 2 + d)); return t.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); };
const icons = () => window.lucide && window.lucide.createIcons();
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2400); }

function compute() {
  const k = state.day;
  const budget = { perDeviceDay: state.budget, minDays: results.budget.minDays };
  const rows = fleet.procs.map((p) => {
    const c = coverage(p.behaviors, k, fleet.devicesPerDay, results.conf);
    const pending = pendingJobs(fleet.scheduled, p.name, p.behaviors, k);
    const status = decide(c, budget, pending);
    const eta = status === 'ready' ? 0 : status === 'learning' ? etaDays(p.behaviors, k, fleet.devicesPerDay, budget, results.conf) : null;
    return { p, c, pending, status, eta };
  });
  const ready = rows.filter((r) => r.status === 'ready');
  model = { k, budget, rows, ready, predUCB: ready.reduce((a, r) => a + r.c.devUCB, 0) };
}

function crumbs(items) {
  $('#crumbs').innerHTML = items.map(([t, s, h], i) => `<a class="crumb ${i === items.length - 1 ? 'cur' : ''}" href="${h}"><span class="t">${t}</span><span class="s">${s}</span></a>`).join('');
}

function route() {
  const raw = location.hash || '#/policies/readiness';
  const [h, qs] = raw.split('?');
  const q = new URLSearchParams(qs || '');
  if (q.has('day') && fleet) { const d = Math.max(7, Math.min(fleet.days, +q.get('day') || fleet.days)); if (d !== state.day) { state.day = d; compute(); } }
  const parts = h.replace(/^#\//, '').split('/');
  document.querySelectorAll('.tabs-top a').forEach((a) => a.classList.toggle('active', a.dataset.nav === parts[0]));
  if (!fleet) return;
  if (parts[0] !== 'policies') return renderEmpty(parts[0]);
  if (parts[1] === 'method') renderMethod();
  else if (parts[1] === 'readiness' && parts[2]) renderProc(decodeURIComponent(parts[2]));
  else renderMain();
  icons();
}
window.addEventListener('hashchange', route);

function renderEmpty(which) {
  crumbs([['Dashboard', 'Overview', '#/dashboard'], ['IoT Gateway GW-500', 'Product', '#/policies/readiness']]);
  view.innerHTML = `<div class="box empty"><i data-lucide="lock"></i><h2>${which ? which[0].toUpperCase() + which.slice(1) : 'Not found'}</h2><p>This concept demo only rebuilds <b>Policies → Enforcement readiness</b>.</p><p><a class="btn primary" href="#/policies/readiness">Open enforcement readiness</a></p></div>`;
  icons();
}

function statusPill(s) { return `<span class="pill ${s}"><i data-lucide="${STATUS[s].icon}"></i>${STATUS[s].label}</span>`; }

function riskMeter(ucb, budget) {
  const scale = budget * 3;
  const w = Math.min(100, (100 * ucb) / scale);
  const col = ucb <= budget ? 'var(--pos)' : ucb <= 2 * budget ? 'var(--warn)' : 'var(--orange)';
  return `<div class="risk"><span class="mono">≤ ${pct(ucb, 3)}</span><span class="meter" title="Budget ${pct(budget, 2)}"><span style="width:${w}%;background:${col}"></span><i style="left:${100 / 3}%"></i></span></div>`;
}

function renderMain() {
  crumbs([['Policies', 'Runtime', '#/policies/readiness'], ['IoT Gateway GW-500', 'Product · fw 3.2.2 · 600 devices', '#/policies/readiness'], ['Enforcement readiness', 'Monitor → Enforce', '#/policies/readiness']]);
  const k = model.k, h = results.headline;
  const counts = { ready: 0, learning: 0, calendar: 0, unobserved: 0 };
  model.rows.forEach((r) => counts[r.status]++);
  const enforcedNow = Object.entries(state.modes).filter(([, m]) => m === 'enforce').map(([n]) => n);
  const toEnforce = model.ready.filter((r) => state.modes[r.p.name] !== 'enforce');
  view.innerHTML = `
  <div class="ph"><div><h1><span class="dot ${counts.ready ? '' : 'orange'}"></span>Enforcement readiness</h1>
    <div class="sub">Learned allowlists from monitor mode · ${fleet.devices} devices · ${dateOf(0)} → ${dateOf(k - 1)} · ${model.rows.reduce((a, r) => a + r.c.T, 0) ? model.rows[0].c.T.toLocaleString() : 0} device-days</div></div>
    <div class="actions"><a class="btn ghost" href="#/policies/method"><i data-lucide="book-open"></i>How it works</a><button class="btn" id="exp"><i data-lucide="download"></i>Export policy</button><button class="btn" id="expJson"><i data-lucide="file-json"></i>Report JSON</button><button class="btn primary" id="enf" ${toEnforce.length ? '' : 'disabled'}><i data-lucide="shield-check"></i>Enforce ready (${toEnforce.length})</button></div></div>
  ${enforcedNow.length ? `<div class="banner done"><i data-lucide="shield-check"></i><div><b>${enforcedNow.length} profiles enforcing</b> on fw 3.2.2: ${enforcedNow.join(', ')}. ${state.log[0] ? '· ' + state.log[0] : ''}</div><button class="btn ghost" id="revert" style="margin-left:auto"><i data-lucide="undo-2"></i>Back to monitor</button></div>`
    : `<div class="banner"><i data-lucide="flask-conical"></i><div>Backtest on this fleet: enforcing only the profiles marked ready on ${dateOf(h.cutoffDay - 1)} would have falsely blocked <b>${h.gatedFalseBlocks} device-days</b> in the next two weeks (${h.gatedRatePct}%), versus <b>${h.naiveFalseBlocks}</b> (${h.naiveRatePct}%) when enforcing every learned profile, and still blocked ${h.attacksBlocked} of ${h.attacks} simulated attacks.</div></div>`}
  <div class="stats">
    <div class="stat"><div class="label">Ready to enforce</div><div class="v pos">${counts.ready}<small>/ ${model.rows.length}</small><i data-lucide="shield-check"></i></div><div class="d">profiles below the false-block budget</div></div>
    <div class="stat"><div class="label">Learning</div><div class="v warn">${counts.learning}</div><div class="d">still discovering rare behavior</div></div>
    <div class="stat"><div class="label">Waiting on schedule</div><div class="v orange">${counts.calendar}</div><div class="d">firmware cron job not yet run</div></div>
    <div class="stat"><div class="label">Not observed</div><div class="v">${counts.unobserved}</div><div class="d">no profile yet</div></div>
    <div class="stat"><div class="label">False-block risk if enforced</div><div class="v">≤ ${pct(model.predUCB, 2)}</div><div class="d">per device-day, 95% bound, ready set</div></div>
  </div>
  <div class="grid">
    <div class="box">
      <div class="controls">
        <label>Decide as of <input type="range" id="day" min="7" max="${fleet.days}" value="${k}" aria-label="Decision day" /><span class="day" id="dayLbl">${dateOf(k - 1)} · day ${k}</span></label>
        <label>False-block budget <select id="budget" aria-label="False-block budget per device-day">${[0.0005, 0.001, 0.002, 0.005].map((b) => `<option value="${b}" ${b === state.budget ? 'selected' : ''}>${pct(b, 2)} / device-day</option>`).join('')}</select></label>
        <span class="label" style="margin-left:auto">Confidence 95% · min window ${results.budget.minDays} days</span>
      </div>
      <table class="tbl" aria-label="Process profiles"><thead><tr><th>Process</th><th class="num">Behaviors</th><th class="num">Seen once</th><th class="num">False-block risk</th><th>Status</th><th class="num">ETA</th><th>Mode</th></tr></thead>
      <tbody id="rows">${model.rows.map((r, i) => `<tr tabindex="0" data-proc="${r.p.name}" class="${i === state.cur ? 'cur' : ''}">
        <td><div class="proc">${r.p.name}</div><div class="img">${r.p.image}</div></td>
        <td class="num">${r.c.seen}</td><td class="num">${r.c.q1}</td>
        <td class="num">${r.status === 'unobserved' ? '<span class="mono" style="color:var(--text-2)">no data</span>' : riskMeter(r.c.devUCB, state.budget)}</td>
        <td>${statusPill(r.status)}${r.pending.length ? `<div class="img" style="color:var(--orange)">${r.pending[0].label}</div>` : ''}</td>
        <td class="num mono">${r.status === 'ready' ? '–' : r.status === 'calendar' ? (r.pending[0] ? r.pending[0].next : '–') : r.eta == null ? '–' : `~${r.eta} d`}</td>
        <td><span class="mode ${state.modes[r.p.name] === 'enforce' ? 'enf' : ''}">${state.modes[r.p.name] === 'enforce' ? 'ENFORCE' : 'MONITOR'}</span></td></tr>`).join('')}</tbody></table>
      <div class="note"><b>Risk</b> = 95% upper bound on the chance that one more device-day shows a behavior this profile has never allowed (Good–Turing incidence estimate, leave-one-out exact: behaviors seen on exactly one device-day ÷ device-days). Ready needs risk under budget, ${results.budget.minDays}+ days of data and every firmware-scheduled job observed at least once.</div>
    </div>
    <div>
      <div class="box">
        <div class="box-h"><h2 class="label">Backtest · falsely blocked device-days in the next 14 days</h2><span class="mono" style="font-size:10.5px;color:var(--text-2)">√ scale</span></div>
        <div class="chart" id="bt"></div>
        <div class="legend"><span><i style="background:#ff7676"></i>Enforce every learned profile</span><span><i style="background:#91e99f"></i>Enforce ready profiles only</span></div>
      </div>
      <div class="box mt">
        <div class="box-h"><h2 class="label">Simulated attacks after ${dateOf(h.cutoffDay - 1)}</h2><span class="mono" style="font-size:11px;color:var(--text-2)">ready set from day ${h.cutoffDay}</span></div>
        <div class="inc">${results.attacks.map((a) => { const o = results.attacksAtCutoff.find((x) => x.id === a.id).outcome; return `<div class="inc-row"><i data-lucide="${o === 'blocked' ? 'shield-check' : o === 'detected' ? 'radar' : 'shield-off'}" class="${o === 'blocked' ? 'ok' : o === 'detected' ? 'det' : 'miss'}"></i><div><div class="t">${a.title}</div><div class="s">${a.proc} · ${a.what} · ${dateOf(a.day)}</div></div><div class="r"><span class="pill ${a.severity.toLowerCase()}">${a.severity}</span><span class="mode ${o === 'blocked' ? 'enf' : ''}">${o === 'blocked' ? 'BLOCKED' : o === 'detected' ? 'DETECTED ONLY' : 'ALLOWED'}</span></div></div>`; }).join('')}</div>
        <div class="note">Detected-only rows hit profiles not yet ready (detection rules still fire). The tcpdump case is legitimate technician behavior seen in monitoring: an allowlist cannot stop a stolen technician key.</div>
      </div>
    </div>
  </div>`;
  drawBacktest();
  bindMain();
}

function drawBacktest() {
  const el = $('#bt'); if (!el) return;
  const W = 370, H = 190, pl = 40, pb = 26, pt = 10;
  const bt = results.backtest;
  const max = Math.max(...bt.map((b) => b.naive.blockedDeviceDays)) * 1.1;
  const Y = (v) => pt + (H - pt - pb) * (1 - Math.sqrt(v / max));
  const bw = (W - pl - 10) / bt.length;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Backtest bar chart">`;
  [0, 50, 200, 500, 1000].filter((v) => v <= max).forEach((v) => { s += `<line x1="${pl}" x2="${W - 6}" y1="${Y(v)}" y2="${Y(v)}" stroke="#2a2f33"/><text x="${pl - 6}" y="${Y(v) + 3}" fill="#8c949a" font-size="9.5" text-anchor="end" font-family="JetBrains Mono">${v}</text>`; });
  bt.forEach((b, i) => {
    const x = pl + i * bw + 8;
    const w = (bw - 22) / 2;
    s += `<rect x="${x}" y="${Y(b.naive.blockedDeviceDays)}" width="${w}" height="${Y(0) - Y(b.naive.blockedDeviceDays)}" fill="#ff7676" rx="2"><title>Enforce all · day ${b.cutoffDay}: ${b.naive.blockedDeviceDays} device-days</title></rect>`;
    s += `<rect x="${x + w + 4}" y="${Y(b.gated.blockedDeviceDays)}" width="${w}" height="${Math.max(1, Y(0) - Y(b.gated.blockedDeviceDays))}" fill="#91e99f" rx="2"><title>Ready only · day ${b.cutoffDay}: ${b.gated.blockedDeviceDays} device-days (${b.readyCount} profiles)</title></rect>`;
    s += `<text x="${x + w}" y="${Y(b.naive.blockedDeviceDays) - 4}" fill="#ff7676" font-size="9.5" text-anchor="middle" font-family="JetBrains Mono">${b.naive.blockedDeviceDays}</text>`;
    s += `<text x="${x + 1.5 * w + 4}" y="${Y(b.gated.blockedDeviceDays) - 4}" fill="#91e99f" font-size="9.5" text-anchor="middle" font-family="JetBrains Mono">${b.gated.blockedDeviceDays}</text>`;
    s += `<text x="${x + w + 2}" y="${H - 8}" fill="#8c949a" font-size="9.5" text-anchor="middle" font-family="JetBrains Mono">day ${b.cutoffDay}</text>`;
  });
  s += `</svg>`;
  el.innerHTML = s;
}

function bindMain() {
  $('#day').oninput = (e) => { state.day = +e.target.value; $('#dayLbl').textContent = `${dateOf(state.day - 1)} · day ${state.day}`; debounced(); };
  $('#budget').onchange = (e) => { state.budget = +e.target.value; persist(); compute(); renderMain(); icons(); };
  document.querySelectorAll('#rows tr').forEach((tr, i) => { tr.onclick = () => (location.hash = `#/policies/readiness/${encodeURIComponent(tr.dataset.proc)}`); tr.onfocus = () => { state.cur = i; }; });
  $('#enf').onclick = openEnforce;
  $('#exp').onclick = exportToml;
  $('#expJson').onclick = exportJson;
  const rv = $('#revert'); if (rv) rv.onclick = () => { state.modes = {}; state.log.unshift(`${new Date().toLocaleString('en-GB')}: all profiles back to monitor`); persist(); renderMain(); icons(); toast('All profiles back to monitor mode'); };
}
const debounced = (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => { persist(); compute(); renderMain(); icons(); }, 120); }; })();

function openEnforce() {
  const list = model.ready.filter((r) => state.modes[r.p.name] !== 'enforce');
  if (!list.length) return;
  $('#enfBody').innerHTML = `<p>Switch these profiles from monitor to enforce on <b>fw 3.2.2</b> (${fleet.devices} devices). Anything outside each allowlist will be denied at the LSM hook.</p><ul>${list.map((r) => `<li><span class="mono">${r.p.name}</span> · ${r.c.seen} behaviors · risk ≤ ${pct(r.c.devUCB, 3)}</li>`).join('')}</ul><p>Combined false-block bound: <b>≤ ${pct(list.reduce((a, r) => a + r.c.devUCB, 0), 2)}</b> per device-day.</p>`;
  const d = $('#enfDlg'); d.showModal();
  d.onclose = () => {
    if (d.returnValue !== 'ok') return;
    list.forEach((r) => (state.modes[r.p.name] = 'enforce'));
    state.log.unshift(`${new Date().toLocaleString('en-GB')}: enforced ${list.length} profiles (decided on day ${model.k})`);
    persist(); renderMain(); icons(); toast(`${list.length} profiles now enforcing`);
  };
}
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
function exportToml() {
  const parts = model.ready.map((r) => policyToml(r.p, allowlist(r.p.behaviors, model.k), Object.fromEntries(r.p.behaviors.map((b) => [b.id, b]))));
  download(`gw500-fw3.2.2-allowlists-day${model.k}.toml`, parts.join('\n') || '# no profiles ready', 'text/plain'); toast(`Exported ${model.ready.length} allowlists (TOML)`);
}
function exportJson() {
  const out = { product: 'IoT Gateway GW-500', firmware: '3.2.2', decidedOnDay: model.k, budgetPerDeviceDay: state.budget, confidence: results.conf,
    profiles: model.rows.map((r) => ({ process: r.p.name, image: r.p.image, status: r.status, behaviors: r.c.seen, seenOnce: r.c.q1, deviceDays: r.c.T, riskUCB: +r.c.devUCB.toFixed(6), pendingScheduledJobs: r.pending.map((j) => j.label), etaDays: r.eta })) };
  download(`gw500-readiness-day${model.k}.json`, JSON.stringify(out, null, 2), 'application/json'); toast('Exported readiness report (JSON)');
}

function renderProc(name) {
  const r = model.rows.find((x) => x.p.name === name);
  if (!r) { view.innerHTML = `<div class="err">No profile named <b>${name}</b> on this product. <a href="#/policies/readiness">Back to enforcement readiness</a></div>`; return; }
  crumbs([['Policies', 'Runtime', '#/policies/readiness'], ['IoT Gateway GW-500', 'Product · fw 3.2.2', '#/policies/readiness'], [name, 'Process profile', '#/policies/readiness/' + name]]);
  const k = model.k;
  const beh = r.p.behaviors.map((b) => { let n = 0, days = 0, first = -1; for (let d = 0; d < k; d++) { if (b.daily[d] > 0) { n += b.daily[d]; days++; if (first < 0) first = d; } } return { b, n, days, first }; })
    .sort((a, b) => b.n - a.n);
  const seen = beh.filter((x) => x.n > 0);
  view.innerHTML = `
  <div class="ph"><div><h1><span class="dot ${r.status === 'ready' ? '' : 'orange'}"></span>${name}</h1><div class="sub mono">${r.p.image} · ${r.p.owner}</div></div>
    <div class="actions"><a class="btn ghost" href="#/policies/readiness"><i data-lucide="arrow-left"></i>All profiles</a>${statusPill(r.status)}</div></div>
  <div class="kv">
    <div class="stat"><div class="label">Behaviors allowed</div><div class="v">${r.c.seen}</div><div class="d">observed in ${k} days</div></div>
    <div class="stat"><div class="label">Seen on one device-day</div><div class="v ${r.c.q1 ? 'warn' : 'pos'}">${r.c.q1}</div><div class="d">Q1 · drives the risk estimate</div></div>
    <div class="stat"><div class="label">Device-days</div><div class="v">${r.c.T.toLocaleString()}</div><div class="d">${fleet.devices} devices × ${k} days, online only</div></div>
    <div class="stat"><div class="label">False-block risk</div><div class="v">≤ ${pct(r.c.devUCB, 3)}</div><div class="d">point ${pct(r.c.devRisk, 4)} · budget ${pct(state.budget, 2)}</div></div>
    <div class="stat"><div class="label">Ready in</div><div class="v ${r.status === 'ready' ? 'pos' : 'orange'}">${r.status === 'ready' ? 'now' : r.status === 'calendar' ? (r.pending[0]?.next || '–') : r.eta == null ? '–' : '~' + r.eta + ' d'}</div><div class="d">${r.status === 'calendar' ? r.pending.map((j) => j.label).join(', ') : 'power-law fit of the discovery curve'}</div></div>
  </div>
  <div class="grid">
    <div class="box"><div class="box-h"><h2 class="label">Learned behaviors (${seen.length})</h2><span class="mono" style="font-size:11px;color:var(--text-2)">sorted by device-days</span></div>
      <table class="tbl"><thead><tr><th>Behavior</th><th>Type</th><th class="num">Device-days</th><th class="num">Days</th><th>First seen</th></tr></thead><tbody>
      ${seen.slice(0, 40).map((x) => `<tr><td><div class="cond" title="${x.b.cond.replace(/"/g, '&quot;')}">${x.b.cond}</div>${x.n === 1 ? '<span class="tag">SEEN ONCE</span>' : ''}${x.b.schedule ? '<span class="tag">SCHEDULED</span>' : ''}</td><td class="mono">${x.b.type}</td><td class="num">${x.n.toLocaleString()}</td><td class="num">${x.days}</td><td class="mono">${dateOf(x.first)}</td></tr>`).join('')}
      ${seen.length > 40 ? `<tr><td colspan="5" class="mono" style="color:var(--text-2)">+ ${seen.length - 40} more in the export</td></tr>` : ''}
      ${!seen.length ? '<tr><td colspan="5" style="color:var(--text-2)">Nothing observed yet for this process.</td></tr>' : ''}
      </tbody></table></div>
    <div><div class="box"><div class="box-h"><h2 class="label">Discovery curve</h2></div><div class="chart" id="disc"></div>
      <div class="legend"><span><i style="background:#95d1ff"></i>Distinct behaviors</span><span><i style="background:#ffc583"></i>Risk bound (log)</span><span><i style="background:#91e99f"></i>Budget</span></div></div>
      ${r.pending.length ? `<div class="box mt"><div class="box-h"><h2 class="label">Scheduled in firmware, not yet observed</h2></div>${r.pending.map((j) => `<div class="inc-row"><i data-lucide="calendar-clock" class="det"></i><div><div class="t">${j.label}</div><div class="s">${j.cron} · next ${j.next} · from /etc/crontabs/root</div></div></div>`).join('')}</div>` : ''}
    </div>
  </div>`;
  drawDiscovery(r);
}

function drawDiscovery(r) {
  const W = 370, H = 210, pl = 34, pr = 40, pt = 10, pb = 24;
  const pts = [];
  for (let d = 1; d <= model.k; d++) { const c = coverage(r.p.behaviors, d, fleet.devicesPerDay, results.conf); pts.push({ d, seen: c.seen, ucb: c.devUCB }); }
  const maxS = Math.max(1, ...pts.map((p) => p.seen));
  const X = (d) => pl + ((d - 1) / Math.max(1, model.k - 1)) * (W - pl - pr);
  const Ys = (v) => pt + (H - pt - pb) * (1 - v / maxS);
  const lmin = Math.log10(1e-5), lmax = Math.log10(1);
  const Yr = (v) => pt + (H - pt - pb) * (1 - (Math.log10(Math.max(1e-5, v)) - lmin) / (lmax - lmin));
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Discovery curve">`;
  [0, 0.5, 1].forEach((f) => { const v = Math.round(maxS * f); s += `<line x1="${pl}" x2="${W - pr}" y1="${Ys(v)}" y2="${Ys(v)}" stroke="#2a2f33"/><text x="${pl - 5}" y="${Ys(v) + 3}" fill="#95d1ff" font-size="9" text-anchor="end" font-family="JetBrains Mono">${v}</text>`; });
  [1e-4, 1e-3, 1e-2, 1e-1].forEach((v) => { s += `<text x="${W - pr + 4}" y="${Yr(v) + 3}" fill="#ffc583" font-size="9" font-family="JetBrains Mono">${v >= 0.01 ? (v * 100) + '%' : (v * 100).toFixed(v < 1e-3 ? 2 : 1) + '%'}</text>`; });
  s += `<line x1="${pl}" x2="${W - pr}" y1="${Yr(state.budget)}" y2="${Yr(state.budget)}" stroke="#91e99f" stroke-dasharray="4 3"/>`;
  s += `<polyline fill="none" stroke="#95d1ff" stroke-width="1.6" points="${pts.map((p) => `${X(p.d)},${Ys(p.seen)}`).join(' ')}"/>`;
  s += `<polyline fill="none" stroke="#ffc583" stroke-width="1.6" points="${pts.map((p) => `${X(p.d)},${Yr(p.ucb)}`).join(' ')}"/>`;
  [1, Math.ceil(model.k / 2), model.k].forEach((d) => { s += `<text x="${X(d)}" y="${H - 6}" fill="#8c949a" font-size="9" text-anchor="middle" font-family="JetBrains Mono">${dateOf(d - 1)}</text>`; });
  $('#disc').innerHTML = s + '</svg>';
}

function renderMethod() {
  crumbs([['Policies', 'Runtime', '#/policies/readiness'], ['Enforcement readiness', 'How it works', '#/policies/method']]);
  const bt = results.backtest;
  view.innerHTML = `<div class="ph"><div><h1>How enforcement readiness works</h1><div class="sub">When is a profile learned in monitor mode complete enough to deny everything else?</div></div><div class="actions"><a class="btn ghost" href="#/policies/readiness"><i data-lucide="arrow-left"></i>Back</a></div></div>
  <div class="box"><div class="prose">
  <h2>The question</h2><p>Photon blocks at the LSM hook before an action runs, so a profile in enforce mode denies anything it has not allowed. The risk is a legitimate but rare behavior (a technician command, a fallback endpoint, a monthly job) that monitoring never saw. Waiting a fixed number of days does not answer how rare is rare enough.</p>
  <h2>Estimator</h2><p>Treat each device-day as a sample. Let <code>T</code> be device-days observed and <code>Q1</code> the number of behaviors seen on exactly one of them. Hold out any one device-day: the behaviors it shows that the other <code>T−1</code> never showed are exactly the ones unique to it, so averaged over all held-out days the count is <code>Q1/T</code> (an exact identity, tested). That is the Good–Turing estimate of how many never-allowed behaviors the next device-day will show, which bounds the chance it gets falsely blocked.</p>
  <div class="eq">risk ≤ UCB95(Q1) / T      UCB95 = exact Poisson upper bound (Q1 = 0 → 3.0)</div>
  <h2>Decision</h2><p>A profile is ready when the bound is below the false-block budget, there are at least ${results.budget.minDays} days of data, and every job the firmware schedules for that process (<code>/etc/crontabs/root</code>, as Analyzer extracts it) has run at least once. Statistics alone cannot see a monthly job that has not run yet; the firmware tells us it exists. Time-to-ready comes from a power-law fit of the bound against device-days.</p>
  <h2>Backtest (simulated fleet, 600 devices)</h2><p>${bt.map((b) => `Day ${b.cutoffDay}: ${b.readyCount} ready, ${b.gated.blockedDeviceDays} false-blocked device-days in the next 14 days vs ${b.naive.blockedDeviceDays} enforcing everything (bound ${pct(b.predictedUCB, 2)}/device-day, realized ${pct(b.gated.rate, 3)}).`).join(' ')}</p>
  <h2>Limits</h2><p>Device-days are not fully independent (fleet-wide rollouts, shared operators), which the calendar rule only partly covers. A stolen technician credential performing technician actions stays allowed. Profiles are per firmware version; an update starts a new profile. Data is synthetic, seeded from typical embedded-Linux gateway behavior.</p>
  </div></div>`;
}

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey) return;
  const k = e.key;
  if (k === '?') return $('#keysDlg').showModal();
  if (k === 'Escape' && location.hash.split('/').length > 3) { location.hash = '#/policies/readiness'; return; }
  if (!/^#\/policies\/readiness(\?.*)?$/.test(location.hash || '#/policies/readiness')) return;
  if (k === 'j' || k === 'k') { state.cur = Math.max(0, Math.min(model.rows.length - 1, state.cur + (k === 'j' ? 1 : -1))); const tr = document.querySelectorAll('#rows tr')[state.cur]; if (tr) { document.querySelectorAll('#rows tr').forEach((x) => x.classList.remove('cur')); tr.classList.add('cur'); tr.focus(); } }
  else if (k === 'Enter') { const tr = document.querySelectorAll('#rows tr')[state.cur]; if (tr) tr.click(); }
  else if (k === '[' || k === ']') { state.day = Math.max(7, Math.min(fleet.days, state.day + (k === ']' ? 1 : -1))); persist(); compute(); renderMain(); icons(); }
  else if (k === 'e' || k === 'E') openEnforce();
  else if (k === 'x' || k === 'X') exportToml();
});
$('#helpBtn').onclick = () => $('#keysDlg').showModal();

(async function boot() {
  try {
    const [a, b] = await Promise.all([fetch('data/fleet.json'), fetch('data/results.json')]);
    if (!a.ok || !b.ok) throw new Error(`HTTP ${a.status}/${b.status}`);
    fleet = await a.json(); results = await b.json();
    if (state.day == null) state.day = fleet.days;
    compute();
    if (!location.hash) history.replaceState(null, '', '#/policies/readiness');
    route();
  } catch (err) {
    view.innerHTML = `<div class="err"><b>Could not load fleet telemetry.</b> ${err.message || err}. <button class="btn" onclick="location.reload()">Retry</button></div>`;
  }
  icons();
})();
