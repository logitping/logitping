import { LogitpingError } from '../core/errors.js';
import { INTEGER_MAX, INTEGER_MIN } from '../math/ordered_block.js';

const RANGE = `[${INTEGER_MIN}, ${INTEGER_MAX}]`;
const MAX_DIGITS = String(INTEGER_MAX).length;

/** A protocol violation, with safe diagnostics that never include arbitrary output. */
export class IntegerOutputError extends LogitpingError {
  override name = 'IntegerOutputError';
  constructor(readonly position: number, detail: string) {
    super('MALFORMED_OUTPUT', `Invalid integer output at position ${position}: ${detail}`);
  }
}

/** Strict incremental parser: a split "35" + "5 " is one value, never two. */
export class IntegerStreamParser {
  private pending = '';
  private ended = false;
  private parsed = 0;

  *push(chunk: string): Generator<number> {
    if (this.ended) throw new Error('Integer parser has already finished');
    for (const character of chunk) {
      if (/[\s,]/u.test(character)) {
        if (this.pending) yield this.consume();
      } else {
        this.pending += character;
        if (this.pending.length > 32) throw new IntegerOutputError(this.parsed + 1, 'token too long');
      }
    }
  }

  *finish(): Generator<number> {
    if (this.ended) return;
    this.ended = true;
    if (this.pending) yield this.consume();
  }

  private consume(): number {
    const token = this.pending;
    this.pending = '';
    // Reject malformed output instead of selectively sampling valid-looking substrings.
    if (!/^[1-9]\d*$/.test(token) || token.length > MAX_DIGITS) throw new IntegerOutputError(this.parsed + 1, `expected plain integers in ${RANGE}`);
    const value = Number(token);
    if (value < INTEGER_MIN || value > INTEGER_MAX) throw new IntegerOutputError(this.parsed + 1, `${value} is outside ${RANGE}`);
    this.parsed++;
    return value;
  }
}
