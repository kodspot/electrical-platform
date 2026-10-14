# Local git hooks (opt-in)

This directory holds a `pre-push` hook. It runs **`npm run ci` in `apps/api`** before allowing a push, which is the same gate the CI "Lint & Test" job runs: lint, the full test suite, and the repository/package/migration/generated-doc checks (`scripts/ci-validate.js`). A push that would fail CI fails locally first.

**This is not active by default.** Setting `core.hooksPath` is a repository-wide git configuration change, so it's left as a deliberate, one-time opt-in rather than something applied automatically:

```
git config core.hooksPath .githooks
```

To go back to git's default hook location:

```
git config --unset core.hooksPath
```

## Notes

- **Database-backed tests** need a disposable loopback database whose name ends in `_ci`, `_test` or `_e2e`, set in `DATABASE_URL` (see `apps/api/test/README.md`). Without one they are reported as skipped. CI always has a database, and runs strictly.
- **Skipping the hook once:** `git push --no-verify`. CI still runs the same gate on the pull request.
- **On Windows**, the hook runs via the `sh` that ships with Git for Windows (Git Bash). No additional setup is required.
