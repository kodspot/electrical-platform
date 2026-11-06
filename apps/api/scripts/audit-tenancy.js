'use strict';

// Every prisma call in routes and services whose where clause has no orgId. Prints file:line and the call head.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'src');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
const OPS = 'findUnique|findFirst|findMany|update|updateMany|delete|deleteMany|count|aggregate|groupBy|upsert';
const NON_TENANT = /^(organization|superAdmin|moduleCatalog|systemConfig|qa\w*|schedulerLock)$/i;
let total = 0;
for (const f of walk(root)) {
  const src = fs.readFileSync(f, 'utf8');
  const re = new RegExp(`(?:prisma|tx|db)\\.(\\w+)\\.(${OPS})\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    // the argument, by bracket matching
    let i = re.lastIndex, depth = 1;
    while (i < src.length && depth) { const c = src[i++]; if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--; }
    const arg = src.slice(re.lastIndex, i);
    if (/orgId/.test(arg)) continue;
    if (NON_TENANT.test(m[1])) continue;
    const line = src.slice(0, m.index).split('\n').length;
    total++;
    console.log(`${path.relative(root, f).replace(/\\/g, '/')}:${line} ${m[1]}.${m[2]} ${arg.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
}
console.log('total', total);
