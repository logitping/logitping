/**
 * Which of this process's environment variables a local CLI driver may receive. A tool the
 * backend under test starts before the driver stops the CLI can read every variable the CLI got,
 * so only what a CLI login needs is passed. This is defense in depth: such a tool can still read
 * the CLI's own credentials and any file the user's account can read.
 */

/** The API-mode probe key: a CLI never needs it. Only an explicit complete `env` can carry it. */
export const WITHHELD_VARIABLE = 'LOGITPING_API_KEY';

/** Variables every driver receives: system, locale, temporary directory, session, proxy and certificate, and Windows profile. */
export const SHARED_VARIABLES: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SYSTEMDRIVE', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'APPDATA',
  'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROCESSOR_ARCHITECTURE',
];

const SHARED = new Set(SHARED_VARIABLES);
/** A variable name, or a prefix of one ending in `*`. */
const PASS_ENV_ENTRY = /^[A-Za-z_][A-Za-z0-9_]*\*?$/;

/** Validate caller-supplied `passEnv` entries before any process starts. */
export function checkPassEnv(patterns: unknown): asserts patterns is readonly string[] {
  if (!Array.isArray(patterns) || !patterns.every((entry) => typeof entry === 'string' && PASS_ENV_ENTRY.test(entry))) {
    throw new TypeError('passEnv entries must be variable names or prefixes ending in *, such as AWS_*');
  }
  if (patterns.some((entry: string) => entry.toUpperCase() === WITHHELD_VARIABLE)) {
    throw new TypeError(`${WITHHELD_VARIABLE} is never passed to a CLI; supply a complete environment with env to pass it deliberately`);
  }
}

/**
 * The shared variables, names starting with one of the driver's `prefixes`, and `passEnv` names or
 * `NAME_*` prefixes, compared case-insensitively as on Windows; never `LOGITPING_API_KEY`.
 */
export function driverEnvironment(source: Readonly<Record<string, string | undefined>>, prefixes: readonly string[], passEnv: readonly string[] = []): Record<string, string> {
  const starts = [...prefixes, ...passEnv.filter((entry) => entry.endsWith('*')).map((entry) => entry.slice(0, -1))].map((prefix) => prefix.toUpperCase());
  const named = new Set(passEnv.filter((entry) => !entry.endsWith('*')).map((entry) => entry.toUpperCase()));
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    const upper = name.toUpperCase();
    if (value === undefined || upper === WITHHELD_VARIABLE) continue;
    if (SHARED.has(upper) || named.has(upper) || starts.some((prefix) => upper.startsWith(prefix))) environment[name] = value;
  }
  return environment;
}
