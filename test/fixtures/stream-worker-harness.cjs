// Protocol fixture only: exercise the actual wrapper and MCP, without a model.
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const args = process.argv.slice(2);
const harness = args.includes('app-server') ? 'codex' : args.includes('--mode') ? 'pi' : 'claude';
let config;
if (harness === 'claude') config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
else if (harness === 'pi') config = { mcpServers: JSON.parse(process.env.SWARM_WORKER_MCP_SERVERS) };
else {
  const fields = Object.fromEntries(args.filter(arg => arg.startsWith('mcp_servers.swarm.') && !arg.includes('.tools.')).map(arg => {
    const at = arg.indexOf('='); return [arg.slice('mcp_servers.swarm.'.length, at), JSON.parse(arg.slice(at + 1))];
  }));
  if (!fields.env_vars.includes('SWARM_WORKER_LAUNCH')) throw new Error('Missing launch binding');
  config = { mcpServers: { swarm: fields } };
}
function result() {
  console.log(JSON.stringify(harness === 'codex' ? { method: 'turn/completed', params: {} } : { type: harness === 'pi' ? 'agent_end' : 'result' }));
}
let child;
let initialized = false;
let startup = false;
function send(message) { child.stdin.write(JSON.stringify(message) + '\n'); }
let nextCall = 10;
const calls = new Map();
function tool(name, args) { return new Promise((resolve, reject) => {
  const id = nextCall++; calls.set(id, { resolve, reject });
  send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
}); }
async function complete(message) {
  const lease = JSON.parse(message.slice(message.indexOf('\n') + 1));
  const assignment = JSON.parse(lease.message.body);
  const ref = { taskId: assignment.taskId, attemptId: assignment.attemptId, fence: assignment.fence };
  await tool('swarm_inbox', { commandId: 'fixture-ack', action: 'ack', messageId: lease.message.id, leaseToken: lease.leaseToken });
  await tool('swarm_task', { ...ref, commandId: 'fixture-progress', action: 'progress', note: 'Protocol fixture received fenced assignment' });
  await tool('swarm_task', { ...ref, commandId: 'fixture-renew', action: 'renew' });
  await tool('swarm_task', { ...ref, commandId: 'fixture-finish', action: 'finish', outcome: 'completed', report: { summary: 'Protocol fixture completed', evidence: ['Real MCP assignment ack, progress, renewal and fenced finish'], limitations: ['Fake harness, no model'] } });
  result();
}
function probe() { if (initialized && startup) send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'swarm_sync', arguments: {} } }); }
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (harness === 'codex') {
    if (request.method === 'initialize') { console.log(JSON.stringify({ id: request.id, result: {} })); return; }
    if (request.method === 'initialized') return;
    if (request.method === 'thread/start') {
      if (request.params.model !== 'gpt-6-astra') throw new Error('Incorrect Codex model');
      console.log(JSON.stringify({ id: request.id, result: { thread: { id: 'fixture' } } })); return;
    }
    console.log(JSON.stringify({ id: request.id, result: { turn: { id: 'turn' } } }));
  } else if (harness === 'pi') console.log(JSON.stringify({ id: request.id, type: 'response', success: true }));
  if (startup) {
    const message = harness === 'codex' ? request.params.input[0].text : harness === 'pi' ? request.message : request.message.content;
    if (process.env.SWARM_FIXTURE_COMPLETE === '1') void complete(message).catch(error => { console.error(error); process.exit(1); });
    else result();
    return;
  }
  startup = true;
  const mcp = config.mcpServers.swarm;
  child = spawn(mcp.command, mcp.args, { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
  createInterface({ input: child.stdout }).on('line', line => {
    const response = JSON.parse(line);
    const call = calls.get(response.id);
    if (call) { calls.delete(response.id); if (response.error || response.result?.isError) call.reject(new Error(JSON.stringify(response))); else call.resolve(response.result); return; }
    if (response.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      initialized = true; probe();
    } else if (response.id === 2) result();
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
});
process.on('SIGTERM', () => { child?.kill(); process.exit(0); });
