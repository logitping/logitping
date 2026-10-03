/** Stable machine-readable failure categories; messages may change between versions. */
export type LogitpingErrorCode =
  /** The endpoint answered with a non-2xx status; see `status`. */
  | 'HTTP_STATUS'
  /** The endpoint could not be reached (DNS, connection, TLS) or answered with a refused redirect; see `cause`. */
  | 'NETWORK'
  /** Probe settings or transport do not match the bank's calibration protocol. */
  | 'PROTOCOL_MISMATCH'
  /** A bank, or the file holding it, is malformed or fails validation. */
  | 'INVALID_BANK'
  /** The model's integer output violated the probe format. */
  | 'MALFORMED_OUTPUT'
  /** The provider's response or stream was malformed, refused, or ended abnormally. */
  | 'PROVIDER_RESPONSE'
  /** The response stopped at the requested output-token limit. */
  | 'TRUNCATED'
  /** The local CLI executable is not installed or not on PATH. */
  | 'CLI_NOT_FOUND'
  /** The local CLI failed, reported an error, emitted malformed output, or attempted a tool action. */
  | 'CLI_FAILED';

export interface LogitpingErrorOptions {
  /** The HTTP status of an `HTTP_STATUS` failure. */
  status?: number;
  /** The underlying failure, kept for debugging; the CLI never prints it. */
  cause?: unknown;
}

export class LogitpingError extends Error {
  override name = 'LogitpingError';
  /** The HTTP status of an `HTTP_STATUS` failure. */
  readonly status: number | undefined;
  constructor(readonly code: LogitpingErrorCode, message: string, options: LogitpingErrorOptions = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.status = options.status;
  }
}
