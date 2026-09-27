// Protocol fixture only: stands in for an interactive Claude Code TUI with a
// development channel. It runs the real Swarm MCP from --mcp-config and the
// real lifecycle hooks from --settings, and answers channel events the way the
// probe observed Claude doing. No model, no keyboard input.
const { spawn, execFileSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const args = process.argv.slice(2);
const logPath = process.env.FIXTURE_LOG;
const log = (type, data = {}) => appendFileSync(logPath, JSON.stringify({ at: Date.now(), type, ...data }) + '\n');
log('argv', { args, stdin: process.stdin.isTTY ?? null });
const sessionId = args[args.indexOf('--session-id') + 1];
const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
const hook = (event) => {
  for (const entry of settings.hooks[event] ?? []) for (const h of entry.hooks)
    execFileSync('/bin/sh', ['-c', h.command], { input: JSON.stringify({ session_id: sessionId, hook_event_name: event }), env: process.env });
  log('hook', { event });
};
const mcp = config.mcpServers.swarm;
const child = spawn(mcp.command, mcp.args, { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
let next = 10;
const pending = new Map();
const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
const call = (name, args) => new Promise(resolve => {
  const id = next++;
  pending.set(id, resolve);
  send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
});
// Claude queues channel events and runs one turn at a time.
let queue = Promise.resolve();
const turn = (run) => { queue = queue.then(run).catch(error => log('error', { message: String(error) })); };
let acks = 0;
createInterface({ input: child.stdout }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === 1) {
    log('initialized', { channel: !!message.result?.capabilities?.experimental?.['claude/channel'] });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return;
  }
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message.result);
    pending.delete(message.id);
    return;
  }
  if (message.method !== 'notifications/claude/channel') return;
  const { content, meta } = message.params;
  log('channel', { meta });
  if (meta.kind === 'swarm.readiness') {
    if (process.env.FIXTURE_IGNORE_READINESS === '1') return;
    turn(async () => {
      hook('UserPromptSubmit');
      const early = await call('swarm_sync', {});
      log('early_sync', { isError: early.isError, text: early.content[0].text });
      const wrong = await call('swarm_ready', { nonce: 'not-the-nonce' });
      log('wrong_nonce', { isError: wrong.isError });
      const nonce = /nonce "([^"]+)"/.exec(content)[1];
      const ready = await call('swarm_ready', { nonce });
      log('ready', { isError: ready.isError });
      hook('Stop');
    });
    return;
  }
  const lease = JSON.parse(content.slice(content.indexOf('\n') + 1));
  turn(async () => {
    hook('UserPromptSubmit');
    log('envelope', { messageId: lease.message.id, kind: lease.message.kind, attempt: lease.attempt });
    if (lease.message.kind === 'task.assigned') {
      const assignment = JSON.parse(lease.message.body);
      await call('swarm_inbox', { commandId: `ack-${lease.message.id}`, action: 'ack', messageId: lease.message.id, leaseToken: lease.leaseToken });
      const finish = await call('swarm_task', { commandId: `finish-${assignment.taskId}`, action: 'finish', taskId: assignment.taskId,
        attemptId: assignment.attemptId, fence: assignment.fence, outcome: 'completed',
        report: { summary: 'Fixture finished the trivial task', evidence: ['fenced outcome'], limitations: [] } });
      log('finished', { isError: finish.isError });
    } else {
      // Hold a peer message briefly: the next envelope must wait for this ack.
      await new Promise(resolve => setTimeout(resolve, 1500));
      log('acking', { messageId: lease.message.id, n: ++acks });
      await call('swarm_inbox', { commandId: `ack-${lease.message.id}`, action: 'ack', messageId: lease.message.id, leaseToken: lease.leaseToken });
    }
    hook('Stop');
  });
});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { experimental: { 'claude/channel': {} } }, clientInfo: { name: 'fixture', version: '1' } } });
process.on('SIGTERM', () => { child.kill(); process.exit(0); });
process.on('SIGHUP', () => { child.kill(); process.exit(0); });
