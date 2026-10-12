'use strict';

/**
 * Minimal node:test reporter (QA-1) that records what the built-in JUnit reporter drops:
 * on Node 20 its XML carries no file path, and on every version a failing before()/after()
 * hook surfaces only as "cancelledByParent" on the tests it cancelled — the hook's own
 * error is lost. scripts/report-tests.js joins these JSON lines onto the JUnit XML, which
 * remains the source of truth for counts.
 *
 * Emits one JSON object per line for every top-level (nesting 0) result, and for every
 * failure at any depth. Written to a temp file by scripts/run-tests.js; never committed.
 */

const MAX_CAUSE_CHARS = 2000;

function causeText(error) {
  if (!error) return null;
  const cause = error.cause;
  const text = cause && typeof cause === 'object' ? cause.message || String(cause) : cause || error.message;
  return text == null ? null : String(text).slice(0, MAX_CAUSE_CHARS);
}

module.exports = async function* reportEvents(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const data = event.data;
    const error = data.details && data.details.error;
    if (data.nesting !== 0 && event.type !== 'test:fail') continue;
    yield `${JSON.stringify({
      result: event.type === 'test:pass' ? 'pass' : 'fail',
      name: data.name,
      nesting: data.nesting,
      file: data.file || null,
      kind: (data.details && data.details.type) || null,
      failureType: (error && error.failureType) || null,
      cause: causeText(error)
    })}\n`;
  }
};
