// Native pi event/sendMessage contract with its real managed extension and MCP.
const { pathToFileURL } = require('node:url');
const { appendFileSync } = require('node:fs');
const { process: processMessage } = require(process.env.SWARM_TEST_FIXTURES + '/native-worker-tools.cjs');
const args = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ type: 'pi_argv', args }) + '\n');
if (args.includes('--mode') || args.includes('--no-session')) throw new Error('Pi must use its real interactive session');
const handlers = new Map(), tools = new Map();
let queue = Promise.resolve();
const emit = async (name, data = {}) => { for (const handler of handlers.get(name) ?? []) await handler(data); };
const pi = {
  registerTool(tool) { tools.set(tool.name, tool); },
  on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  sendMessage(message, options) {
    if (!options.triggerTurn || options.deliverAs !== 'followUp') throw new Error('Delivery must preserve native input');
    queue = queue.then(async () => {
      await emit('agent_start');
      await processMessage((name, args) => tools.get(name).execute('fake-model-call', args), message.content);
      await emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] });
    }).catch(error => { console.error(error); process.exit(1); });
  },
};
void import(pathToFileURL(args[args.indexOf('--extension') + 1]).href).then(async module => { await module.default(pi); await emit('session_start'); });
setInterval(() => {}, 1000);
process.on('SIGTERM', () => { void emit('session_shutdown').finally(() => process.exit(0)); });
