import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runVisible(config, dir, job) {
  if (process.platform !== 'win32') throw new Error('Visible TUI mode currently supports Windows only');
  const profileName = `codex-collab-${job.job_id}`;
  const profile = path.join(config.tuiHome, 'profiles', profileName);
  const link = path.join(profile, 'node_modules', '@deepseek-harness-tui', 'dsh-tui');
  await fs.mkdir(path.dirname(link), { recursive: true });
  try { await fs.lstat(link); } catch (e) { if (e.code !== 'ENOENT') throw e; await fs.symlink(config.tuiPackage, link, 'junction'); }
  await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-codex-collab', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui'] } } }));
  const quote = s => JSON.stringify(s.replaceAll('\\', '/'));
  const patch = `- id: credentials\n  config:\n    path: ${quote(config.credentialsPath)}\n    watch: false\n- id: settings\n  config:\n    path: ${quote(config.settingsPath)}\n    watch: false\n- id: hmr\n  disabled: true\n- id: dsh-tui\n  config:\n    fullscreen: true\n    activity: true\n    contextBar: true\n    cwd: ${quote(job.cwd)}\n- insert:\n    - id: codex-visible-stage\n      name: ${quote(pathToFileURL(path.join(here, 'visible-plugin.mjs')).href)}\n`;
  await fs.writeFile(path.join(profile, 'cordis.patch.yml'), patch);
  const launch = { jobId: job.job_id, profile: profileName, node: process.execPath, dshBin: config.dshBin, dshHome: config.tuiHome, powershell: config.powershellPath || 'pwsh.exe', terminal: config.terminalPath, cwd: job.cwd, taskFile: job.task_file, timeoutSeconds: config.timeoutSeconds, discoveryFile: path.join(homedir(), '.dsh-tui', 'inject', 'servers.json') };
  const launchFile = path.join(dir, 'visible-launch.json');
  await fs.writeFile(launchFile, JSON.stringify(launch));
  const start = spawn(launch.powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(here, 'visible-start.ps1'), '-LaunchFile', launchFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = ''; start.stdout.on('data', d => output += d); start.stderr.on('data', d => error += d);
  const exit = await new Promise((resolve, reject) => { start.once('error', reject); start.once('close', resolve); });
  if (exit !== 0) throw new Error(`Unable to open visible window: ${error}`);
  await fs.writeFile(path.join(dir, 'visible-window.json'), output.trim());
  const deadline = Date.now() + (config.timeoutSeconds + 90) * 1000;
  const bootDeadline = Date.now() + 75000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await fs.readFile(path.join(dir, 'process-outcome.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
    if (Date.now() > bootDeadline) {
      try { await fs.access(path.join(dir, 'public-events.jsonl')); }
      catch { return { exit_code: 1, reason: 'failed', error: 'The terminal did not start the collaboration agent within 75 seconds; see console.log' }; }
    }
    await sleep(250);
  }
  // Cancel the owned turn via the in-process plugin; never kill the user's TUI.
  await fs.writeFile(path.join(dir, 'cancel.json'), JSON.stringify({ reason: 'Visible session watchdog expired' }));
  return { exit_code: 1, reason: 'timed_out', error: 'No terminal stage result received from the visible TUI' };
}
