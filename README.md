# Topogram Generator: postgres

Package-backed Topogram generator for Postgres database lifecycle bundles.

## Manifest

- Generator id: `@attebury/topogram-generator-postgres-db`
- Surface: `database`
- Projection platform: `db_postgres`
- Package manifest: `topogram-generator.json`
- Adapter export: `index.cjs`

## Verify Locally

```bash
npm run check
```

See [`CONSUMER_PROOF.md`](./CONSUMER_PROOF.md) for the verification standard
this repo must keep before publishing.

The smoke test packs this generator, installs it beside `@attebury/topogram` in
a temporary consumer project, runs `topogram check`, runs `topogram generate`,
compiles the generated app bundle, and verifies expected generated files.
