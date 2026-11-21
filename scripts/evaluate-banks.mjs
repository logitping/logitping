// Score both bundled banks on every stored run they were not built from, without provider requests,
// and rewrite docs/evaluation.json and docs/evaluation.md. Needs the git-ignored maintainer corpora.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { evaluateBanks, renderEvaluationReport } from '../build/maintainer.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const CORPUS = /\.corpus-[0-9a-f]{64}\.json$/;
const BANKS = { default: 'src/data/default_bank.json', pooled: 'src/data/pooled_bank.json' };

async function readCorpora() {
  const corpora = [];
  for (const directory of ['.', 'src/data']) {
    for (const name of (await readdir(join(root, directory))).filter((entry) => CORPUS.test(entry)).sort()) {
      const text = await readFile(join(root, directory, name), 'utf8');
      try { corpora.push(JSON.parse(text)); } catch { throw new Error(`${name} is not valid JSON`); }
    }
  }
  return corpora;
}

const sum = (entries, field) => entries.flatMap((entry) => Object.values(entry.models)).reduce((total, tally) => total + (field === 'wrong'
  ? Object.values(tally.wrong).reduce((a, b) => a + b, 0) : tally[field]), 0);

try {
  const corpora = await readCorpora();
  const text = async (path) => ({ file: path, text: await readFile(join(root, path), 'utf8') });
  const report = await evaluateBanks({ default: await text(BANKS.default), pooled: await text(BANKS.pooled), corpora });
  await writeFile(join(root, 'docs/evaluation.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(root, 'docs/evaluation.md'), renderEvaluationReport(report));
  const { default: defaults, pooled } = report;
  const status = (entries) => `${sum(entries, 'inconclusive')} INCONCLUSIVE, ${sum(entries, 'unknown')} UNKNOWN_MODEL`;
  const sets = (entries) => `${sum(entries, 'several')} several, ${sum(entries, 'none')} none, ${sum(entries, 'stopped')} stopped`;
  console.log(`Read ${report.corpora.length} corpora.`);
  console.log(`Default bank, enrolled: ${sum(defaults.enrolled, 'runs')} runs, ${sum(defaults.enrolled, 'correct')} correct, ${sum(defaults.enrolled, 'wrong')} wrong, ${status(defaults.enrolled)}`);
  console.log(`Default bank, tested model removed: ${sum(defaults.labelRemoved, 'runs')} runs, ${sum(defaults.labelRemoved, 'wrong')} named, ${status(defaults.labelRemoved)}`);
  console.log(`Default bank, not enrolled: ${sum(defaults.neverEnrolled, 'runs')} runs, ${sum(defaults.neverEnrolled, 'wrong')} named, ${status(defaults.neverEnrolled)}`);
  console.log(`Pooled bank, enrolled: ${sum(pooled.enrolled, 'probes')} probes, ${sum(pooled.enrolled, 'correct')} correct, ${sum(pooled.enrolled, 'wrong')} wrong, ${sets(pooled.enrolled)}`);
  console.log(`Pooled bank, not enrolled: ${sum(pooled.neverEnrolled, 'probes')} probes, ${sum(pooled.neverEnrolled, 'wrong')} named, ${sets(pooled.neverEnrolled)}`);
  console.log('Wrote docs/evaluation.json and docs/evaluation.md.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Bank evaluation failed');
  process.exitCode = 1;
}
