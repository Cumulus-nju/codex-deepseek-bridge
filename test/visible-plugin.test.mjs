import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { apply } from '../visible-plugin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../.test-tmp', 'visible-plugin', randomUUID());
const lib = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-llm');
await fs.mkdir(lib, { recursive: true });
await fs.writeFile(path.join(lib, 'package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }));
await fs.writeFile(path.join(lib, 'index.mjs'), 'export const createUserMessage = value => value;');
const anchor = path.join(root, 'fake-dsh.mjs'); await fs.writeFile(anchor, '');
const pause = ms => new Promise(r => setTimeout(r, ms));

async function fixture(mode, timeoutSeconds = 3) {
  const dir = path.join(root, randomUUID()); await fs.mkdir(dir);
  const task = path.join(dir, 'task.md'); await fs.writeFile(task, 'Bounded visible stage');
  const session = { id: randomUUID(), header: { cwd: dir }, seq: 0 };
  const discovery = path.join(dir, 'servers.json');
  await fs.writeFile(discovery, JSON.stringify([{ pid: process.pid, sessionId: session.id }]));
  await fs.writeFile(path.join(dir, 'visible-launch.json'), JSON.stringify({ cwd: dir, taskFile: task, jobId: 'fixture', discoveryFile: discovery, timeoutSeconds }));
  let listener, submitted = false, cancelled = false, cleanup;
  const send = (type, data) => listener(session, { type, seq: session.seq++, data });
  const agent = {
    session,
    whenIdle: async () => {},
    followup(message) {
      submitted = true;
      assert.match(message.content[0].text, /Codex 阶段指导/);
      send('turn/start', {});
      if (mode === 'complete') setTimeout(() => {
        send('assistant/message', { message: { content: [{ type: 'reasoning', text: 'private fixture reasoning' }, { type: 'text', text: 'public stage answer' }] } });
        send('turn/end', { reason: { kind: 'completed' } });
      }, 20);
    },
    cancel() { cancelled = true; send('turn/end', { reason: { kind: 'interrupted' } }); }
  };
  const ctx = { agents: { list: () => [agent] }, sessions: { flush: async () => {} }, effect: cb => { cleanup = cb(); }, on: (_event, cb) => { listener = cb; } };
  const oldDir = process.env.DSH_BRIDGE_JOB_DIR, oldAnchor = process.env.DSH_BRIDGE_DSH_BIN;
  process.env.DSH_BRIDGE_JOB_DIR = dir; process.env.DSH_BRIDGE_DSH_BIN = anchor;
  apply(ctx);
  async function waitOutcome() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { return JSON.parse(await fs.readFile(path.join(dir, 'process-outcome.json'), 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      await pause(30);
    }
    throw new Error('No plugin outcome');
  }
  async function close() {
    cleanup();
    if (oldDir === undefined) delete process.env.DSH_BRIDGE_JOB_DIR; else process.env.DSH_BRIDGE_JOB_DIR = oldDir;
    if (oldAnchor === undefined) delete process.env.DSH_BRIDGE_DSH_BIN; else process.env.DSH_BRIDGE_DSH_BIN = oldAnchor;
  }
  return { dir, waitOutcome, close, isSubmitted: () => submitted, isCancelled: () => cancelled };
}

test('visible stage records its session and exports only public response', async () => {
  const f = await fixture('complete');
  try {
    const result = await f.waitOutcome();
    assert.equal(result.exit_code, 0); assert.ok(result.session_id);
    const output = await fs.readFile(path.join(f.dir, 'stdout.log'), 'utf8');
    assert.equal(output.trim(), 'public stage answer'); assert.doesNotMatch(output, /private fixture reasoning/);
  } finally { await f.close(); }
});

test('visible cancellation cancels the owned agent turn', async () => {
  const f = await fixture('hold');
  try {
    while (!f.isSubmitted()) await pause(10);
    await fs.writeFile(path.join(f.dir, 'cancel.json'), '{}');
    assert.equal((await f.waitOutcome()).reason, 'cancelled'); assert.equal(f.isCancelled(), true);
  } finally { await f.close(); }
});

test('visible timeout cannot appear successful', async () => {
  const f = await fixture('hold', 1);
  try { assert.equal((await f.waitOutcome()).reason, 'timed_out'); assert.equal(f.isCancelled(), true); }
  finally { await f.close(); }
});
