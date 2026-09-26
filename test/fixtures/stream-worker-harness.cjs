// Protocol fixture only: exercise the actual wrapper and MCP, without a model.
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const args = process.argv.slice(2);
const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
let child;
let initialized = false;
let startup = false;
function send(message) { child.stdin.write(JSON.stringify(message) + '\n'); }
function probe() { if (initialized && startup) send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'swarm_sync', arguments: {} } }); }
createInterface({ input: process.stdin }).on('line', () => {
  if (startup) { console.log(JSON.stringify({ type: 'result' })); return; }
  startup = true;
  const mcp = config.mcpServers.swarm;
  child = spawn(mcp.command, mcp.args, { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
  createInterface({ input: child.stdout }).on('line', line => {
    const response = JSON.parse(line);
    if (response.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      initialized = true; probe();
    } else if (response.id === 2) console.log(JSON.stringify({ type: 'result', response }));
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
});
process.on('SIGTERM', () => { child?.kill(); process.exit(0); });
