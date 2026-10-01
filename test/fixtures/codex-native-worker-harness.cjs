// Two actual WebSocket clients and the real MCP, with a fake native UI/model.
const { WebSocket, WebSocketServer } = require(process.env.SWARM_TEST_NODE_MODULES + '/ws');
const { createServer } = require('node:http');
const { appendFileSync } = require('node:fs');
const { tools, process: processMessage } = require(process.env.SWARM_TEST_FIXTURES + '/native-worker-tools.cjs');
const args = process.argv.slice(2);
const log = (type, data = {}) => appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ type, ...data }) + '\n');
log('codex_argv', { args });
const threadId = '20000000-0000-4000-8000-000000000001';
if (args.includes('--remote')) {
  const path = args[args.indexOf('--remote') + 1].slice('unix://'.length);
  const socket = new WebSocket(`ws+unix://${path}:/`);
  socket.on('open', () => socket.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'native-fixture-ui', version: '1' } } })));
  socket.on('message', bytes => {
    const message = JSON.parse(String(bytes));
    if (message.id === 1) socket.send(JSON.stringify({ id: 2, method: 'thread/start', params: { cwd: process.cwd() } }));
    if (message.method?.includes('requestApproval')) { log('native_approval'); socket.send(JSON.stringify({ id: message.id, result: { decision: 'approved' } })); }
  });
  setInterval(() => {}, 1000);
} else {
  const path = args[args.indexOf('--listen') + 1].slice('unix://'.length);
  const fields = Object.fromEntries(args.filter(arg => arg.startsWith('mcp_servers.swarm.') && !arg.includes('.tools.')).map(arg => { const at = arg.indexOf('='); return [arg.slice('mcp_servers.swarm.'.length, at), JSON.parse(arg.slice(at + 1))]; }));
  const server = createServer(), wss = new WebSocketServer({ server });
  let loaded = false, persisted = false, mcp, turn, approval;
  const clients = new Map();
  const thread = () => ({ id: threadId, cwd: process.env.FIXTURE_CODEX_WRONG_DIRECTORY === "1" ? "/wrong" : process.cwd(), turns: turn ? [turn] : [] });
  const notify = (method, params) => { for (const socket of clients.keys()) socket.send(JSON.stringify({ method, params })); };
  wss.on('connection', socket => {
    clients.set(socket, 'unknown');
    socket.on('message', bytes => { void (async () => {
      const request = JSON.parse(String(bytes));
      if (!request.method) {
        if (request.id === 77) { log('approval_answer', { client: clients.get(socket) }); approval?.(); }
        return;
      }
      const reply = result => socket.send(JSON.stringify({ id: request.id, result }));
      if (request.method === 'initialize') { clients.set(socket, request.params.clientInfo.name); reply({}); }
      else if (request.method === 'initialized') {}
      else if (request.method === 'thread/start') {
        if (clients.get(socket) !== 'native-fixture-ui') throw new Error('Supervisor must not create the native thread');
        loaded = true; reply({ thread: thread() });
      } else if (request.method === 'thread/loaded/list') reply({ data: loaded ? (process.env.FIXTURE_CODEX_TWO_THREADS === "1" ? [threadId, "another-thread"] : [threadId]) : [] });
      else if (request.method === 'thread/read') reply({ thread: thread() });
      else if (request.method === 'thread/resume') {
        if (!persisted) socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: 'no rollout found' } }));
        else reply({ thread: thread() });
      } else if (request.method === 'turn/start') {
        if (request.params.threadId !== threadId || request.params.approvalPolicy || request.params.sandbox) throw new Error('Wrong thread or changed native policy');
        log('turn_start'); persisted = true; turn = { id: 'turn-' + Date.now(), status: 'inProgress' };
        if (process.env.FIXTURE_LOST_TURN_REPLY !== '1') reply({ turn });
        notify('turn/started', { threadId, turn });
        if (process.env.FIXTURE_SKIP_MODEL === '1') return;
        if (!mcp) {
          await new Promise(done => { approval = done; notify('item/commandExecution/requestApproval', { threadId }); for (const s of clients.keys()) s.send(JSON.stringify({ id: 77, method: 'item/commandExecution/requestApproval', params: { threadId } })); });
          mcp = await tools(fields);
        }
        await processMessage(mcp.call, request.params.input[0].text);
        turn.status = 'completed'; notify('turn/completed', { threadId, turn });
      } else throw new Error('Unexpected Codex method ' + request.method);
    })().catch(error => { console.error(error); process.exit(1); }); });
    socket.on('close', () => clients.delete(socket));
  });
  server.listen(path);
}
process.on('SIGTERM', () => process.exit(0));
