# Running anatomy in CI

`ana` is a CLI with no daemon, so a CI job is a checkout, a build and one command.
The two useful shapes are below; neither is committed as a workflow because a
repository has to decide where its stored runs and key live.

## One-shot: analyse the repository on demand

```yaml
name: anatomy
on:
  workflow_dispatch:
  pull_request:
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: npm ci
      - run: npm run build
      - name: Analyse
        env:
          ANA_MODEL: ${{ vars.ANA_MODEL }}
          ANA_API_KEY: ${{ secrets.ANA_API_KEY }}
        run: node dist/cli.js analyze . --top 12
      - uses: actions/upload-artifact@v4
        with:
          name: anatomy-report
          path: .ana/runs/**/report.md
```

The report is the artifact; every claim in it cites `path:line` and can be checked
with `node dist/cli.js inspect path:start-end`.

## Compare two stored analyses

`ana diff <before> <after> --json` reads two run directories and prints the numbers
and the titles that appeared or disappeared. A job that keeps `.ana/runs` between
runs (a cache keyed by branch, or a committed baseline) can compare the current
analysis with the previous one:

```bash
before=$(node dist/cli.js runs --json | jq -r '.[0].runId')
node dist/cli.js analyze . --top 12
after=$(node dist/cli.js runs --json | jq -r '.[0].runId')
node dist/cli.js diff "$before" "$after" --json > anatomy-diff.json
```

`ana runs --json` is intentional: the ids are the interface, and a script should
not have to scrape a table. `diff` exits non-zero only when a run cannot be read;
a difference is data, not a failure — the caller decides what to do with it.
