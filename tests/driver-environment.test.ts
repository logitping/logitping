import { describe, expect, it } from 'vitest';
import { checkPassEnv, driverEnvironment } from '../src/drivers/environment.js';

describe('driver environment', () => {
  it('keeps shared variables in any letter case', () => {
    // Windows names are case-insensitive, and include one with parentheses.
    const source = { PATH: '/usr/bin', HOME: '/home/u', http_proxy: 'http://proxy:8080', SystemRoot: 'C:\\Windows', 'ProgramFiles(x86)': 'C:\\PF86' };
    expect(driverEnvironment(source, [])).toEqual(source);
  });

  it("keeps the driver's prefixes and drops everything else", () => {
    const source = {
      PATH: '/bin', CODEX_HOME: '/c', OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: 'sk-a', AWS_SECRET_ACCESS_KEY: 'aws',
      GITHUB_TOKEN: 'gh', SSH_AUTH_SOCK: '/tmp/agent', NODE_OPTIONS: '--require x', CLAUDECODE: '1',
    };
    expect(driverEnvironment(source, ['CODEX_', 'OPENAI_'])).toEqual({ PATH: '/bin', CODEX_HOME: '/c', OPENAI_API_KEY: 'sk-o' });
  });

  it('never passes LOGITPING_API_KEY', () => {
    const source = { LOGITPING_API_KEY: 'k', logitping_api_key: 'k', LOGITPING_TEST: 'x' };
    expect(driverEnvironment(source, ['LOGITPING_'], ['LOGITPING_*'])).toEqual({ LOGITPING_TEST: 'x' });
  });

  it('adds passEnv names and prefixes, case-insensitively', () => {
    const source = { AWS_REGION: 'us-east-1', aws_profile: 'dev', CLOUD_ML_REGION: 'us-east5', OTHER: 'no' };
    expect(driverEnvironment(source, [], ['aws_*', 'cloud_ml_region'])).toEqual({ AWS_REGION: 'us-east-1', aws_profile: 'dev', CLOUD_ML_REGION: 'us-east5' });
  });

  it('keeps the DO_NOT_TRACK opt-out for every driver', () => {
    expect(driverEnvironment({ DO_NOT_TRACK: '1' }, [])).toEqual({ DO_NOT_TRACK: '1' });
  });

  it('drops variables without a value, keeping empty strings', () => {
    expect(driverEnvironment({ PATH: undefined, HOME: '/h', NO_PROXY: '' }, [])).toEqual({ HOME: '/h', NO_PROXY: '' });
  });

  it('accepts names and prefixes', () => {
    expect(() => checkPassEnv(['AWS_*', 'FOO', '_X'])).not.toThrow();
  });

  it('rejects malformed passEnv entries', () => {
    for (const patterns of [['*'], ['AWS*X'], ['bad-name'], [''], [7], 'AWS_*']) {
      expect(() => checkPassEnv(patterns)).toThrow(TypeError);
      expect(() => checkPassEnv(patterns)).toThrow(/variable names or prefixes ending in \*/);
    }
  });

  it('refuses to pass the API-mode key', () => {
    expect(() => checkPassEnv(['logitping_api_key'])).toThrow(/never passed to a CLI/);
  });
});
