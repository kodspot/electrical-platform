'use strict';

/**
 * `npm run demo` — apply the canonical demo dataset. [platform-M3, DPS §2/§5]
 *
 * The DPS defines `demo` as `seed demo`; this is a thin, non-duplicative alias so the
 * presentation-ready dataset has a memorable command for Storylane / onboarding.
 */

const { main } = require('./seed');

main('demo')
  .then(() => process.exit(0))
  .catch((e) => { console.error('\ndemo: failed:', e.message); process.exit(1); });
