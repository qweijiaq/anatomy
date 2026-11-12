# scan-repo

Fixture repository for `tests/scan.test.ts`: a tiny project with one `package.json`,
one hand-written piece of infrastructure, a test file, and a vendored copy that the
analysis scope must exclude.

These files are test input, not test code: both `vitest` and `tsc` skip
`tests/fixtures/`.
