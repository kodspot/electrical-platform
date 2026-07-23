# Local git hooks (opt-in)

This directory holds a `pre-push` hook that runs `npm run lint` and `npm test` in `apps/api` before allowing a push — an interim local quality gate ahead of Work Package 4's CI pipeline (Engineering Charter §14).

**This is not active by default.** Setting `core.hooksPath` is a repository-wide git configuration change, so it's left as a deliberate, one-time opt-in rather than something applied automatically:

```
git config core.hooksPath .githooks
```

To go back to git's default hook location:

```
git config --unset core.hooksPath
```

On Windows, the hook runs via the `sh` that ships with Git for Windows (Git Bash) — no additional setup required.
