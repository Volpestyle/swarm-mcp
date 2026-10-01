// A fake model drives the actual enrolled MCP; it cannot manufacture DB readiness.
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
exports.tools = async server => {
  const child = spawn(server.command, server.args, { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
  let next = 1;
  const calls = new Map();
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = next++; calls.set(id, { resolve, reject }); send({ jsonrpc: '2.0', id, method, params });
  });
  createInterface({ input: child.stdout }).on('line', line => {
    const reply = JSON.parse(line), pending = calls.get(reply.id);
    if (!pending) return;
    calls.delete(reply.id);
    if (reply.error || reply.result?.isError) pending.reject(new Error(JSON.stringify(reply)));
    else pending.resolve(reply.result);
  });
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'native-fixture', version: '1' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { child, call: (name, arguments) => request('tools/call', { name, arguments }) };
};
exports.process = async (call, message) => {
  if (!message.startsWith('Swarm peer context')) { await call('swarm_sync', {}); return; }
  const lease = JSON.parse(message.slice(message.indexOf('\n') + 1));
  await call('swarm_inbox', { commandId: `ack-${lease.message.id}`, action: 'ack', messageId: lease.message.id, leaseToken: lease.leaseToken });
  if (lease.message.kind !== 'task.assigned') return;
  const assignment = JSON.parse(lease.message.body);
  const ref = { taskId: assignment.taskId, attemptId: assignment.attemptId, fence: assignment.fence };
  await call('swarm_task', { ...ref, commandId: 'native-progress', action: 'progress', note: 'Native fixture received fenced assignment' });
  await call('swarm_task', { ...ref, commandId: 'native-renew', action: 'renew' });
  if (process.env.SWARM_FIXTURE_COMPLETE !== '1') return;
  await call('swarm_task', { ...ref, commandId: 'native-finish', action: 'finish', outcome: 'completed', report: { summary: 'Native protocol fixture completed', evidence: ['Real MCP ack, progress, renewal, fenced finish'], limitations: ['Fake TUI and model'] } });
};
