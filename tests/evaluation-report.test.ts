import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderEvaluationReport, sha256, type EvaluationReport } from '../src/data/evaluation.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const json = read('docs/evaluation.json');
const report = JSON.parse(json) as EvaluationReport;

// `npm run bank:evaluate` regenerates both files from the maintainer corpora; see docs/bank-maintenance.md.
describe('committed evaluation report', () => {
  it('was generated from the bundled banks', () => {
    expect(report.banks.default).toMatchObject({ file: 'src/data/default_bank.json', sha256: sha256(read('src/data/default_bank.json')) });
    expect(report.banks.pooled).toMatchObject({ file: 'src/data/pooled_bank.json', sha256: sha256(read('src/data/pooled_bank.json')) });
  });

  it('renders to the committed markdown', () => {
    expect(read('docs/evaluation.md')).toBe(renderEvaluationReport(report));
  });

  it('records no local paths', () => {
    expect(json).not.toMatch(/\/Users\/|\/home\/|\/private\/|[A-Za-z]:\\\\/);
  });
});
