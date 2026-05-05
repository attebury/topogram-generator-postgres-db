# Consumer Proof

This repo publishes a package-backed Topogram generator. Its release proof must
cross the same boundary a consumer crosses.

## Required Gate

```bash
npm run check
```

The check must:

- run `topogram generator check` through the installed Topogram CLI pinned in
  `topogram-cli.version`;
- pack this generator package;
- install the packed generator beside `@topogram/cli` in a clean consumer
  project;
- run `topogram check`;
- run `topogram generate`;
- run `npm --prefix app run compile` after generation;
- treat file and string assertions as diagnostics only, after compile proves
  the generated output is usable.

## Not Acceptable

- Hard-coded stale `@topogram/cli@x.y.z` literals in verification or
  publish workflows.
- Fake npm package installs in consumer-facing verification.
- Generate-only smoke tests.
- File-existence or string checks as a substitute for generated compile proof.
- Importing local engine internals instead of using the installed CLI package.
