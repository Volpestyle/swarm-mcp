import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";

export type BrowserEndpoint = {
  host: string;
  port: number;
  baseUrl: string;
};

export type ManagedBrowserContext = {
  id: string;
  endpoint: BrowserEndpoint;
  profileDir: string;
  pid: number | null;
  startUrl: string;
};

export type BrowserTab = {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
  active: boolean;
};

export type BrowserSnapshotElement = {
  tag: string;
  role: string | null;
  text: string;
  selector: string;
};

export type BrowserSnapshot = {
  tabId: string;
  url: string;
  title: string;
  text: string;
  elements: BrowserSnapshotElement[];
  screenshotPath?: string;
  capturedAtUnixMs: number;
};

export type BrowserActionResult = {
  ok: boolean;
  target: string;
  tag?: string;
  text?: string;
  error?: string;
};

export type LaunchBrowserOptions = {
  id?: string;
  url?: string;
  chromePath?: string;
  port?: number;
  profileDir?: string;
  headless?: boolean;
  timeoutMs?: number;
};

export type SnapshotOptions = {
  tabId?: string;
  includeScreenshot?: boolean;
  screenshotPath?: string;
  maxTextLength?: number;
  maxElements?: number;
};

export type BrowserActionOptions = {
  tabId?: string;
};

type CdpTarget = {
  id?: string;
  type?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
};

type CdpVersion = {
  webSocketDebuggerUrl?: string;
  Browser?: string;
};

type CdpResponse<T> = {
  id: number;
  result?: T;
  error?: { message?: string; data?: string };
};

type RuntimeEvaluateResult = {
  result?: { value?: unknown; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

type ScreenshotResult = {
  data: string;
};

type WebSocketLike = {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
};

const DEFAULT_CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9222;
const DEFAULT_START_URL = "about:blank";
const DEFAULT_TIMEOUT_MS = 7_500;
const DEFAULT_MAX_TEXT_LENGTH = 24_000;
const DEFAULT_MAX_ELEMENTS = 120;

export function defaultBrowserRoot(): string {
  return (
    process.env.SWARM_BROWSER_ROOT ??
    join(homedir(), ".swarm-mcp", "browser-contexts")
  );
}

export function defaultBrowserArtifactsDir(): string {
  return (
    process.env.SWARM_BROWSER_ARTIFACTS ??
    join(homedir(), ".swarm-mcp", "artifacts", "browser")
  );
}

export function sanitizeArtifactName(value: string): string {
  const clean = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return clean || "browser-context";
}

export function normalizeCdpEndpoint(
  input: number | string | BrowserEndpoint = DEFAULT_PORT,
): BrowserEndpoint {
  if (typeof input === "number") {
    return {
      host: DEFAULT_HOST,
      port: input,
      baseUrl: `http://${DEFAULT_HOST}:${input}`,
    };
  }

  if (typeof input !== "string") return input;

  const raw = input.includes("://")
    ? input
    : /^[^/:]+:\d+$/.test(input)
      ? `http://${input}`
      : `http://${DEFAULT_HOST}:${input}`;
  const url = new URL(raw);
  const host = url.hostname || DEFAULT_HOST;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return {
    host,
    port,
    baseUrl: `${url.protocol}//${host}:${port}`,
  };
}

export function buildChromeLaunchArgs(options: {
  port: number;
  profileDir: string;
  url?: string;
  headless?: boolean;
}): string[] {
  const args = [
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${options.profileDir}`,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "--new-window",
  ];

  if (options.headless) {
    args.push("--headless=new", "--disable-gpu");
  }

  args.push(options.url ?? DEFAULT_START_URL);
  return args;
}

export async function launchManagedBrowser(
  options: LaunchBrowserOptions = {},
): Promise<ManagedBrowserContext> {
  const id = options.id ?? `browser-${Date.now().toString(36)}`;
  const startUrl = options.url ?? DEFAULT_START_URL;
  const port = options.port ?? (await findOpenPort(DEFAULT_PORT));
  const profileDir = options.profileDir ?? join(defaultBrowserRoot(), id);
  mkdirSync(profileDir, { recursive: true });

  const args = buildChromeLaunchArgs({
    port,
    profileDir,
    url: startUrl,
    headless: options.headless,
  });
  const child = spawn(options.chromePath ?? DEFAULT_CHROME_PATH, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const endpoint = normalizeCdpEndpoint(port);
  let onError: ((err: Error) => void) | null = null;
  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null =
    null;
  const earlyExit = new Promise<never>((_, reject) => {
    onError = (err) => reject(err);
    onExit = (code, signal) => {
      reject(
        new Error(
          `Chrome exited before CDP was ready: code=${code ?? "null"} signal=${signal ?? "null"}`,
        ),
      );
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });

  try {
    await Promise.race([
      waitForCdp(endpoint, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      earlyExit,
    ]);
  } catch (err) {
    child.kill();
    throw err;
  } finally {
    if (onError) child.off("error", onError);
    if (onExit) child.off("exit", onExit);
  }

  return {
    id,
    endpoint,
    profileDir,
    pid: child.pid ?? null,
    startUrl,
  };
}

export class BrowserBridge {
  readonly endpoint: BrowserEndpoint;

  constructor(endpoint: number | string | BrowserEndpoint = DEFAULT_PORT) {
    this.endpoint = normalizeCdpEndpoint(endpoint);
  }

  async version(): Promise<CdpVersion> {
    return fetchJson<CdpVersion>(`${this.endpoint.baseUrl}/json/version`);
  }

  async listTabs(): Promise<BrowserTab[]> {
    const targets = await fetchJson<CdpTarget[]>(
      `${this.endpoint.baseUrl}/json/list`,
    );
    let activeAssigned = false;
    return targets
      .filter((target) => (target.type ?? "page") === "page")
      .map((target) => {
        const active = !activeAssigned;
        activeAssigned = true;
        return {
          id: target.id ?? "",
          type: target.type ?? "page",
          url: target.url ?? "",
          title: target.title ?? "",
          webSocketDebuggerUrl: target.webSocketDebuggerUrl,
          active,
        };
      });
  }

  async openTab(url: string): Promise<BrowserTab> {
    const target = await fetchJson<CdpTarget>(
      `${this.endpoint.baseUrl}/json/new?${encodeURIComponent(url)}`,
      { method: "PUT" },
    );
    return {
      id: target.id ?? "",
      type: target.type ?? "page",
      url: target.url ?? url,
      title: target.title ?? "",
      webSocketDebuggerUrl: target.webSocketDebuggerUrl,
      active: true,
    };
  }

  async snapshot(options: SnapshotOptions = {}): Promise<BrowserSnapshot> {
    const { tab, session } = await this.sessionFor(options.tabId);
    try {
      const value = await session.evaluate(
        buildSnapshotExpression({
          maxTextLength: options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
          maxElements: options.maxElements ?? DEFAULT_MAX_ELEMENTS,
        }),
      );
      const page = normalizeSnapshotValue(value);
      const screenshotPath = options.includeScreenshot
        ? await this.captureScreenshot({
            tabId: tab.id,
            out: options.screenshotPath,
          })
        : undefined;

      return {
        tabId: tab.id,
        url: page.url || tab.url,
        title: page.title || tab.title,
        text: page.text,
        elements: page.elements,
        screenshotPath,
        capturedAtUnixMs: Math.floor(Date.now() / 1000),
      };
    } finally {
      session.close();
    }
  }

  async navigate(
    url: string,
    options: BrowserActionOptions = {},
  ): Promise<BrowserActionResult> {
    const { tab, session } = await this.sessionFor(options.tabId);
    try {
      await session.send("Page.enable");
      await session.send("Page.navigate", { url });
      return { ok: true, target: url, tag: "page", text: tab.title };
    } finally {
      session.close();
    }
  }

  async click(
    target: string,
    options: BrowserActionOptions = {},
  ): Promise<BrowserActionResult> {
    const { session } = await this.sessionFor(options.tabId);
    try {
      return normalizeActionResult(
        await session.evaluate(buildClickExpression(target)),
        target,
      );
    } finally {
      session.close();
    }
  }

  async typeText(
    target: string,
    text: string,
    options: BrowserActionOptions = {},
  ): Promise<BrowserActionResult> {
    const { session } = await this.sessionFor(options.tabId);
    try {
      return normalizeActionResult(
        await session.evaluate(buildTypeExpression(target, text)),
        target,
      );
    } finally {
      session.close();
    }
  }

  async captureScreenshot(options: {
    tabId?: string;
    out?: string;
  } = {}): Promise<string> {
    const { tab, session } = await this.sessionFor(options.tabId);
    try {
      await session.send("Page.enable");
      const result = await session.send<ScreenshotResult>(
        "Page.captureScreenshot",
        {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: true,
        },
      );
      const out =
        options.out ??
        join(
          defaultBrowserArtifactsDir(),
          `${sanitizeArtifactName(tab.title || tab.url || tab.id)}-${Date.now()}.png`,
        );
      mkdirSync(dirname(out), { recursive: true });
      await writeFile(out, Buffer.from(result.data, "base64"));
      return out;
    } finally {
      session.close();
    }
  }

  async evaluate(expression: string, options: BrowserActionOptions = {}): Promise<unknown> {
    const { session } = await this.sessionFor(options.tabId);
    try {
      return await session.evaluate(expression);
    } finally {
      session.close();
    }
  }

  private async sessionFor(tabId?: string): Promise<{
    tab: BrowserTab;
    session: CdpSession;
  }> {
    const tabs = await this.listTabs();
    const tab = tabId
      ? tabs.find((item) => item.id === tabId)
      : tabs.find((item) => item.active) ?? tabs[0];
    if (!tab) throw new Error("No browser tabs are available");
    if (!tab.webSocketDebuggerUrl) {
      throw new Error(`Browser tab ${tab.id} does not expose a CDP socket`);
    }
    return {
      tab,
      session: await CdpSession.connect(tab.webSocketDebuggerUrl),
    };
  }
}

export function stopManagedBrowser(context: ManagedBrowserContext): boolean {
  if (!context.pid) return false;
  try {
    process.kill(-context.pid, "SIGTERM");
    return true;
  } catch {
    try {
      process.kill(context.pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

class CdpSession {
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  private constructor(private readonly socket: WebSocketLike) {
    socket.onmessage = (event) => {
      void Promise.resolve(decodeSocketData(event.data))
        .then((raw) => this.handleMessage(raw))
        .catch((err) => this.rejectAll(asError(err)));
    };
    socket.onclose = () => this.rejectAll(new Error("CDP socket closed"));
    socket.onerror = (event) => {
      this.rejectAll(new Error(`CDP socket error: ${String(event)}`));
    };
  }

  static async connect(webSocketUrl: string): Promise<CdpSession> {
    const WebSocketImpl = (globalThis as unknown as {
      WebSocket?: new (url: string) => WebSocketLike;
    }).WebSocket;
    if (!WebSocketImpl) {
      throw new Error(
        "Browser bridge requires a runtime with global WebSocket support",
      );
    }

    const socket = new WebSocketImpl(webSocketUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out connecting to CDP socket")),
        DEFAULT_TIMEOUT_MS,
      );
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP socket error: ${String(event)}`));
      };
    });
    return new CdpSession(socket);
  }

  async send<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.socket.send(message);
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send<RuntimeEvaluateResult>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "Runtime.evaluate failed",
      );
    }
    return result.result?.value;
  }

  close(): void {
    if (this.socket.readyState === 1) this.socket.close();
  }

  private handleMessage(raw: string): void {
    const message = JSON.parse(raw) as CdpResponse<unknown>;
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new Error(message.error.data ?? message.error.message ?? "CDP error"),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function findOpenPort(preferred: number): Promise<number> {
  if (await canListen(preferred)) return preferred;
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, DEFAULT_HOST, () => {
      const address = server.address();
      server.close();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("Failed to allocate a browser debugging port"));
    });
  });
}

async function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, DEFAULT_HOST, () => {
      server.close(() => resolve(true));
    });
  });
}

async function waitForCdp(
  endpoint: BrowserEndpoint,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await fetchJson<CdpVersion>(`${endpoint.baseUrl}/json/version`, {
        timeoutMs: 750,
      });
      return;
    } catch (err) {
      lastError = err;
      await sleep(100);
    }
  }
  throw new Error(`Timed out waiting for Chrome CDP endpoint: ${lastError}`);
}

async function fetchJson<T>(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSnapshotExpression(options: {
  maxTextLength: number;
  maxElements: number;
}): string {
  return `(() => {
    const maxTextLength = ${JSON.stringify(options.maxTextLength)};
    const maxElements = ${JSON.stringify(options.maxElements)};
    const text = (document.body?.innerText || document.documentElement?.innerText || '').trim().slice(0, maxTextLength);
    const selectorFor = (el) => {
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      let node = el;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
        let part = node.localName;
        if (node.classList?.length) part += '.' + Array.from(node.classList).slice(0, 2).map((x) => CSS.escape(x)).join('.');
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.localName === node.localName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    };
    const candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],h1,h2,h3,label,[tabindex]'));
    const elements = candidates.slice(0, maxElements).map((el) => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      text: ((el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '') + '').trim().slice(0, 240),
      selector: selectorFor(el),
    }));
    return { url: location.href, title: document.title, text, elements };
  })()`;
}

function buildClickExpression(target: string): string {
  return `(() => {
    const target = ${JSON.stringify(target)};
    const find = () => {
      try {
        const selected = document.querySelector(target);
        if (selected) return selected;
      } catch (_) {}
      const wanted = target.trim().toLowerCase();
      const candidates = Array.from(document.querySelectorAll('button,a,input,textarea,select,[role="button"],label,[tabindex]'));
      return candidates.find((el) => {
        const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '').trim().toLowerCase();
        return text === wanted || text.includes(wanted);
      }) || null;
    };
    const el = find();
    if (!el) return { ok: false, target, error: 'target not found' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (typeof el.focus === 'function') el.focus();
    if (typeof el.click === 'function') el.click();
    return {
      ok: true,
      target,
      tag: el.tagName?.toLowerCase(),
      text: ((el.innerText || el.getAttribute('aria-label') || el.value || '') + '').trim().slice(0, 240),
    };
  })()`;
}

function buildTypeExpression(target: string, text: string): string {
  return `(() => {
    const target = ${JSON.stringify(target)};
    const text = ${JSON.stringify(text)};
    const find = () => {
      try {
        const selected = document.querySelector(target);
        if (selected) return selected;
      } catch (_) {}
      const wanted = target.trim().toLowerCase();
      const candidates = Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"],label,[role="textbox"]'));
      const label = candidates.find((el) => {
        const value = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().toLowerCase();
        return value === wanted || value.includes(wanted);
      });
      if (!label) return null;
      if (label.tagName?.toLowerCase() === 'label' && label.getAttribute('for')) {
        return document.getElementById(label.getAttribute('for'));
      }
      return label;
    };
    const el = find();
    if (!el) return { ok: false, target, error: 'target not found' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (typeof el.focus === 'function') el.focus();
    if ('value' in el) {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      return { ok: false, target, error: 'target is not typeable' };
    }
    return {
      ok: true,
      target,
      tag: el.tagName?.toLowerCase(),
      text: text.slice(0, 240),
    };
  })()`;
}

function normalizeSnapshotValue(value: unknown): {
  url: string;
  title: string;
  text: string;
  elements: BrowserSnapshotElement[];
} {
  if (!value || typeof value !== "object") {
    return { url: "", title: "", text: "", elements: [] };
  }
  const raw = value as {
    url?: unknown;
    title?: unknown;
    text?: unknown;
    elements?: unknown;
  };
  return {
    url: typeof raw.url === "string" ? raw.url : "",
    title: typeof raw.title === "string" ? raw.title : "",
    text: typeof raw.text === "string" ? raw.text : "",
    elements: Array.isArray(raw.elements)
      ? raw.elements.map(normalizeSnapshotElement)
      : [],
  };
}

function normalizeSnapshotElement(value: unknown): BrowserSnapshotElement {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    tag: typeof raw.tag === "string" ? raw.tag : "",
    role: typeof raw.role === "string" ? raw.role : null,
    text: typeof raw.text === "string" ? raw.text : "",
    selector: typeof raw.selector === "string" ? raw.selector : "",
  };
}

function normalizeActionResult(
  value: unknown,
  fallbackTarget: string,
): BrowserActionResult {
  if (!value || typeof value !== "object") {
    return { ok: false, target: fallbackTarget, error: "invalid action result" };
  }
  const raw = value as Record<string, unknown>;
  return {
    ok: raw.ok === true,
    target: typeof raw.target === "string" ? raw.target : fallbackTarget,
    tag: typeof raw.tag === "string" ? raw.tag : undefined,
    text: typeof raw.text === "string" ? raw.text : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
  };
}

function decodeSocketData(data: unknown): string | Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data && typeof data === "object" && "text" in data) {
    const blob = data as { text: () => Promise<string> };
    return blob.text();
  }
  return String(data);
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
