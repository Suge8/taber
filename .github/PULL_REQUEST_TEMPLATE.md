## What changed

<!-- One paragraph, link to issue if there is one. -->

## Why

<!-- The motivation. If this touches tool boundary / permissions / privacy, say so explicitly. -->

## How verified

<!-- Which commands did you run? At minimum the parts of `pnpm run test:ci` your change touches. -->

- [ ] `pnpm run check`
- [ ] `pnpm run test:unit`
- [ ] `pnpm run test:e2e`
- [ ] `pnpm run test:database-integration`
- [ ] `pnpm build:chrome && node scripts/verify-build.mjs .output/chrome-mv3` (if permissions or manifest changed)

## Scope check

- [ ] No new runtime dependency, or justification added below.
- [ ] No `any` added to silence a type error.
- [ ] Does not widen the tool boundary.
- [ ] No change to posted store-build permissions, or change documented in `docs/store-compliance.md`.
- [ ] No raw chain-of-thought or reasoning exposed in the UI.

## Notes

<!-- New dependency justification, screenshots, migration notes, anything reviewers need. -->
