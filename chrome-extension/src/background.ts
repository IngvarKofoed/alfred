import type { WebSocketRequest, WebSocketResponse } from "./types.js";
import {
  getPageText,
  getPageHtml,
  getPageTitle,
  getLinks,
  getHeadings,
  clickElement,
  typeText,
  selectOption,
  scrollPage,
  hoverElement,
  querySelectorAll,
  evaluateJs,
  getFormFields,
  getElementBoundingRect,
} from "./content.js";

// --- WebSocket connection ---

// 127.0.0.1, not "localhost": the bridge binds to the IPv4 loopback, and "localhost" can
// resolve to ::1 (IPv6) on some systems, which would fail to connect. Port matches the
// worker's BRIDGE_WS_PORT default (ARCHITECTURE §8).
const WS_URL = "ws://127.0.0.1:7865";
const KEEPALIVE_INTERVAL_MS = 20_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

let ws: WebSocket | null = null;
let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connect(): void {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[alfred] Connected to server");
    reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    updateBadge(true);
    startKeepalive();
  };

  ws.onmessage = async (event) => {
    try {
      const request = JSON.parse(event.data as string) as WebSocketRequest;
      await handleCommand(request);
    } catch (err) {
      console.error("[alfred] Failed to handle message:", err);
    }
  };

  ws.onclose = () => {
    console.log("[alfred] Disconnected from server");
    ws = null;
    updateBadge(false);
    stopKeepalive();
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error("[alfred] WebSocket error:", err);
    // onclose will fire after this
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  console.log(`[alfred] Reconnecting in ${reconnectDelay}ms...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
    // Exponential backoff
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }, reconnectDelay);
}

function startKeepalive(): void {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ id: "ping", command: "ping", params: {} }));
    }
  }, KEEPALIVE_INTERVAL_MS);
}

function stopKeepalive(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

// --- Badge ---

function updateBadge(connected: boolean): void {
  const color = connected ? "#4CAF50" : "#9E9E9E";
  const text = connected ? "ON" : "";
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

// --- Restricted page detection ---

function isRestrictedUrl(url: string): boolean {
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("https://chrome.google.com/webstore") ||
    url.startsWith("https://chromewebstore.google.com") ||
    url.startsWith("about:") ||
    url.startsWith("edge://") ||
    url.startsWith("brave://")
  );
}

// --- Active tab helper ---

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab?.id) throw new Error("No active tab found");
  return tab;
}

// --- Content script execution helper ---

async function executeInTab<T>(
  tabId: number,
  func: (...args: unknown[]) => T,
  args: unknown[] = []
): Promise<T> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || isRestrictedUrl(tab.url)) {
    throw new Error(
      `Cannot access restricted page: ${tab.url ?? "unknown"}. Content scripts cannot run on chrome://, chrome-extension://, or Chrome Web Store pages.`
    );
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });

  if (!results || results.length === 0) {
    throw new Error("Script execution returned no results");
  }

  const result = results[0];
  if (result.error) {
    throw new Error(result.error.message ?? "Script execution failed");
  }

  return result.result as T;
}

// --- Send response ---

function sendResponse(response: WebSocketResponse): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(response));
  }
}

// --- Command handlers ---

type CommandHandler = (
  params: Record<string, unknown>
) => Promise<unknown>;

const handlers: Record<string, CommandHandler> = {
  // Ping
  async ping() {
    return { pong: true };
  },

  // Navigation
  async navigate(params) {
    const tab = await getActiveTab();
    const url = params.url as string;
    await chrome.tabs.update(tab.id!, { url });
    // Wait for the tab to finish loading
    await waitForTabLoad(tab.id!);
    const updated = await chrome.tabs.get(tab.id!);
    return { url: updated.url, title: updated.title };
  },

  async go_back() {
    const tab = await getActiveTab();
    await chrome.tabs.goBack(tab.id!);
    await waitForTabLoad(tab.id!);
    const updated = await chrome.tabs.get(tab.id!);
    return { url: updated.url, title: updated.title };
  },

  async go_forward() {
    const tab = await getActiveTab();
    await chrome.tabs.goForward(tab.id!);
    await waitForTabLoad(tab.id!);
    const updated = await chrome.tabs.get(tab.id!);
    return { url: updated.url, title: updated.title };
  },

  async reload() {
    const tab = await getActiveTab();
    await chrome.tabs.reload(tab.id!);
    await waitForTabLoad(tab.id!);
    const updated = await chrome.tabs.get(tab.id!);
    return { url: updated.url, title: updated.title };
  },

  async get_current_url() {
    const tab = await getActiveTab();
    return { url: tab.url, title: tab.title };
  },

  // Tab management
  async list_tabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      active: t.active,
      windowId: t.windowId,
    }));
  },

  async switch_tab(params) {
    const tabId = params.tabId as number;
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId!, { focused: true });
    return { id: tab.id, title: tab.title, url: tab.url };
  },

  async open_tab(params) {
    const url = params.url as string | undefined;
    const tab = await chrome.tabs.create({ url: url ?? undefined });
    if (url) {
      await waitForTabLoad(tab.id!);
      const updated = await chrome.tabs.get(tab.id!);
      return { id: updated.id, title: updated.title, url: updated.url };
    }
    return { id: tab.id, title: tab.title, url: tab.url };
  },

  async close_tab(params) {
    const tabId = params.tabId as number | undefined;
    if (tabId) {
      await chrome.tabs.remove(tabId);
      return { closed: tabId };
    }
    const tab = await getActiveTab();
    await chrome.tabs.remove(tab.id!);
    return { closed: tab.id };
  },

  // Page content
  async get_page_text() {
    const tab = await getActiveTab();
    return await executeInTab(tab.id!, getPageText);
  },

  async get_page_html(params) {
    const tab = await getActiveTab();
    const selector = params.selector as string | undefined;
    return await executeInTab(tab.id!, getPageHtml, [selector]);
  },

  async get_page_title() {
    const tab = await getActiveTab();
    return await executeInTab(tab.id!, getPageTitle);
  },

  async get_links() {
    const tab = await getActiveTab();
    return await executeInTab(tab.id!, getLinks);
  },

  async get_headings() {
    const tab = await getActiveTab();
    return await executeInTab(tab.id!, getHeadings);
  },

  // Interaction
  async click(params) {
    const tab = await getActiveTab();
    const selector = params.selector as string;
    return await executeInTab(tab.id!, clickElement, [selector]);
  },

  async type_text(params) {
    const tab = await getActiveTab();
    const selector = params.selector as string;
    const text = params.text as string;
    const clearFirst = (params.clearFirst as boolean) ?? true;
    return await executeInTab(tab.id!, typeText, [selector, text, clearFirst]);
  },

  async select_option(params) {
    const tab = await getActiveTab();
    const selector = params.selector as string;
    const value = params.value as string;
    return await executeInTab(tab.id!, selectOption, [selector, value]);
  },

  async scroll(params) {
    const tab = await getActiveTab();
    const direction = params.direction as string;
    const amount = params.amount as number | undefined;
    return await executeInTab(tab.id!, scrollPage, [direction, amount]);
  },

  async hover(params) {
    const tab = await getActiveTab();
    const selector = params.selector as string;
    return await executeInTab(tab.id!, hoverElement, [selector]);
  },

  // Page query
  async query_selector(params) {
    const tab = await getActiveTab();
    const selector = params.selector as string;
    const attributes = params.attributes as string[] | undefined;
    return await executeInTab(tab.id!, querySelectorAll, [selector, attributes]);
  },

  async evaluate_javascript(params) {
    const tab = await getActiveTab();
    const expression = params.expression as string;
    return await executeInTab(tab.id!, evaluateJs, [expression]);
  },

  async get_form_fields() {
    const tab = await getActiveTab();
    return await executeInTab(tab.id!, getFormFields);
  },

  // Screenshots
  async screenshot() {
    const tab = await getActiveTab();
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, {
      format: "png",
    });
    // dataUrl is "data:image/png;base64,..."
    const base64 = dataUrl.split(",")[1];
    return { data: base64, mimeType: "image/png" };
  },

  async screenshot_element(params) {
    const tab = await getActiveTab();
    const selector = params.selector as string;

    // Get element bounding rect
    const rect = await executeInTab(tab.id!, getElementBoundingRect, [selector]);

    // Capture the visible tab
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, {
      format: "png",
    });

    // Crop the screenshot to the element bounds using OffscreenCanvas
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);

    const dpr = await executeInTab<number>(
      tab.id!,
      () => window.devicePixelRatio
    );

    const cropX = Math.round(rect.x * dpr);
    const cropY = Math.round(rect.y * dpr);
    const cropW = Math.round(rect.width * dpr);
    const cropH = Math.round(rect.height * dpr);

    const canvas = new OffscreenCanvas(cropW, cropH);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    const croppedBlob = await canvas.convertToBlob({ type: "image/png" });
    const arrayBuffer = await croppedBlob.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    // Convert to base64
    let binary = "";
    for (let i = 0; i < uint8.length; i++) {
      binary += String.fromCharCode(uint8[i]);
    }
    const base64 = btoa(binary);

    return { data: base64, mimeType: "image/png" };
  },
};

// --- Wait for tab load ---

function waitForTabLoad(tabId: number, timeoutMs = 15_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      resolve(); // Resolve even on timeout — the page may still be usable
    }, timeoutMs);

    const listener = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo
    ) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.tabs.onRemoved.removeListener(removedListener);
        resolve();
      }
    };

    const removedListener = (removedTabId: number) => {
      if (removedTabId === tabId) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.tabs.onRemoved.removeListener(removedListener);
        reject(new Error("Tab was closed during navigation"));
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);

    // Check if already complete
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.tabs.onRemoved.removeListener(removedListener);
        resolve();
      }
    }).catch(() => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      reject(new Error("Tab not found"));
    });
  });
}

// --- Command dispatch ---

async function handleCommand(request: WebSocketRequest): Promise<void> {
  const handler = handlers[request.command];
  if (!handler) {
    sendResponse({
      id: request.id,
      success: false,
      error: `Unknown command: ${request.command}`,
    });
    return;
  }

  try {
    const data = await handler(request.params);
    sendResponse({ id: request.id, success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendResponse({ id: request.id, success: false, error: message });
  }
}

// --- Startup ---

connect();

// Reconnect when service worker wakes up
chrome.runtime.onStartup.addListener(() => {
  connect();
});

// Also try to connect when the extension is installed/updated
chrome.runtime.onInstalled.addListener(() => {
  connect();
});
