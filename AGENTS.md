# AGENTS.md

Guidance for coding agents working in this repository. User-facing docs live in
[README.md](README.md).

## What this is

A small library (`cloudflare-workers-sse`) that turns an async generator into a
Server-Sent Events response on Cloudflare Workers. All runtime code is in
`src/sse.ts`; `src/index.ts` only re-exports it.

## Commands

| Task | Command |
| --- | --- |
| Run tests once | `npm test` |
| Watch tests | `npm run dev` |
| Lint and format check | `npm run check` |
| Auto-fix formatting | `npm run format` |
| Type-check | `npx tsc --noEmit -p .` |
| Build to `dist/` | `npm run build` |

CI (`.github/workflows/ci.yml`) runs `check`, `test`, and `build` on Node 22.
The lefthook pre-commit hook runs `format` and `test`.

## Layout

- `src/sse.ts`: the `sse()` wrapper, message serialization, and the stream
  lifecycle (`writeMessages`).
- `test/sse.spec.ts`: Vitest tests that run inside workerd through
  `@cloudflare/vitest-plugin`.
- `wrangler.test.toml`: test runtime config. It enables `enable_request_signal`
  so `request.signal` aborts on client disconnect.

## Conventions

- Biome formats the code: 2-space indent, double quotes, no trailing commas,
  80-column lines.
- Tests use `createExecutionContext()` and `waitOnExecutionContext()` from
  `cloudflare:test`.
- Keep the public API in `src/sse.ts` documented with JSDoc, and keep the
  README tables (Messages, Options, API) in sync with it.

## Invariants to preserve

These behaviours are deliberate, and each has tests. Don't change them without
updating the tests and the README.

- **Never await `generator.return()` while a `next()` is pending.** On an async
  generator, `return()` queues behind the pending `next()`, so awaiting it can
  hang the stream. Use `requestStop()`, which starts `return()` without awaiting
  it.
- **Disconnects are classified by hard signals only:** the stream signal being
  aborted, or a `StreamWriteError` thrown by `writeSerialized`. Never classify
  by error name or message. An `AbortError` thrown by user code must still
  reach `onError`.
- **Every disconnect path aborts the handler `signal`:** request abort, a failed
  write, and a failed heartbeat.
- **No per-iteration subscriptions to long-lived promises.** `Promise.race`
  against a promise that never settles retains a handler per message. The loop
  uses a single `wakeOnAbort` callback instead.
- **Always close the generator after an error** so its `finally` blocks release
  upstream resources.
- **Serialization must reject field injection.** Split `data` and `comment` on
  CR, LF, and CRLF, and throw if `id` or `event` contains CR or LF (or NUL in
  `id`).
- `onError` is never called on disconnect, and never recursively.

## Before finishing a change

1. `npm run check`
2. `npx tsc --noEmit -p .`
3. `npm test`
4. Update `README.md` if behaviour or the public API changed.
5. Bump `version` in `package.json` (and `package-lock.json`, e.g. with
   `npm version <x.y.z> --no-git-tag-version`) for user-visible changes.
