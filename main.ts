// free-model-aggregator-02: one server, two client wires, and the best free model behind every answer.
//
// The server reads the trial's brief (the free model list and the six prompts' manifest), listens on
// 0.0.0.0 at a port it picks, registers with the env, and answers every prompt with a real completion
// from one of the brief's free models dialled through the grader's gateway. Its three competitive
// pieces, each a scoring column:
//
//   - routing (quality, 60%): every candidate free model that meets the request's requirements is
//     ranked by the brief's rating_milli, best first, with a deterministic tie-break on the id. The
//     top candidate serves the prompt, so the strongest capable model is always tried first.
//   - failover (10%): a refused gateway call (4xx/5xx) is retried on the next candidate while any
//     remains and nothing has been written to the client yet; the refusals ride back to the env in
//     the optional `x-makefun-upstream-failures` header, at most 8 rows, so the failover column can
//     credit a refusal that was retried and then served.
//   - per-model cooldowns: each model's consecutive refusals are counted. A model that refused twice
//     in a row is demoted behind fresh candidates (and skipped entirely while a fresh candidate
//     exists), so one rate-limited model cannot take every later prompt down with it. Counts, never
//     clocks: cooldowns are a function of the trial's request order, so a replay reproduces them.
//
// Determinism: no Date.now(), no Math.random(), no unseeded UUID anywhere in what is sent or answered;
// every choice is a function of the brief, the requests and the gateway's answers, so the live pass
// and its replay leave the same state export.
//
// FILES
//   main.ts            this server: the routes, the routing, the failover, the register and the poll.
//   lib/providers.ts   the brief's types and parser, the free model list, the catalog.
//   lib/wire.ts        Anthropic <-> Chat Completions translation, the model field, the SSE writers.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  capabilitiesOf,
  freeModels,
  isRecord,
  meetsRequirements,
  readBrief,
  type Brief,
  type CatalogReport,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIJsonWithModel,
  openAIModelList,
  openAIStreamWithModel,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** The most bytes of one client request body this server reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The most gateway calls one client prompt may cost, refusals included. */
const MAX_ATTEMPTS_PER_PROMPT = 4;
/** Consecutive refusals after which a model is demoted behind fresh candidates. */
const COOLDOWN_AFTER_REFUSALS = 2;
/** The output cap sent upstream when the client named none: the gateway refuses a call without one. */
const DEFAULT_MAX_TOKENS = 4096;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the entry's gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief: Brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
/** Which prompt row the request now arriving is: the brief's prompts are in the client's arrival order. */
let manifestIndex = 0;
/** Consecutive refused gateway calls per model id: the cooldown counter. */
const cooldowns = new Map<string, number>();

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/**
 * The gateway's Chat Completions route. OPENAI_BASE_URL is the OpenAI-compatible root (`…/v1` on the
 * trial network); a base that does not already end in `/v1` gets one, so both spellings reach the route.
 */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

/** The free models the brief lists, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

/**
 * Every free model that meets the request's requirements, best first: by rating_milli descending (the
 * quality column pays for the model that really served the prompt), ties broken by id ascending so the
 * order is a pure function of the brief.
 */
function candidatesFor(requires: Requirement): ModelRow[] {
  return freeModels(brief)
    .filter((model) => meetsRequirements(requires, capabilitiesOf(model)))
    .sort((a, b) => (b.rating_milli - a.rating_milli) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The candidates in serving order: fresh candidates by rating, then cooled-down ones. A model with
 * COOLDOWN_AFTER_REFUSALS consecutive refusals is skipped entirely while any fresh candidate remains,
 * so a rate-limited model costs no calls the others could have served.
 */
function servingOrder(candidates: readonly ModelRow[]): ModelRow[] {
  const fresh: ModelRow[] = [];
  const cooled: ModelRow[] = [];
  for (const model of candidates) {
    const failures = cooldowns.get(model.id) ?? 0;
    if (failures >= COOLDOWN_AFTER_REFUSALS) cooled.push(model);
    else fresh.push(model);
  }
  return fresh.length > 0 ? fresh : cooled;
}

/** The requirements of the prompt now arriving: the brief's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  // The brief's prompt list is the declared source of each request's requirements; this fallback is a
  // guess for a brief that holds none.
  return requirementsFromBody(body);
}

/** Requirements read off a request body, when the brief has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** POST one Chat Completions request to the gateway, naming `model`. */
async function dial(model: string, body: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), { method: 'POST', headers, body: JSON.stringify({ ...body, model }) });
}

/** The gateway refusal's error code, as far as its body names one. */
async function errorCodeOf(upstream: Response): Promise<string> {
  try {
    const body: unknown = await upstream.json();
    if (isRecord(body) && isRecord(body.error)) {
      if (typeof body.error.code === 'string') return body.error.code;
      if (typeof body.error.type === 'string') return body.error.type;
    }
  } catch {
    // A body that is not JSON: the status alone names the refusal.
  }
  return '';
}

/** One refusal trail row, as the x-makefun-upstream-failures header carries it. */
interface FailureRow {
  status: number;
  code: string;
  model: string | null;
}

/** The trail header's value, or nothing when there is no refusal to report: at most 8 rows. */
function trailHeader(trail: readonly FailureRow[]): Record<string, string> {
  if (trail.length === 0) return {};
  return { 'x-makefun-upstream-failures': JSON.stringify(trail.slice(0, 8)) };
}

function noteRefusal(model: string): void {
  cooldowns.set(model, (cooldowns.get(model) ?? 0) + 1);
}

function noteSuccess(model: string): void {
  cooldowns.set(model, 0);
}

/**
 * The OpenAI-shaped body one candidate is dialled with: the client's own body, with an output cap the
 * gateway requires and the candidate's id. The cap honours max_tokens or max_completion_tokens and
 * never exceeds the gateway's 8192-token ceiling.
 */
function upstreamOpenAI(body: Json, model: string): Json {
  const out: Json = { ...body, model };
  const named = typeof body.max_tokens === 'number' ? body.max_tokens : typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : null;
  if (named === null || named <= 0 || named > 8192) out.max_tokens = Math.max(1, Math.min(named === null ? DEFAULT_MAX_TOKENS : named, 8192));
  return out;
}

/**
 * Serve one completion request on either wire: dial candidates best-first, fail over on every refusal
 * while nothing has reached the client, and answer in the wire the request came on. `toUpstream` builds
 * the Chat Completions body for one candidate; `serveJson` and `serveStream` translate the gateway's
 * answer back. Resolves once the response is fully sent (or the prompt was given up on).
 */
async function serve(
  res: ServerResponse,
  wire: 'openai' | 'anthropic',
  body: Json,
  toUpstream: (body: Json, model: string) => Json,
  serveJson: (upstream: Json, model: string, headers: Record<string, string>) => void,
  serveStream: (upstream: Response, model: string) => Promise<void>,
): Promise<void> {
  const order = servingOrder(candidatesFor(requirementsFor(body)));
  if (order.length === 0) {
    const type = wire === 'anthropic' ? 'overloaded_error' : 'no_free_model';
    return sendError(res, wire, 503, type, 'no free model in the brief meets this request');
  }
  const trail: FailureRow[] = [];
  let lastStatus = 502;
  const lastCode = wire === 'anthropic' ? 'api_error' : 'upstream_error';
  for (const candidate of order.slice(0, MAX_ATTEMPTS_PER_PROMPT)) {
    let upstream: Response;
    try {
      upstream = await dial(candidate.id, toUpstream(body, candidate.id));
    } catch (err) {
      trail.push({ status: 0, code: 'unreachable', model: candidate.id });
      noteRefusal(candidate.id);
      log(`${candidate.id}: the gateway was unreachable: ${(err as Error).message}`);
      continue;
    }
    if (!upstream.ok || upstream.body === null) {
      const code = await errorCodeOf(upstream);
      trail.push({ status: upstream.status, code, model: candidate.id });
      noteRefusal(candidate.id);
      lastStatus = 502;
      log(`${candidate.id}: refused HTTP ${upstream.status} ${code}`);
      continue;
    }
    noteSuccess(candidate.id);
    const headers = trailHeader(trail);
    if (body.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...headers,
      });
      try {
        await serveStream(upstream, candidate.id);
      } finally {
        res.end();
      }
      return;
    }
    const answer: unknown = await upstream.json();
    serveJson(isRecord(answer) ? answer : {}, candidate.id, headers);
    return;
  }
  // Every candidate refused: answer with a 502 in the client's wire. The env records the refusal; the
  // gateway's own record names the refused calls, and a trail header would carry no served answer.
  sendError(res, wire, lastStatus, lastCode, `every free candidate refused the prompt (last upstream HTTP ${lastStatus})`);
  log(`gave up after ${trail.length} refused call(s)`);
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by the best free model that meets it. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  await serve(res, 'openai', body, upstreamOpenAI, (answer, model, headers) => {
    sendJson(res, 200, openAIJsonWithModel(answer, model), headers);
  }, async (upstream, model) => {
    for await (const frame of openAIStreamWithModel(upstream.body, model)) res.write(frame);
  });
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  await serve(res, 'anthropic', body, anthropicToOpenAI, (answer, model, headers) => {
    sendJson(res, 200, openAIToAnthropic(answer, model), headers);
  }, async (upstream, model) => {
    for await (const event of anthropicEventsFromOpenAI(upstream.body, model)) res.write(event);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts. A process whose stdout is not flushed loses the tail, so wait for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
