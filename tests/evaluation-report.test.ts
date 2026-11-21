import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateClaimRates } from '../src/data/claim_rates.js';
import { renderEvaluationReport, sha256, type EvaluationReport } from '../src/data/evaluation.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const json = read('docs/evaluation.json');
const report = JSON.parse(json) as EvaluationReport;
const claimText = read('src/data/claim_rates.json');
const claims = validateClaimRates(JSON.parse(claimText));

// `npm run bank:evaluate` regenerates both files from the maintainer corpora; see docs/bank-maintenance.md.
describe('committed evaluation report', () => {
  it('was generated from the bundled banks', () => {
    expect(report.banks.default).toMatchObject({ file: 'src/data/default_bank.json', sha256: sha256(read('src/data/default_bank.json')) });
    expect(report.banks.pooled).toMatchObject({ file: 'src/data/pooled_bank.json', sha256: sha256(read('src/data/pooled_bank.json')) });
  });

  it('renders to the committed markdown', () => {
    expect(read('docs/evaluation.md')).toBe(renderEvaluationReport(report, claims));
  });

  it('records no local paths', () => {
    for (const text of [json, claimText]) expect(text).not.toMatch(/\/Users\/|\/home\/|\/private\/|[A-Za-z]:\\\\/);
  });

  it('measured claim rates for every calibrated model of the bundled bank, from reported corpora', () => {
    const bankText = read('src/data/default_bank.json');
    expect(claims.bank).toEqual({ file: 'src/data/default_bank.json', sha256: sha256(bankText) });
    const bank = JSON.parse(bankText) as { models: { id: string; status: string }[] };
    expect(Object.keys(claims.claims)).toEqual(bank.models.filter((model) => model.status === 'calibrated').map((model) => model.id));
    const reported = new Set(report.corpora.map((corpus) => corpus.sha256));
    expect(claims.corpora.length).toBeGreaterThan(0);
    for (const digest of claims.corpora) expect(reported.has(digest)).toBe(true);
  });
});
