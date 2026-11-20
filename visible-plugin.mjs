import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const name = 'codex-visible-stage';
export const inject = ['agents', 'sessions'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// This plugin is mounted only in a new, bridge-owned TUI process.
export function apply(ctx) {
  const dir = process.env.DSH_BRIDGE_JOB_DIR;
  const anchor = process.env.DSH_BRIDGE_DSH_BIN;
  if (!dir || !path.isAbsolute(dir) || !anchor) throw new Error('Missing visible bridge launch context');
  const outcomePath = path.join(dir, 'process-outcome.json');
  let finished = false, agent, firstSeq = Infinity, submitted = false, stopReason, timer;
  const outcome = value => {
    if (finished) return;
    finished = true; clearInterval(timer);
    const temporary = `${outcomePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ ...value, session_id: agent?.session.id, tui_pid: process.pid }));
    fs.renameSync(temporary, outcomePath);
  };
  const progress = value => fs.appendFileSync(path.join(dir, 'public-events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
  ctx.effect(() => () => {
    if (!finished) outcome({ exit_code: 1, reason: 'failed', error: 'Visible TUI closed before this stage completed' });
  });
  ctx.on('session/event', (session, event) => {
    if (finished || !submitted || session.id !== agent?.session.id || event.seq < firstSeq) return;
    if (['turn/start', 'step/start', 'tool/call', 'tool/result', 'turn/end'].includes(event.type)) {
      progress({ type: event.type, seq: event.seq, ...(event.data?.name ? { tool: event.data.name } : {}) });
    }
    // Deliberately do not export reasoning chunks or tool arguments.
    if (event.type === 'assistant/message') {
      const text = (event.data.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      if (text) fs.writeFileSync(path.join(dir, 'stdout.log'), text + '\n');
    }
    if (event.type === 'turn/end') {
      const reason = stopReason || (event.data.reason?.kind === 'completed' ? null : 'failed');
      // Flush out of the event dispatch chain; wait for durable evidence first.
      Promise.resolve().then(async () => {
        await ctx.sessions.flush(agent.session);
        outcome({ exit_code: reason ? 1 : 0, reason, ...(reason === 'failed' ? { error: `Agent turn ended: ${event.data.reason?.kind || 'unknown'}` } : {}) });
      }).catch(error => outcome({ exit_code: 1, reason: 'failed', error: error.message }));
    }
  });
  (async () => {
    const spec = JSON.parse(fs.readFileSync(path.join(dir, 'visible-launch.json'), 'utf8'));
    const require = createRequire(anchor);
    const { createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !finished) {
      const candidates = ctx.agents.list().filter(a => !a.session.header.parentSession && path.resolve(a.session.header.cwd || '.') === path.resolve(spec.cwd));
      if (candidates.length > 1) throw new Error('More than one root agent in the collaboration process');
      agent = candidates[0];
      if (agent) {
        // The TUI publishes this endpoint after its UI has mounted.
        try {
          const servers = JSON.parse(fs.readFileSync(spec.discoveryFile, 'utf8'));
          if (servers.some(s => s.pid === process.pid && s.sessionId === agent.session.id)) break;
        } catch {}
      }
      await sleep(200);
    }
    if (finished) return;
    if (!agent || Date.now() >= deadline) throw new Error('Visible TUI did not mount in time');
    await agent.whenIdle();
    if (finished) return;
    if (fs.existsSync(path.join(dir, 'cancel.json'))) { outcome({ exit_code: 1, reason: 'cancelled' }); return; }
    firstSeq = agent.session.seq;
    const task = fs.readFileSync(spec.taskFile, 'utf8');
    submitted = true;
    progress({ type: 'bridge/submitted', session_id: agent.session.id });
    const started = Date.now();
    timer = setInterval(() => {
      if (finished || stopReason) return;
      if (fs.existsSync(path.join(dir, 'cancel.json'))) stopReason = 'cancelled';
      else if (Date.now() - started >= spec.timeoutSeconds * 1000) stopReason = 'timed_out';
      if (stopReason) agent.cancel({ kind: 'user' });
    }, 100);
    agent.followup(createUserMessage({ content: [{ type: 'text', text: `【Codex 阶段指导 ${spec.jobId}】\n\n${task}` }], source: { kind: 'user' } }));
  })().catch(error => {
    fs.appendFileSync(path.join(dir, 'stderr.log'), error.stack + '\n');
    outcome({ exit_code: 1, reason: 'failed', error: error.message });
  });
}
