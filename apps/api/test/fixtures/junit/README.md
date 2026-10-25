# JUnit / events fixtures (QA-1)

Real output of Node's built-in `junit` reporter and of `scripts/report-events.js`,
captured on Node **v20.20.2** and **v24.11.1** from small probe test files, used by
`test/report-tests.test.js` to pin `scripts/report-tests.js`'s strict parser to what Node
actually emits.

- **Sanitized:** machine paths were rewritten to `C:\ci\electrical-platform\apps\api\test\probe\…`
  and the hostname to `fixture-host`. Nothing else was edited.
- **Secret-looking strings are intentional dummies.** `node20-combined.*` and
  `node24-combined.*` contain a fake bearer JWT (`eyJhbGciOiJIUzI1NiJ9.…`) and a fake
  `postgresql://svc:S3cret@10.0.0.5/prod` URL. They are not real credentials; they exist so
  the tests can prove the report scrubs them before writing anything.
- `malformed-*.xml` are derived from `node20-pass.xml` (truncated, an unknown element, the
  summary comments removed) to prove the parser throws instead of guessing.
- `node24-suite-throws.*` (v24.11.1) is a describe() whose body throws while its tests are
  collected, next to a passing suite. Node exits 0 and counts `fail 0`; the XML itemises the
  suite as a failed `<testcase>`. It pins BUG-0029.

To regenerate: run the probe files with `node --test --test-reporter=junit
--test-reporter-destination=<file> --test-reporter=./scripts/report-events.js
--test-reporter-destination=<events>`, on both Node versions, then sanitize the same way.
