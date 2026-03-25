import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import * as registry from "./registry"
import * as messages from "./messages"
import * as kv from "./kv"

let instanceId: string | null = null
let heartbeatTimer: Timer | null = null

const server = new McpServer({
  name: "swarm",
  version: "0.1.0",
})

// --- Instance Registry ---

server.tool(
  "register",
  "Register this opencode instance with the swarm. Call this first before using other tools.",
  {
    directory: z.string().describe("The project directory this instance is working in"),
    label: z.string().optional().describe("Optional friendly label for this instance"),
  },
  async ({ directory, label }) => {
    if (instanceId) {
      return { content: [{ type: "text", text: `Already registered as ${instanceId}` }] }
    }

    instanceId = registry.register(directory, label)

    // heartbeat every 10s to stay alive
    heartbeatTimer = setInterval(() => {
      if (instanceId) registry.heartbeat(instanceId)
    }, 10_000)

    return {
      content: [{ type: "text", text: JSON.stringify({ id: instanceId, directory, label }) }],
    }
  },
)

server.tool("list_instances", "List all currently active opencode instances in the swarm.", {}, async () => {
  const instances = registry.list()
  return {
    content: [{ type: "text", text: JSON.stringify(instances, null, 2) }],
  }
})

server.tool("whoami", "Get this instance's swarm ID and registration info.", {}, async () => {
  if (!instanceId) {
    return { content: [{ type: "text", text: "Not registered. Call register first." }] }
  }
  return { content: [{ type: "text", text: JSON.stringify({ id: instanceId }) }] }
})

// --- Messaging ---

server.tool(
  "send_message",
  "Send a message to a specific instance by ID.",
  {
    recipient: z.string().describe("The instance ID to send the message to"),
    content: z.string().describe("The message content"),
  },
  async ({ recipient, content }) => {
    if (!instanceId) {
      return { content: [{ type: "text", text: "Not registered. Call register first." }] }
    }
    messages.send(instanceId, recipient, content)
    return { content: [{ type: "text", text: `Message sent to ${recipient}` }] }
  },
)

server.tool(
  "broadcast",
  "Send a message to ALL other instances in the swarm.",
  {
    content: z.string().describe("The message content to broadcast"),
  },
  async ({ content }) => {
    if (!instanceId) {
      return { content: [{ type: "text", text: "Not registered. Call register first." }] }
    }
    messages.broadcast(instanceId, content)
    return { content: [{ type: "text", text: "Broadcast sent" }] }
  },
)

server.tool(
  "poll_messages",
  "Check for new incoming messages. Returns unread messages and marks them as read.",
  {
    limit: z.number().optional().default(50).describe("Max messages to return"),
  },
  async ({ limit }) => {
    if (!instanceId) {
      return { content: [{ type: "text", text: "Not registered. Call register first." }] }
    }
    const msgs = messages.poll(instanceId, limit)
    return {
      content: [{ type: "text", text: JSON.stringify(msgs, null, 2) }],
    }
  },
)

// --- Shared Key-Value Store ---

server.tool(
  "kv_get",
  "Get a value from the shared key-value store.",
  {
    key: z.string().describe("The key to look up"),
  },
  async ({ key }) => {
    const row = kv.get(key)
    if (!row) {
      return { content: [{ type: "text", text: `Key "${key}" not found` }] }
    }
    return { content: [{ type: "text", text: JSON.stringify(row) }] }
  },
)

server.tool(
  "kv_set",
  "Set a value in the shared key-value store. Visible to all instances.",
  {
    key: z.string().describe("The key to set"),
    value: z.string().describe("The value to store (use JSON for complex data)"),
  },
  async ({ key, value }) => {
    kv.set(key, value)
    return { content: [{ type: "text", text: `Set "${key}"` }] }
  },
)

server.tool(
  "kv_delete",
  "Delete a key from the shared key-value store.",
  {
    key: z.string().describe("The key to delete"),
  },
  async ({ key }) => {
    kv.del(key)
    return { content: [{ type: "text", text: `Deleted "${key}"` }] }
  },
)

server.tool(
  "kv_list",
  "List keys in the shared key-value store, optionally filtered by prefix.",
  {
    prefix: z.string().optional().describe("Optional key prefix to filter by"),
  },
  async ({ prefix }) => {
    const rows = kv.keys(prefix)
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
    }
  },
)

// --- Lifecycle ---

async function main() {
  const transport = new StdioServerTransport()

  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)
  process.on("exit", cleanup)

  await server.connect(transport)
}

function cleanup() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (instanceId) registry.deregister(instanceId)
  instanceId = null
}

main().catch((err) => {
  console.error("swarm-mcp fatal:", err)
  process.exit(1)
})
