import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const bridge = fileURLToPath(new URL('../bridge.mjs', import.meta.url));
const root = path.resolve(path.dirname(bridge), '.test-tmp', 'lifecycle', randomUUID());
const cwd = path.join(root, 'workspace');
const outside = path.join(root, 'outside');
const configPath = path.join(root, 'config.json');
const fake = path.join(root, 'fake-dsh.mjs');
await fs.mkdir(cwd, { recursive: true });
await fs.mkdir(outside);
await fs.writeFile(fake, `import fs from 'node:fs';
const instruction = process.argv.at(-1);
const quoted = instruction.match(/at ("(?:[^"\\\\]|\\\\.)*") and execute/);
const task = fs.readFileSync(JSON.parse(quoted[1]), 'utf8');
if (task.includes('FIXTURE_FAIL')) { process.stderr.write('fixture failure\\n'); process.exit(3); }
if (task.includes('FIXTURE_HOLD')) { setInterval(() => {}, 1000); }
else { fs.writeFileSync('fixture-evidence.txt', 'executed'); process.stdout.write('fixture completed\\n'); }
`);
const config = { dshBin: fake, dshHome: path.join(root, 'home'), allowedRoots: [cwd], stateDir: path.join(root, 'state'), timeoutSeconds: 20, adapterMode: 'legacy' };
await fs.writeFile(configPath, JSON.stringify(config));

function invoke(action, input = {}, cfg = configPath) {
  return new Promise(async (resolve, reject) => {
    const inputPath = path.join(root, `${randomUUID()}.json`);
    await fs.writeFile(inputPath, JSON.stringify(input));
    const p = spawn(process.execPath, [bridge, '--config', cfg, action, '--input', inputPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => stdout += d); p.stderr.on('data', d => stderr += d);
    p.on('error', reject);
    p.on('close', code => resolve({ code, stdout, stderr, value: code === 0 ? JSON.parse(stdout) : null }));
  });
}
async function ok(action, input, cfg) { const r = await invoke(action, input, cfg); assert.equal(r.code, 0, r.stderr); return r.value; }
async function until(id, expected, cfg) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const s = await ok('status', { job_id: id }, cfg);
    if (expected.includes(s.status)) return s;
    if (!['queued', 'running', 'stopping'].includes(s.status)) throw new Error(`Unexpected state ${JSON.stringify(s)}`);
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('Fixture job did not reach expected state');
}

test('asynchronous execution requires review; feedback reaches next stage', async () => {
  const started = await ok('start', { cwd, task: 'FIXTURE_SUCCESS' });
  assert.equal(started.status, 'queued');
  await until(started.job_id, ['awaiting_review']);
  assert.equal(await fs.readFile(path.join(cwd, 'fixture-evidence.txt'), 'utf8'), 'executed');
  const blocked = await invoke('start', { cwd, task: 'another task' });
  assert.equal(blocked.code, 1); assert.match(blocked.stderr, /unreviewed/);
  const queued = await ok('feedback', { job_id: started.job_id, text: 'MENTOR_FEEDBACK_123' });
  assert.equal(queued.delivery, 'queued_for_next_stage');
  const reviewed = await ok('review', { job_id: started.job_id, decision: 'approve', notes: 'Independently checked fixture evidence' });
  assert.equal(reviewed.status, 'approved');
  const next = await ok('start', { cwd, task: 'NEXT_STAGE', previous_job_id: started.job_id });
  assert.match(await fs.readFile(next.task_file, 'utf8'), /MENTOR_FEEDBACK_123/);
  await until(next.job_id, ['awaiting_review']);
  await ok('review', { job_id: next.job_id, decision: 'approve', notes: 'Second stage checked' });
});

test('workspace boundaries, invalid ids, unsupported legacy resume', async () => {
  assert.equal((await invoke('start', { cwd: outside, task: 'invalid' })).code, 1);
  assert.equal((await invoke('status', { job_id: '../config' })).code, 1);
  assert.equal((await invoke('start', { cwd, task: 'invalid', session_id: 'session-123' })).code, 1);
});

test('active workspace cannot overlap; cancel confirms termination', async () => {
  const job = await ok('start', { cwd, task: 'FIXTURE_HOLD' });
  await until(job.job_id, ['running']);
  const nested = path.join(cwd, 'nested'); await fs.mkdir(nested, { recursive: true });
  assert.equal((await invoke('start', { cwd: nested, task: 'must be blocked' })).code, 1);
  await ok('feedback', { job_id: job.job_id, text: 'Saved during execution' });
  assert.equal((await ok('status', { job_id: job.job_id })).feedback_count, 1);
  await ok('cancel', { job_id: job.job_id, reason: 'Lifecycle cancellation test' });
  await until(job.job_id, ['cancelled']);
  assert.equal((await invoke('review', { job_id: job.job_id, decision: 'approve', notes: 'Cannot approve cancelled work' })).code, 1);
});

test('failure and timeout cannot appear successful', async () => {
  const failed = await ok('start', { cwd, task: 'FIXTURE_FAIL' });
  const failure = await until(failed.job_id, ['failed']);
  assert.equal(failure.exit_code, 3);
  assert.match((await ok('result', { job_id: failed.job_id })).stderr.text, /fixture failure/);
  const timeoutConfig = path.join(root, 'timeout.json');
  await fs.writeFile(timeoutConfig, JSON.stringify({ ...config, timeoutSeconds: 2 }));
  const timed = await ok('start', { cwd, task: 'FIXTURE_HOLD' }, timeoutConfig);
  await until(timed.job_id, ['timed_out'], timeoutConfig);
});

test('immediate cancellation cannot become awaiting_review', async () => {
  const job = await ok('start', { cwd, task: 'FIXTURE_HOLD' });
  await ok('cancel', { job_id: job.job_id });
  await until(job.job_id, ['cancelled']);
});

test('MCP handshake, tool discovery and operation errors', async () => {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'deepseek_list', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'deepseek_status', arguments: { job_id: '../bad' } } }
  ];
  const result = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [bridge, '--config', configPath, 'serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d); p.on('error', reject);
    p.on('close', code => resolve({ code, out, err }));
    p.stdin.end(messages.map(m => JSON.stringify(m)).join('\n') + '\n');
  });
  assert.equal(result.code, 0, result.err);
  const replies = result.out.trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 4);
  assert.equal(replies[0].result.protocolVersion, '2025-06-18');
  assert.equal(replies[1].result.tools.length, 7);
  assert.ok(JSON.parse(replies[2].result.content[0].text).length >= 4);
  assert.equal(replies[3].result.isError, true);
});
