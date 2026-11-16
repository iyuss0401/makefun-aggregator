# free-model-aggregator-02

An OpenAI- and Anthropic-compatible aggregator for the free OpenRouter models, built for the
make.fun bounty `free-model-aggregator-02`.

One Node 22 server (standard library only, TypeScript run directly with `node main.ts`) that:

- answers `POST /v1/chat/completions` as an OpenAI-compatible service and `POST /v1/messages` as an
  Anthropic-compatible one, in JSON and in server-sent events, translating the Anthropic wire to the
  gateway's Chat Completions route and back;
- answers `GET /v1/models` in the wire its auth header names (`Authorization` → OpenAI list shape,
  `x-api-key` → Anthropic list shape), always the brief's exact free-model set;
- registers its port and catalog with the trial env at `POST $MAKEFUN_ENV_URL/register`, polls
  `GET $MAKEFUN_ENV_URL/work` every 100 ms and exits 0 when it says `done`;
- prints its catalog with `node main.ts --list`, byte for byte as it registers it.

## Competitive features

- **Rating-based routing (quality):** every free model that meets a request's requirements (tools,
  vision, JSON mode, context) is ranked by the brief's `rating_milli`, best first, ties broken by id,
  so the strongest capable model serves each prompt.
- **Failover:** a refused gateway call (4xx/5xx, network error) is retried on the next candidate while
  any remains; the refusals ride back in the optional `x-makefun-upstream-failures` response header
  (≤ 8 rows of `{"status", "code", "model"}`), and a model that eventually served keeps the answer.
- **Per-model cooldowns:** consecutive refusals are counted per model; a model that refused twice in a
  row is skipped while any fresh candidate remains, so one rate-limited model cannot take every later
  prompt down with it.
- **Truthful model field:** the `model` on every answer and every streamed chunk is the id that was
  really dialled (the provider drops the `openrouter/` prefix; this server puts it back).
- **Output caps:** a body with no `max_tokens` (or one over the gateway's ceiling) is dialled with a
  safe 4096-token cap, so the gateway never refuses a call for the missing cap.
- **Determinism:** no wall clock and no unseeded randomness anywhere in what is sent or answered, so a
  replayed trial reproduces the live pass's state export byte for byte.

## Run

```sh
node main.ts --list   # print the catalog and exit
node main.ts          # in a trial: read $MAKEFUN_PROMPT_FILE, register with $MAKEFUN_ENV_URL, serve
```

Environment: `MAKEFUN_ENV_URL`, `MAKEFUN_PROMPT_FILE`, `OPENAI_BASE_URL` (the grader's gateway),
`OPENAI_API_KEY` (the trial's dummy key). Without a trial the server needs `--list` only; an
`OPENROUTER_API_KEY` is never read here — the gateway holds the real key, never the sandbox.

## Layout

- `main.ts` — the server: routes, routing, failover, cooldowns, register, work poll.
- `lib/providers.ts` — the brief's parser (models + prompts documents), capabilities, catalog.
- `lib/wire.ts` — Anthropic ⇄ Chat Completions translation, model lists, SSE event writers.

## License

MIT — see [LICENSE](LICENSE).
