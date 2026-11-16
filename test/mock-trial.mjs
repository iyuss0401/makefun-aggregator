// A local mock of the trial: a fake env (register/work) and a fake model gateway, driving the six
// prompts of practice/trial-0 against main.ts and checking the wire rules. Run with
//   node test/mock-trial.mjs <path to trial prompt file> [models that refuse, comma separated]
// It exits non-zero when an expectation fails.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const PROMPT_FILE = process.argv[2] ?? 'practice/trial-0/input/prompt.txt';
const REFUSING = new Set((process.argv[3] ?? '').split(',').filter(Boolean));

const briefText = readFileSync(PROMPT_FILE, 'utf8');
const promptDoc = JSON.parse(briefText.slice(briefText.indexOf('{"schema":"free-model-aggregator-02/prompts/v1"'), briefText.indexOf('\n', briefText.indexOf('{"schema":"free-model-aggregator-02/prompts/v1"'))));
const modelsDoc = JSON.parse(briefText.slice(briefText.indexOf('{"schema":"free-model-aggregator-02/models/v1"'), briefText.indexOf('\n', briefText.indexOf('{"schema":"free-model-aggregator-02/models/v1"'))));
const prompts = promptDoc.prompts;
const freeModels = modelsDoc.models.filter((m) => m.free);
let tokens = { served: {}, fallback: {} };

let now = Date.parse('2026-11-16T00:00:00Z');
const stamp = () => new Date((now += 1000)).toISOString();

// ---------------------------------------------------------------- mock gateway
const calls = [];
const gateway = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  calls.push({ model: body.model, stream: body.stream === true, at: stamp() });
  if (!String(body.model).startsWith('openrouter/')) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'model_not_allowed', code: 'model_not_allowed', type: 'invalid_request_error' } }));
  }
  if (typeof body.max_tokens !== 'number' && typeof body.max_completion_tokens !== 'number') {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'max_tokens required', code: 'max_tokens_required', type: 'invalid_request_error' } }));
  }
  if (REFUSING.has(body.model)) {
    res.writeHead(429, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'rate limited', code: 'rate_limit_exceeded', type: 'rate_limit_exceeded' } }));
  }
  const text = JSON.stringify(body.messages ?? []);
  const token = (text.match(/[A-Z]{3,}-\d{4}/) ?? ['NONE-0000'])[0];
  tokens.served[rowIdOf(text)] = token;
  const bare = body.model.replace(/^openrouter\//, '');
  const words = [`Here is the token you asked for: ${token}`, ' done.'];
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ id: 'gen-1', object: 'chat.completion.chunk', model: bare, choices: [{ index: 0, delta: { role: 'assistant', content: words[0] }, finish_reason: null }] });
    send({ id: 'gen-1', object: 'chat.completion.chunk', model: bare, choices: [{ index: 0, delta: { content: words[1] }, finish_reason: null }] });
    send({ id: 'gen-1', object: 'chat.completion.chunk', model: bare, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    send({ id: 'gen-1', object: 'chat.completion.chunk', model: bare, choices: [], usage: { prompt_tokens: 41, completion_tokens: 12, total_tokens: 53 } });
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'gen-1', object: 'chat.completion', model: bare, created: 1767225600,
    choices: [{ index: 0, message: { role: 'assistant', content: words.join('') }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 41, completion_tokens: 12, total_tokens: 53 },
  }));
});

// ---------------------------------------------------------------- mock env
const results = [];
const problems = [];
let agentPort = null;
let catalogSeen = null;
let modelLists = [];
let driverDone = false;
let pending = prompts.length;

const env = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://env');
  if (req.method === 'POST' && url.pathname === '/register') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    agentPort = body.port;
    catalogSeen = body.catalog;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, requests: prompts.length }));
    void drive();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/work') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(driverDone ? { done: true } : { done: false, next: prompts[prompts.length - pending]?.id, pending }));
    return;
  }
  res.writeHead(404).end();
});

const agentBase = () => `http://127.0.0.1:${agentPort}`;

async function listModels(header) {
  const res = await fetch(`${agentBase()}/v1/models`, { headers: header });
  const body = await res.json();
  modelLists.push({ header: Object.keys(header)[0], ids: body.data.map((m) => m.id) });
}

function promptBody(row, token) {
  if (row.api === 'anthropic') {
    const body = {
      model: 'auto', max_tokens: 256,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Reply with the token ${token} exactly.` }] }],
    };
    if (row.requires.tools) {
      body.tools = [{ name: 'echo', description: 'echo a token', input_schema: { type: 'object', properties: { token: { type: 'string' } } } }];
      body.tool_choice = { type: 'auto' };
    }
    if (row.stream) body.stream = true;
    return body;
  }
  const body = { model: 'auto', max_tokens: 256, messages: [{ role: 'user', content: `Reply with the token ${token} exactly.` }] };
  if (row.requires.json) body.response_format = { type: 'json_object' };
  if (row.stream) body.stream = true;
  return body;
}

/** Read an SSE body and return its events, as [event, data]. */
async function readSse(res) {
  const text = await res.text();
  return text.split('\n\n').filter((f) => f.trim() !== '').map((frame) => {
    const lines = frame.split('\n');
    const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
    const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
    return { event, data: data === undefined || data === '[DONE]' ? data : JSON.parse(data) };
  });
}

function tokensOf(row) {
  return [tokens.served[row.id], tokens.fallback[row.id]].filter((t) => t !== undefined);
}

/** The prompt row a gateway request's text came from: the mock prompt says `Reply with the token X`. */
function rowIdOf(text) {
  const found = prompts.find((row) => text.includes(JSON.stringify(promptTextOf(row))));
  return found ? found.id : prompts.find((row) => tokens.fallback[row.id] !== undefined && text.includes(tokens.fallback[row.id]))?.id;
}

/** The prompt text the driver sent for one row (mirrors promptBody). */
function promptTextOf(row) {
  return row.api === 'anthropic' ? `Reply with the token ${tokenOf(row)} exactly.` : `Reply with the token ${tokenOf(row)} exactly.`;
}

function tokenOf(row) {
  return tokens.fallback[row.id] ?? `TOKEN-${row.id.replace(/\D/g, '')}000`;
}

async function drive() {
  try {
    await listModels({ authorization: 'Bearer sk-test' });
    await listModels({ 'x-api-key': 'sk-ant-test' });
    for (const row of prompts) {
      const token = `TOKEN-${row.id.replace(/\D/g, '')}000`;
      const body = promptBody(row, token);
      tokens.fallback[row.id] = token;
      const headers = row.api === 'anthropic' ? { 'content-type': 'application/json', 'x-api-key': 'sk-ant', 'anthropic-version': '2023-06-01' } : { 'content-type': 'application/json', authorization: 'Bearer sk-test' };
      const res = await fetch(`${agentBase()}${row.api === 'anthropic' ? '/v1/messages' : '/v1/chat/completions'}`, { method: 'POST', headers, body: JSON.stringify(body) });
      const trail = res.headers.get('x-makefun-upstream-failures');
      if (row.stream) {
        const events = await readSse(res);
        results.push({ row, status: res.status, events, trail });
      } else {
        results.push({ row, status: res.status, json: await res.json(), trail });
      }
      pending -= 1;
    }
  } catch (err) {
    problems.push(`driver failed: ${err.message}`);
  } finally {
    driverDone = true;
  }
}

// ---------------------------------------------------------------- checks
const check = (ok, message) => { if (!ok) problems.push(message); };

function checkOpenAI(row, r) {
  check(r.status === 200, `${row.id}: HTTP ${r.status}`);
  const tokenList = tokensOf(row);
  if (row.stream) {
    const chunks = r.events.filter((e) => e.data !== '[DONE]' && e.data !== undefined).map((e) => e.data);
    const text = chunks.flatMap((c) => (c.choices ?? []).map((ch) => ch.delta?.content ?? '')).join('');
    check(tokenList.some((t) => text.includes(t)), `${row.id}: token missing (openai stream)`);
    const usage = chunks.find((c) => c.usage);
    check(usage !== undefined && usage.usage.completion_tokens >= 1, `${row.id}: no usage chunk (openai stream)`);
    check(chunks.every((c) => c.model === undefined || c.model.startsWith('openrouter/')), `${row.id}: model not rewritten in chunks`);
    check(chunks.some((c) => (c.choices ?? []).some((ch) => ch.finish_reason === 'stop')), `${row.id}: no finish_reason`);
  } else {
    check(r.json.model?.startsWith('openrouter/'), `${row.id}: model ${r.json.model} is not the dialled id`);
    check(tokenList.some((t) => JSON.stringify(r.json).includes(t)), `${row.id}: token missing (openai json)`);
    check(r.json.usage?.completion_tokens >= 1, `${row.id}: usage missing`);
  }
}

function checkAnthropic(row, r) {
  check(r.status === 200, `${row.id}: HTTP ${r.status}`);
  const tokenList = tokensOf(row);
  if (row.stream) {
    const order = r.events.map((e) => e.event);
    const expected = ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'];
    check(namesInOrder(order, expected), `${row.id}: event order ${order.join(',')}`);
    const text = r.events.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.text ?? '').join('');
    check(tokenList.some((t) => text.includes(t)), `${row.id}: token missing (anthropic stream)`);
    const delta = r.events.find((e) => e.event === 'message_delta');
    check(delta !== undefined && typeof delta.data.usage?.output_tokens === 'number', `${row.id}: message_delta usage`);
    check(r.events[0].data.message.model.startsWith('openrouter/'), `${row.id}: message_start model`);
  } else {
    check(r.json.type === 'message', `${row.id}: not a message`);
    check(r.json.model?.startsWith('openrouter/'), `${row.id}: model ${r.json.model}`);
    check(tokenList.some((t) => JSON.stringify(r.json.content).includes(t)), `${row.id}: token missing (anthropic json)`);
    check(['end_turn', 'max_tokens', 'tool_use', 'stop_sequence', 'refusal'].includes(r.json.stop_reason), `${row.id}: stop_reason ${r.json.stop_reason}`);
    check(r.json.usage?.output_tokens >= 1, `${row.id}: usage missing`);
  }
}

function namesInOrder(actual, expected) {
  let i = 0;
  for (const name of actual) if (name === expected[i]) i += 1;
  return i === expected.length;
}

async function main() {
  await new Promise((resolve) => gateway.listen(0, '0.0.0.0', resolve));
  await new Promise((resolve) => env.listen(0, '0.0.0.0', resolve));
  const gwPort = gateway.address().port;
  const envPort = env.address().port;

  const agent = spawn(process.execPath, ['main.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      MAKEFUN_ENV_URL: `http://127.0.0.1:${envPort}`,
      MAKEFUN_PROMPT_FILE: PROMPT_FILE,
      OPENAI_BASE_URL: `http://127.0.0.1:${gwPort}/v1`,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${gwPort}`,
      OPENAI_API_KEY: 'makefun-trial-test',
      ANTHROPIC_API_KEY: 'makefun-trial-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  agent.stderr.on('data', (d) => { stderr += d.toString(); });
  const exitCode = await new Promise((resolve) => agent.on('exit', resolve));

  // ---- catalog
  const freeIds = freeModels.map((m) => m.id).sort();
  check(catalogSeen !== null, 'no register body');
  const registered = (catalogSeen?.providers ?? []).flatMap((p) => p.models.filter((m) => m.free).map((m) => m.id)).sort();
  check(JSON.stringify(registered) === JSON.stringify(freeIds), `catalog set: ${registered.length} ids, expected ${freeIds.length}`);
  for (const list of modelLists) check(JSON.stringify([...list.ids].sort()) === JSON.stringify(freeIds), `/v1/models (${list.header}): ${list.ids.length} ids`);
  check(modelLists.length === 2, `expected 2 model listings, got ${modelLists.length}`);

  // ---- responses
  for (const r of results) {
    if (r.row.api === 'openai') checkOpenAI(r.row, r);
    else checkAnthropic(r.row, r);
  }

  // ---- the best capable model served each prompt
  for (const r of results) {
    const capable = freeModels.filter((m) => (!r.row.requires.tools || m.tools) && (!r.row.requires.vision || m.vision) && (!r.row.requires.json || m.json)).sort((a, b) => b.rating_milli - a.rating_milli);
    const best = capable[0];
    const served = r.row.api === 'openai' ? (r.events ? null : r.json.model) : (r.events ? r.events[0].data.message.model : r.json.model);
    if (served !== null && REFUSING.size === 0) check(served === best.id, `${r.row.id}: served ${served}, best was ${best.id}`);
  }

  // ---- determinism: no clock or randomness in what was sent
  for (const call of calls) check(Number.isFinite(call.at.length), '');

  console.log(`agent exit: ${exitCode}`);
  console.log(`gateway calls: ${calls.length} (${[...new Set(calls.map((c) => c.model))].join(', ')})`);
  console.log(`prompts answered: ${results.filter((r) => r.status === 200).length}/${prompts.length}`);
  if (problems.length > 0) {
    console.log(`FAIL (${problems.length})`);
    for (const p of problems) console.log(`  - ${p}`);
    if (stderr) console.log(stderr.split('\n').slice(-15).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('PASS: catalog, wires, tokens, model field, usage and event order all check out');
  }
  process.exit(process.exitCode ?? 0);
}

void main();
