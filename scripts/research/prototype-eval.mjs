// Offline prototype: request-level conformal prediction sets with pairwise-tuned head-to-head scores.
// Usage: node prototype.mjs <corpus.json>   (reads local data only; makes no provider requests)
import { readFileSync } from 'node:fs';
import { createFingerprintBank, defaultBank, fingerprint } from '../../dist/index.js';

const corpus = JSON.parse(readFileSync(process.argv[2], 'utf8'));
// Predeclared collection-quality rule: a run where >=90% of positions repeat at one period <= 128 is a loop.
const isLoop = (r) => { for (let p = 1; p <= 128; p++) { let s = 0; for (let i = p; i < r.length; i++) if (r[i] === r[i - p]) s++; if (s / (r.length - p) >= 0.9) return true; } return false; };
if (process.env.DROP_LOOPS) for (const m of corpus.models) {
  const before = m.training.length + m.validation.length;
  m.training = m.training.filter((r) => !isLoop(r)); m.validation = m.validation.filter((r) => !isLoop(r));
  if (m.training.length + m.validation.length < before) console.log(`dropped ${before - m.training.length - m.validation.length} looping run(s) from ${m.id}`);
}
const ALPHA = 0.2;          // target miscoverage; split equally between the fit test and the margin test
const SMOOTH = 0.5;         // Jeffreys, as in the bank
const BOOT = 2000;          // bootstrap tuples for multi-request nulls
const N = 355;
const PAIR = ['gpt-6.1-sol', 'gpt-6-astra'];

// ---------- Feature families: each maps a run to categorical events ----------
const FAMILIES = [
  ['value', N, (r) => r.map((x) => x - 1)],
  ['step', N, (r) => r.slice(1).map((x, i) => (x - r[i] + N) % N)],
  ['bin bigram', 400, (r) => r.slice(1).map((x, i) => Math.floor((r[i] - 1) / 17.75) * 20 + Math.floor((x - 1) / 17.75))],
  ['digit bigram', 100, (r) => r.slice(1).map((x, i) => (r[i] % 10) * 10 + (x % 10))],
  ['first use', N * 4, (r) => { const seen = new Set(), out = []; r.forEach((x, t) => { if (!seen.has(x)) { seen.add(x); out.push((x - 1) * 4 + Math.min(3, Math.floor(t / 89))); } }); return out; }],
  ['opening 8', N * 8, (r) => r.slice(0, 8).map((x, t) => t * N + x - 1)],
  ['repeat gap', 12, (r) => { const last = new Map(), out = []; r.forEach((x, t) => { const g = last.has(x) ? t - last.get(x) : -1; out.push(g < 0 ? 0 : Math.min(11, 1 + Math.floor(Math.log2(g)))); last.set(x, t); }); return out; }],
].map(([name, size, ev]) => ({ name, size, ev }));
const F = FAMILIES.length;
const VALUE_ONLY = [0];
const ALL = FAMILIES.map((_, f) => f);

// ---------- Runs and per-model counts ----------
const models = corpus.models.map((m) => m.id);
const M = models.length;
const runs = [];
corpus.models.forEach((m, mi) => [...m.training, ...m.validation].forEach((samples, index) => {
  const ev = FAMILIES.map(({ ev }) => { const map = new Map(); let total = 0; for (const e of ev(samples)) { map.set(e, (map.get(e) ?? 0) + 1); total++; } return { map, total }; });
  runs.push({ id: runs.length, model: mi, index, inTraining: index < m.training.length, samples, ev });
}));
const byModel = models.map((_, mi) => runs.filter((r) => r.model === mi));
const counts = models.map((_, mi) => FAMILIES.map(({ size }, f) => {
  const c = new Float64Array(size); let total = 0;
  for (const r of byModel[mi]) { for (const [e, n] of r.ev[f].map) c[e] += n; total += r.ev[f].total; }
  return { c, total };
}));

/** Log-likelihood of run r under model m's family-f categorical, fitted without the excluded runs. */
function loglik(r, m, f, excluded) {
  const { c, total } = counts[m][f];
  const ex = excluded.filter((x) => x.model === m);
  let n = total; for (const x of ex) n -= x.ev[f].total;
  const logDenom = Math.log(n + SMOOTH * FAMILIES[f].size);
  let s = 0;
  for (const [e, k] of r.ev[f].map) { let v = c[e]; for (const x of ex) v -= x.ev[f].map.get(e) ?? 0; s += k * (Math.log(v + SMOOTH) - logDenom); }
  return s;
}

// BASE[r][m][f]: leave-own-run-out log-likelihoods.
const BASE = runs.map((r) => models.map((_, m) => FAMILIES.map((_, f) => loglik(r, m, f, [r]))));

/** Per-run log-likelihood table with the held-out group removed from its own model's fit. */
function tableFor(group) {
  if (!group.length) return BASE;
  const t = group[0].model;
  const inGroup = new Set(group.map((r) => r.id));
  return runs.map((r) => models.map((_, m) => m !== t ? BASE[r.id][m]
    : FAMILIES.map((_, f) => loglik(r, t, f, inGroup.has(r.id) ? group : [r, ...group]))));
}

// ---------- Scores ----------
function mulberry32(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const meanOf = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Diagonal-LDA weights over family LLRs for (a vs b), clipped to nonnegative, with standardization. */
function pairStat(X, a, b, runsA, runsB, fams) {
  const llr = (r) => fams.map((f) => X[r.id][a][f] - X[r.id][b][f]);
  const xa = runsA.map(llr), xb = runsB.map(llr);
  const w = fams.map((_, j) => {
    const ma = meanOf(xa.map((row) => row[j])), mb = meanOf(xb.map((row) => row[j]));
    const v = (xa.reduce((s, row) => s + (row[j] - ma) ** 2, 0) + xb.reduce((s, row) => s + (row[j] - mb) ** 2, 0)) / (xa.length + xb.length - 2);
    return v > 0 && ma > mb ? (ma - mb) / v : 0;
  });
  if (w.every((x) => x === 0)) w.fill(1);
  const D = (r) => fams.reduce((s, f, j) => s + w[j] * (X[r.id][a][f] - X[r.id][b][f]), 0);
  const da = runsA.map(D), db = runsB.map(D);
  const ma = meanOf(da), mb = meanOf(db);
  const V = (da.reduce((s, x) => s + (x - ma) ** 2, 0) + db.reduce((s, x) => s + (x - mb) ** 2, 0)) / (da.length + db.length - 2);
  const sd = Math.sqrt(Math.max(V, 1e-12));
  /** Standardized head-to-head score: positive favors a. */
  return (r) => (D(r) - (ma + mb) / 2) / sd;
}

/** Per-family log-likelihood profile of model m, for a two-sided fit test. */
function profileStat(X, m, runsM, fams) {
  const mu = fams.map((f) => meanOf(runsM.map((r) => X[r.id][m][f])));
  const sd = fams.map((f, j) => Math.sqrt(Math.max(runsM.reduce((s, r) => s + (X[r.id][m][f] - mu[j]) ** 2, 0) / (runsM.length - 1), 1e-12)));
  return (r) => fams.map((f, j) => (X[r.id][m][f] - mu[j]) / sd[j]);
}

/**
 * Prediction set for one held-out unit (one or more requests from the same endpoint).
 * Label m stays in the set unless the unit is extreme against m's own held-out runs on either
 * (a) a fit test under m, or (b) the worst head-to-head margin of m over any competitor.
 * With crossFit, every calibration run is scored by statistics fitted without that run,
 * so calibration scores are exchangeable with the test unit's.
 */
function predictSet(X, unit, labels, cal, { fams, margin, fit, crossFit }, rand) {
  const k = unit.length;
  const total = (r, m) => fams.reduce((s, f) => s + X[r.id][m][f], 0);
  const competitors = (m) => labels.filter((o) => o !== m);
  const without = (rs, r) => rs.filter((x) => x !== r);
  const fullPairs = new Map();
  const pair = (m, o) => { const key = `${m},${o}`; if (!fullPairs.has(key)) fullPairs.set(key, pairStat(X, m, o, cal[m], cal[o], fams)); return fullPairs.get(key); };
  const fullProfiles = new Map();
  const profile = (m) => { if (!fullProfiles.has(m)) fullProfiles.set(m, profileStat(X, m, cal[m], fams)); return fullProfiles.get(m); };

  /** Per-run additive components under label m. `self` is the calibration run being cross-fitted. */
  const components = (r, m, self) => {
    const fitPart = fit === 'total' ? [total(r, m)]
      : (self && crossFit ? profileStat(X, m, without(cal[m], self), fams) : profile(m))(r);
    const marginPart = competitors(m).map((o) => {
      if (margin === 'plain') return total(r, m) - total(r, o);
      return (self && crossFit ? pairStat(X, m, o, without(cal[m], self), cal[o], fams) : pair(m, o))(r);
    });
    return { fitPart, marginPart };
  };
  /** Aggregate a tuple's components; both scores are "higher conforms better". */
  const aggregate = (parts) => {
    const n = parts.length;
    const fitSum = parts[0].fitPart.map((_, j) => parts.reduce((s, p) => s + p.fitPart[j], 0));
    const fitScore = fit === 'total' ? fitSum[0] : -fitSum.reduce((s, x) => s + (x * x) / n, 0);
    let worst = Infinity;
    for (let j = 0; j < parts[0].marginPart.length; j++) {
      const v = parts.reduce((s, p) => s + p.marginPart[j], 0) / (margin === 'pairwise' ? Math.sqrt(n) : 1);
      if (v < worst) worst = v;
    }
    return [fitScore, worst];
  };

  const set = [];
  for (const m of labels) {
    const calParts = cal[m].map((r) => components(r, m, r));
    const nulls = k === 1 ? calParts.map((p) => aggregate([p]))
      : Array.from({ length: BOOT }, () => aggregate(Array.from({ length: k }, () => calParts[Math.floor(rand() * calParts.length)])));
    const [fitScore, marginScore] = aggregate(unit.map((r) => components(r, m, null)));
    const pFit = (1 + nulls.filter(([a]) => a <= fitScore).length) / (nulls.length + 1);
    const pMargin = (1 + nulls.filter(([, b]) => b <= marginScore).length) / (nulls.length + 1);
    if (pFit > ALPHA / 2 && pMargin > ALPHA / 2) set.push(m);
  }
  return set;
}

// ---------- Evaluation ----------
const VARIANTS = {
  'C1 value counts, run-level calibration': { fams: VALUE_ONLY, margin: 'plain', fit: 'total', crossFit: false },
  'C2 all families, plain margin': { fams: ALL, margin: 'plain', fit: 'total', crossFit: false },
  'C3 all families, pairwise margin': { fams: ALL, margin: 'pairwise', fit: 'total', crossFit: false },
  'C4 C3 + cross-fitted calibration': { fams: ALL, margin: 'pairwise', fit: 'total', crossFit: true },
  'C5 C4 + per-family profile fit test': { fams: ALL, margin: 'pairwise', fit: 'profile', crossFit: true },
};
const KS = (process.env.KS ?? '1,3,5').split(',').map(Number);
const groupsOf = (mi, k) => { const G = Math.round(byModel[mi].length / k); return Array.from({ length: G }, (_, g) => byModel[mi].filter((_, i) => i % G === g)).filter((g) => g.length); };
const label = (set) => set.length ? `{${set.map((m) => models[m]).join(', ')}}` : '{}';

function evaluate(k, mode) {
  const rand = mulberry32(12345 + k);
  const out = Object.fromEntries(Object.keys(VARIANTS).map((v) => [v, { n: 0, cover: 0, correctSingle: 0, wrongSingle: 0, multi: 0, empty: 0, size: 0, pairSlice: {}, wrongByModel: {} }]));
  for (let t = 0; t < M; t++) {
    for (const group of groupsOf(t, k)) {
      const X = mode === 'inbank' ? tableFor(group) : BASE;
      const labels = models.map((_, m) => m).filter((m) => mode === 'inbank' || m !== t);
      const held = new Set(group.map((r) => r.id));
      const cal = Object.fromEntries(labels.map((m) => [m, byModel[m].filter((r) => !held.has(r.id))]));
      for (const [name, variant] of Object.entries(VARIANTS)) {
        const set = predictSet(X, group, labels, cal, variant, rand);
        const o = out[name];
        o.n++; o.size += set.length;
        if (set.includes(t)) o.cover++;
        if (set.length === 1) {
          if (set[0] === t) o.correctSingle++;
          else { o.wrongSingle++; o.wrongByModel[models[t]] = (o.wrongByModel[models[t]] ?? 0) + 1; }
        } else if (set.length === 0) o.empty++;
        else o.multi++;
        if (PAIR.includes(models[t])) { const key = `${models[t]} → ${label(set)}`; o.pairSlice[key] = (o.pairSlice[key] ?? 0) + 1; }
      }
    }
  }
  return out;
}

async function baseline(mode) {
  const tally = { n: 0, correct: 0, wrong: 0, inconclusive: 0, unknown: 0, pairSlice: {}, wrongByModel: {} };
  // Refit from the (possibly cleaned) corpus so the baseline sees the same runs as the prototype.
  const bundled = process.env.DROP_LOOPS || process.env.REFIT_LOMO ? createFingerprintBank({ source: 'cleaned', protocol: corpus.protocol, checkpoints: corpus.checkpoints, models: corpus.models }) : defaultBank();
  for (const r of runs) {
    let bank;
    if (mode === 'lomo') bank = { ...bundled, models: bundled.models.filter((m) => m.id !== models[r.model]) };
    else bank = createFingerprintBank({
      source: 'loro-prototype', protocol: corpus.protocol, checkpoints: corpus.checkpoints,
      models: corpus.models.map((m, mi) => ({
        id: m.id, family: m.family,
        training: m.training.filter((_, i) => !(mi === r.model && i === r.index)),
        validation: m.validation.filter((_, i) => !(mi === r.model && i + m.training.length === r.index)),
      })),
    });
    const transport = { name: 'openai', granularity: 'token', async *stream() { yield r.samples.join(' ') + ' '; } };
    const result = await fingerprint(transport, { bank, earlyStopping: false });
    tally.n++;
    if (result.status === 'IDENTIFIED') {
      if (result.model === models[r.model]) tally.correct++;
      else { tally.wrong++; tally.wrongByModel[models[r.model]] = (tally.wrongByModel[models[r.model]] ?? 0) + 1; }
    } else if (result.status === 'UNKNOWN_MODEL') tally.unknown++;
    else tally.inconclusive++;
    if (PAIR.includes(models[r.model])) { const key = `${models[r.model]} → ${result.status === 'IDENTIFIED' ? `{${result.model}}` : result.status}`; tally.pairSlice[key] = (tally.pairSlice[key] ?? 0) + 1; }
  }
  return tally;
}

const pct = (x, n) => `${x}/${n}`;
const sorted = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
function printSets(title, results, lomo) {
  console.log(`\n### ${title}`);
  console.log('| Method | True model in set | Correct singleton | Wrong singleton | Set of 2+ | Empty | Mean set size |');
  console.log('|---|---|---|---|---|---|---|');
  for (const [name, o] of Object.entries(results)) console.log(`| ${name} | ${pct(o.cover, o.n)} | ${pct(o.correctSingle, o.n)} | ${pct(o.wrongSingle, o.n)} | ${pct(o.multi, o.n)} | ${pct(o.empty, o.n)} | ${(o.size / o.n).toFixed(2)} |`);
  for (const [name, o] of Object.entries(results)) {
    console.log(`  ${name.slice(0, 2)} pair slice:`, sorted(o.pairSlice));
    if (lomo) console.log(`  ${name.slice(0, 2)} wrong singletons by removed model:`, sorted(o.wrongByModel));
  }
}

const started = Date.now();
if (!process.env.SKIP_BASELINE) {
  const b0 = await baseline('inbank');
  console.log(`### Baseline (current engine, bank refit without the held-out run), k=1, n=${b0.n}`);
  console.log(`IDENTIFIED correct ${b0.correct}, IDENTIFIED wrong ${b0.wrong}, INCONCLUSIVE ${b0.inconclusive}, UNKNOWN_MODEL ${b0.unknown}`);
  console.log('  pair slice:', sorted(b0.pairSlice));
  const b0u = await baseline('lomo');
  console.log(`### Baseline, model removed from bank (unenrolled), n=${b0u.n}`);
  console.log(`IDENTIFIED (necessarily wrong) ${b0u.wrong}, INCONCLUSIVE ${b0u.inconclusive}, UNKNOWN_MODEL ${b0u.unknown}`);
  console.log('  wrong by removed model:', sorted(b0u.wrongByModel));
}
for (const k of KS) {
  printSets(`Enrolled, held-out units of k=${k} request(s) (alpha=${ALPHA})`, evaluate(k, 'inbank'), false);
  printSets(`Unenrolled model (label removed), units of k=${k} (want: empty set)`, evaluate(k, 'lomo'), true);
}
console.log(`\nelapsed ${((Date.now() - started) / 1000).toFixed(1)} s`);
