'use strict';

// Server text concatenated into HTML strings without esc(): lines with `' + x.field + '` where field is free text.
const fs = require('fs');
const P = require('path').join(__dirname, '..', 'public') + '/';
const FREE = /^(name|title|description|note|notes|label|message|error|remarks|reason|body|category|code|assetCode|employeeId|email|phone|summary|cause|resolution|details|text|orgName|parentName|flagReason|resolvedNote|locationName|designation|department|manufacturer|model|serialNumber|guestName|guestPhone)$/;
const files = fs.readdirSync(P).filter((f) => f.endsWith('.html')).concat(fs.readdirSync(P + 'js').filter((f) => f.endsWith('.js')).map((f) => 'js/' + f));
let n = 0;
for (const f of files) {
  fs.readFileSync(P + f, 'utf8').split(/\r?\n/).forEach((line, i) => {
    const re = /\+\s*((?:[A-Za-z_$][\w$]*\??\.)+[A-Za-z_$][\w$]*)\s*(?:\|\|[^+]*)?\+/g;
    let m;
    while ((m = re.exec(line))) {
      const field = m[1].split('.').pop();
      if (!FREE.test(field)) continue;
      const before = line.slice(0, m.index);
      if (/(?:esc|escHtml|escapeHtml|encodeURIComponent|escJs|App\.esc)\($/.test(before.trim())) continue;
      if (!/<|html|innerHTML/i.test(line)) continue;
      n++;
      console.log(`${f}:${i + 1} ${m[1]}  ::  ${line.trim().slice(Math.max(0, m.index - 30), m.index + 60)}`);
    }
  });
}
console.log('total', n);
