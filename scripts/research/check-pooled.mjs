// Compare the production pooled scoring with the frozen prototype (see README.md):
// 1. bank distributions and pair scores against the prototype's arithmetic on the full corpus (limit 1e-9);
// 2. leave-group-out results at k = 8 against the gate test, C4 gated (45/65, 1/65, 9/65; ±2 units).
// Usage: npm run build && node scripts/research/check-pooled.mjs <research-64 corpus.json>
import { readFileSync } from 'node:fs';
import { createPooledBank, fingerprint } from '../../dist/index.js';

const corpus = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const K = 8;
const N = 355;
const SMOOTH = 0.5;
// Copied verbatim from prototype.mjs.
const FAMILIES = [
  ['value', N, (r) => r.map((x) => x - 1)],
  ['step', N, (r) => r.slice(1).map((x, i) => (x - r[i] + N) % N)],
  ['bin bigram', 400, (r) => r.slice(1).map((x, i) => Math.floor((r[i] - 1) / 17.75) * 20 + Math.floor((x - 1) / 17.75))],
  ['digit bigram', 100, (r) => r.slice(1).map((x, i) => (r[i] % 10) * 10 + (x % 10))],
  ['first use', N * 4, (r) => { const seen = new Set(), out = []; r.forEach((x, t) => { if (!seen.has(x)) { seen.add(x); out.push((x - 1) * 4 + Math.min(3, Math.floor(t / 89))); } }); return out; }],
  ['opening 8', N * 8, (r) => r.slice(0, 8).map((x, t) => t * N + x - 1)],
  ['repeat gap', 12, (r) => { const last = new Map(), out = []; r.forEach((x, t) => { const g = last.has(x) ? t - last.get(x) : -1; out.push(g < 0 ? 0 : Math.min(11, 1 + Math.floor(Math.log2(g)))); last.set(x, t); }); return out; }],
].map(([name, size, ev]) => ({ name, size, ev }));
const meanOf = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const runsOf = (model) => [...model.training, ...model.validation];
const ids = corpus.models.map((model) => model.id);
const enroll = (models) => createPooledBank({ source: 'equivalence check', protocol: corpus.protocol, checkpoints: corpus.checkpoints, requestsPerProbe: K, models });

// Part 1: arithmetic on the full corpus.
const bank = enroll(corpus.models);
const counted = corpus.models.map((model) => runsOf(model).map((run) => FAMILIES.map(({ ev }) => {
  const map = new Map(); let total = 0;
  for (const e of ev(run)) { map.set(e, (map.get(e) ?? 0) + 1); total++; }
  return { map, total };
})));
const totals = counted.map((runs) => FAMILIES.map(({ size }, f) => {
  const c = new Float64Array(size); let total = 0;
  for (const run of runs) { for (const [e, n] of run[f].map) c[e] += n; total += run[f].total; }
  return { c, total };
}));
let worst = 0;
const compare = (actual, expected) => { worst = Math.max(worst, Math.abs(actual - expected) / Math.max(1, Math.abs(expected))); };
totals.forEach((families, m) => families.forEach(({ c, total }, f) => c.forEach((count, e) =>
  compare(bank.pooled.models[m].families[f][e], (count + SMOOTH) / (total + SMOOTH * FAMILIES[f].size)))));
// The prototype's leave-own-run-out log-likelihoods (its BASE table).
const loglik = (run, a, m, f) => {
  const { c, total } = totals[m][f];
  const own = m === a ? run[f] : { map: new Map(), total: 0 };
  const logDenom = Math.log(total - own.total + SMOOTH * FAMILIES[f].size);
  let s = 0;
  for (const [e, k] of run[f].map) s += k * (Math.log(c[e] - (own.map.get(e) ?? 0) + SMOOTH) - logDenom);
  return s;
};
const X = counted.map((runs, a) => runs.map((run) => counted.map((_, m) => FAMILIES.map((__, f) => loglik(run, a, m, f)))));
// The prototype's pairStat over ratio rows.
function pairStat(xa, xb) {
  const w = xa[0].map((_, j) => {
    const ma = meanOf(xa.map((row) => row[j])), mb = meanOf(xb.map((row) => row[j]));
    const v = (xa.reduce((s, row) => s + (row[j] - ma) ** 2, 0) + xb.reduce((s, row) => s + (row[j] - mb) ** 2, 0)) / (xa.length + xb.length - 2);
    return v > 0 && ma > mb ? (ma - mb) / v : 0;
  });
  if (w.every((x) => x === 0)) w.fill(1);
  const D = (row) => row.reduce((s, x, j) => s + w[j] * x, 0);
  const da = xa.map(D), db = xb.map(D);
  const ma = meanOf(da), mb = meanOf(db);
  const V = (da.reduce((s, x) => s + (x - ma) ** 2, 0) + db.reduce((s, x) => s + (x - mb) ** 2, 0)) / (da.length + db.length - 2);
  const sd = Math.sqrt(Math.max(V, 1e-12));
  return (row) => (D(row) - (ma + mb) / 2) / sd;
}
for (const pair of bank.pooled.pairs) {
  const m = ids.indexOf(pair.model), o = ids.indexOf(pair.competitor);
  const rows = (a) => X[a].map((run) => run[m].map((value, f) => value - run[o][f]));
  const prototype = pairStat(rows(m), rows(o));
  for (const row of [...rows(m), ...rows(o)]) compare((row.reduce((s, x, f) => s + pair.weights[f] * x, 0) - pair.center) / pair.scale, prototype(row));
}
console.log(`Largest relative difference from the prototype: ${worst.toExponential(2)} (limit 1e-9)`);

// Part 2: leave-group-out at k = 8, grouped as the prototype harness groups runs.
async function probe(fitted, responses) {
  let index = 0;
  const transport = { name: 'openai', granularity: 'token', async *stream() { yield `${responses[index++].join(' ')} `; } };
  return fingerprint(transport, { bank: fitted, earlyStopping: false });
}
const tally = { correct: 0, wrong: 0, unenrolledWrong: 0, units: 0 };
for (const [t, model] of corpus.models.entries()) {
  const runs = runsOf(model);
  const groups = Math.round(runs.length / K);
  const unenrolled = enroll(corpus.models.filter((_, mi) => mi !== t));
  for (let g = 0; g < groups; g++) {
    const held = new Set(runs.map((_, i) => i).filter((i) => i % groups === g));
    const fitted = enroll(corpus.models.map((m, mi) => mi !== t ? m : {
      ...m,
      training: m.training.filter((_, i) => !held.has(i)),
      validation: m.validation.filter((_, i) => !held.has(i + m.training.length)),
    }));
    const responses = [...held].map((i) => runs[i]);
    const enrolled = await probe(fitted, responses);
    if (enrolled.candidates?.length === 1) enrolled.candidates[0] === model.id ? tally.correct++ : tally.wrong++;
    const outside = await probe(unenrolled, responses);
    if (outside.candidates?.length === 1) tally.unenrolledWrong++;
    tally.units++;
  }
}
const rows = [['Correct single model, enrolled', tally.correct, 45], ['Wrong single model, enrolled', tally.wrong, 1], ['Unenrolled model named', tally.unenrolledWrong, 9]];
for (const [label, value, target] of rows) console.log(`${label}: ${value}/${tally.units} (gate test ${target}/65) ${Math.abs(value - target) <= 2 ? 'ok' : 'OUT OF RANGE'}`);
if (worst > 1e-9 || tally.units !== 65 || rows.some(([, value, target]) => Math.abs(value - target) > 2)) process.exitCode = 1;
