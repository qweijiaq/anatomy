# signals fixture

A tiny repository used by `tests/signals.test.ts`.

- `src/scheduler.ts` is the file that must rank first: a hand-written ring buffer
  scheduler with a comment that explains a tradeoff.
- `src/report.ts` is a thin wrapper with a documented workaround.
- `src/legacy.ts` carries evolution vocabulary only.
- `vendor/react-like.js` copies framework idioms into a vendored directory. It
  must score nothing on its own, and the scope excludes `vendor/` anyway.

This README is markdown, so it has no analysable language and produces no
candidate.
