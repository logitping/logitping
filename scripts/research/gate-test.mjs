// THROWAWAY spike (piece 2): exploratory, designed after seeing the fresh-data results.
// Does putting the current per-response OOD envelope in front of the pooled prediction sets keep
// enrolled and unenrolled error rates low while still separating gpt-6.1-sol from gpt-6-astra?
// Usage: KS=4,8 node gate-test.mjs <corpus.json>   (reads local data only; makes no provider requests)
import { readFileSync } from 'node:fs';
import { assessOOD, createFingerprintBank, createNuisanceProjector, orderedBlockFeatures, SequentialTest } from '../../dist/index.js';

const corpus = JSON.parse(readFileSync(process.argv[2], 'utf8'));
// Loop rule with the period capped at n/4, so short runs are not flagged on a handful of comparisons.
const isLoop = (r) => { for (let p = 1; p <= Math.min(128, Math.floor(r.length / 4)); p++) { let s = 0; for (let i = p; i < r.length; i++) if (r[i] === r[i - p]) s++; if (s / (r.length - p) >= 0.9) return true; } return false; };
for (const m of corpus.models) {
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
  'C4 all families, pairwise margin, cross-fitted': { fams: ALL, margin: 'pairwise', fit: 'total', crossFit: true },
};
const KS = (process.env.KS ?? '1,3,5').split(',').map(Number);
const groupsOf = (mi, k) => { const G = Math.round(byModel[mi].length / k); return Array.from({ length: G }, (_, g) => byModel[mi].filter((_, i) => i % G === g)).filter((g) => g.length); };
const label = (set) => set.length ? `{${set.map((m) => models[m]).join(', ')}}` : '{}';

// ---------- Current-engine pieces: per-response OOD envelopes and the pooled sequential test ----------
const FEATURES = runs.map((r) => orderedBlockFeatures(r.samples).vector);
const N_SAMPLES = corpus.protocol.targetSamples;

/** Bank fitted without the held-out group (enrolled) or without the group's model (unenrolled). */
function bankFor(group, mode) {
  const t = group[0].model;
  const held = new Set(group.map((r) => r.index));
  const fit = corpus.models.flatMap((m, mi) => mode === 'lomo' && mi === t ? [] : [{
    id: m.id, family: m.family,
    training: m.training.filter((_, i) => !(mi === t && held.has(i))),
    validation: m.validation.filter((_, i) => !(mi === t && held.has(i + m.training.length))),
  }]);
  return createFingerprintBank({ source: 'gate-test', protocol: corpus.protocol, checkpoints: corpus.checkpoints, models: fit });
}

const lomoBanks = new Map();
/** Which models' envelopes accept every response in the group, and the current engine's pooled verdict. */
function engineView(group, mode) {
  const t = group[0].model;
  if (mode === 'lomo' && !lomoBanks.has(t)) lomoBanks.set(t, bankFor(group, mode));
  const bank = mode === 'lomo' ? lomoBanks.get(t) : bankFor(group, mode);
  const project = createNuisanceProjector(bank.nuisanceDirections);
  const acceptAll = new Map();
  for (const model of bank.models) {
    const profile = model.profiles.find((p) => p.sampleCount === N_SAMPLES);
    acceptAll.set(models.indexOf(model.id), group.every((r) => assessOOD(FEATURES[r.id], profile, project).accepted));
  }
  const test = new SequentialTest(bank.models.map((model) => ({ id: model.id, probabilities: model.integerProbabilities })));
  for (const r of group) for (const x of r.samples) test.update(x - 1);
  const decision = test.snapshot();
  const winner = models.indexOf(decision.winner);
  const status = ![...acceptAll.values()].some(Boolean) ? 'UNKNOWN_MODEL'
    : decision.accepted && acceptAll.get(winner) ? 'IDENTIFIED' : 'INCONCLUSIVE';
  return { acceptAll, status, winner };
}

const blank = () => ({ n: 0, cover: 0, correctSingle: 0, wrongSingle: 0, multi: 0, empty: 0, size: 0, pairN: 0, pairCorrect: 0, pairSlice: {}, wrongByModel: {} });
function tallySet(o, set, t) {
  o.n++; o.size += set.length;
  if (set.includes(t)) o.cover++;
  if (set.length === 1) {
    if (set[0] === t) o.correctSingle++;
    else { o.wrongSingle++; const key = `${models[t]} → ${models[set[0]]}`; o.wrongByModel[key] = (o.wrongByModel[key] ?? 0) + 1; }
  } else if (set.length === 0) o.empty++;
  else o.multi++;
  if (PAIR.includes(models[t])) {
    o.pairN++; if (set.length === 1 && set[0] === t) o.pairCorrect++;
    const key = `${models[t]} → ${label(set)}`; o.pairSlice[key] = (o.pairSlice[key] ?? 0) + 1;
  }
}

function evaluate(k, mode) {
  const rand = mulberry32(12345 + k);
  const out = {};
  for (const name of Object.keys(VARIANTS)) { out[`${name}; ungated`] = blank(); out[`${name}; gated`] = blank(); }
  const engine = blank();
  for (let t = 0; t < M; t++) {
    for (const group of groupsOf(t, k)) {
      const X = mode === 'inbank' ? tableFor(group) : BASE;
      const labels = models.map((_, m) => m).filter((m) => mode === 'inbank' || m !== t);
      const held = new Set(group.map((r) => r.id));
      const cal = Object.fromEntries(labels.map((m) => [m, byModel[m].filter((r) => !held.has(r.id))]));
      const view = engineView(group, mode);
      for (const [name, variant] of Object.entries(VARIANTS)) {
        const set = predictSet(X, group, labels, cal, variant, rand);
        tallySet(out[`${name}; ungated`], set, t);
        tallySet(out[`${name}; gated`], set.filter((m) => view.acceptAll.get(m)), t);
      }
      // The current engine reports one model or none; map it onto the same table.
      tallySet(engine, view.status === 'IDENTIFIED' ? [view.winner] : [], t);
    }
  }
  out['Current engine, pooled SPRT + all-k OOD gate'] = engine;
  return out;
}

const pct = (x, n) => `${x}/${n}`;
const sorted = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
function printSets(title, results, lomo) {
  console.log(`\n### ${title}`);
  console.log('| Method | True model in set | Correct singleton | Wrong singleton | Set of 2+ | Empty | Mean set size |');
  console.log('|---|---|---|---|---|---|---|');
  for (const [name, o] of Object.entries(results)) console.log(`| ${name} | ${pct(o.cover, o.n)} | ${pct(o.correctSingle, o.n)} | ${pct(o.wrongSingle, o.n)} | ${pct(o.multi, o.n)} | ${pct(o.empty, o.n)} | ${(o.size / o.n).toFixed(2)} |`);
  for (const [name, o] of Object.entries(results)) {
    console.log(`  ${name} pair slice:`, sorted(o.pairSlice));
    if (lomo) console.log(`  ${name} wrong singletons by removed model:`, sorted(o.wrongByModel));
  }
}

const started = Date.now();
const summary = [];
for (const k of KS) {
  const inbank = evaluate(k, 'inbank');
  const lomo = evaluate(k, 'lomo');
  printSets(`Enrolled, held-out units of k=${k} request(s) (alpha=${ALPHA})`, inbank, false);
  printSets(`Unenrolled model (label removed), units of k=${k} (want: empty set)`, lomo, true);
  for (const name of Object.keys(inbank)) {
    const a = inbank[name], b = lomo[name];
    summary.push({
      k, method: name,
      enrolledWrong: `${pct(a.wrongSingle, a.n)} (${(100 * a.wrongSingle / a.n).toFixed(1)}%)`, enrolledWrongOK: a.wrongSingle / a.n < 0.01,
      unenrolledWrong: `${pct(b.wrongSingle, b.n)} (${(100 * b.wrongSingle / b.n).toFixed(1)}%)`, unenrolledWrongOK: b.wrongSingle / b.n <= 0.10,
      pairCorrect: `${pct(a.pairCorrect, a.pairN)}`, pairOK: a.pairCorrect / a.pairN >= 0.5,
      correctSingle: pct(a.correctSingle, a.n), coverage: pct(a.cover, a.n),
    });
  }
}
console.log('\n### Predeclared criteria: enrolled wrong < 1%, unenrolled wrong <= 10%, pair correct >= 50%');
console.log('| k | Method | Enrolled wrong | Unenrolled wrong | Pair correct | All met | Correct singleton | Coverage |');
console.log('|---|---|---|---|---|---|---|---|');
for (const s of summary) console.log(`| ${s.k} | ${s.method} | ${s.enrolledWrong}${s.enrolledWrongOK ? '' : ' ✗'} | ${s.unenrolledWrong}${s.unenrolledWrongOK ? '' : ' ✗'} | ${s.pairCorrect}${s.pairOK ? '' : ' ✗'} | ${s.enrolledWrongOK && s.unenrolledWrongOK && s.pairOK ? 'yes' : 'no'} | ${s.correctSingle} | ${s.coverage} |`);
console.log(`\nelapsed ${((Date.now() - started) / 1000).toFixed(1)} s`);
