import { getAccessToken, login } from './auth.js';

let isRecording = false;
let recordingStartTime = null;
let isPaused = false;
let cachedCountry = "Unknown";
let headerCache = new Map(); // Store headers by URL during recording
let pendingRequests = new Map(); // requestId -> data (for advanced tracking)
// CDP state
let cdpAttachedTabs = new Map(); // tabId -> true
let cdpRequests = new Map(); // cdpRequestId -> { mapped data }
let cdpListenerAdded = false;

// Detect country on startup
async function updateCountryCache() {
  try {
    const res = await fetch("https://api.country.is/");
    const data = await res.json();
    if (data && data.country) {
      const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
      cachedCountry = displayNames.of(data.country);
    }
  } catch (e) {
    console.error("Failed to detect country:", e);
  }
}
updateCountryCache();

// Mask sensitive headers
function maskHeaders(headers) {
  if (!headers) return headers;
  const sensitive = [
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key",
  ];
  const masked = {};
  for (let key in headers) {
    if (sensitive.includes(key.toLowerCase())) {
      masked[key] = "***** Auto-filtered";
    } else {
      masked[key] = headers[key];
    }
  }
  return masked;
}

// Convert webRequest format to simple object
function flattenHeaders(headersArray) {
  const obj = {};
  if (!headersArray) return obj;
  headersArray.forEach((h) => {
    obj[h.name] = h.value;
  });
  return obj;
}

// 🛠️ Helper: Determine Category (Fetch, JS, CSS, etc.)
function determineResourceType(url, initiator, type) {
  if (type === "xmlhttprequest" || type === "fetch") return "Fetch/XHR";
  if (type === "script") return "JS";
  if (type === "stylesheet") return "CSS";
  if (type === "image") return "Img";
  if (type === "font") return "Font";
  if (type === "media") return "Media";
  if (type === "main_frame" || type === "sub_frame") return "Doc";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

// Map CDP network type to resource type (mirrors DevTools)
function mapCdpTypeToResourceType(cdpType) {
  const t = (cdpType || 'other').toLowerCase();
  if (t === 'fetch' || t === 'xmlhttprequest') return 'Fetch/XHR';
  if (t === 'script') return 'JS';
  if (t === 'stylesheet') return 'CSS';
  if (t === 'image') return 'Img';
  if (t === 'font') return 'Font';
  if (t === 'media') return 'Media';
  if (t === 'document') return 'Doc';
  if (t === 'websocket') return 'WS';
  if (t === 'manifest') return 'Manifest';
  if (t === 'ping' || t === 'beacon' || t === 'csp-violation-report') return 'Ping';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Check if resource type is static (excludes XHR, fetch, ws, ping)
function isStaticResourceType(type) {
  const t = String(type || '').toLowerCase();
  return !['fetch/xhr', 'ws', 'websocket', 'ping', 'beacon'].includes(t);
}


// webRequest Listeners (Advanced Tracker)
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!isRecording) return;
    pendingRequests.set(details.requestId, {
      id: details.requestId,
      url: details.url,
      method: details.method,
      type: details.type,
      startTime: Date.now(),
      tabId: details.tabId,
      frameId: details.frameId,
      initiator: details.initiator,
    });
  },
  { urls: ["<all_urls>"] },
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!isRecording) return;
    const req = pendingRequests.get(details.requestId);
    if (!req) return;
    req.requestHeaders = maskHeaders(flattenHeaders(details.requestHeaders));

    // Legacy headerCache for backward compat/other tabs
    if (!headerCache.has(details.url))
      headerCache.set(details.url, { request: {}, response: {} });
    headerCache.get(details.url).request = req.requestHeaders;
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"],
);

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (!isRecording) return;
    const req = pendingRequests.get(details.requestId);
    if (!req) return;

    req.status = details.statusCode;
    req.responseHeaders = maskHeaders(flattenHeaders(details.responseHeaders));
    req.fromCache = details.fromCache;
    req.ip = details.ip;

    // Extract size from Content-Length
    const cl = details.responseHeaders.find(
      (h) => h.name.toLowerCase() === "content-length",
    );
    if (cl) req.size = parseInt(cl.value);

    // Legacy trace IDs
    const traceHeaderNames = [
      "x-trace-id",
      "x-request-id",
      "traceparent",
      "x-amzn-trace-id",
      "cf-ray",
      "x-b3-traceid",
    ];
    const rawHeaders = flattenHeaders(details.responseHeaders);
    req.traceIds = {};
    traceHeaderNames.forEach((h) => {
      if (rawHeaders[h]) req.traceIds[h] = rawHeaders[h];
    });

    // Update Legacy HeaderCache
    if (headerCache.has(details.url)) {
      const entry = headerCache.get(details.url);
      entry.response = req.responseHeaders;
      entry.status = req.status;
      if (Object.keys(req.traceIds).length > 0) entry.traceIds = req.traceIds;
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"],
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!isRecording) {
      pendingRequests.delete(details.requestId);
      return;
    }
    const req = pendingRequests.get(details.requestId);
    if (!req) return;

    const endTime = Date.now();
    const duration = endTime - req.startTime;

    // Final check for size in onCompleted (some servers send it late)
    if (!req.size || req.size === 0) {
      const cl = details.responseHeaders?.find(
        (h) => h.name.toLowerCase() === "content-length",
      );
      if (cl) req.size = parseInt(cl.value);
    }

    const logEntry = {
      method: req.method,
      url: req.url,
      status: req.status || details.statusCode || 200,
      type: determineResourceType(req.url, req.initiator, req.type),
      size: req.fromCache ? -1 : req.size || 0,
      duration: duration,
      requestHeaders: req.requestHeaders,
      responseHeaders: req.responseHeaders,
      traceIds: req.traceIds,
      isStatic: !["xmlhttprequest", "fetch"].includes(req.type),
      fromCache: req.fromCache,
      frameContext:
        req.frameId === 0 ? "Main Frame" : `Sub Frame (${req.frameId})`,
      startTimeAbs: req.startTime,
    };

    appendLog("NETWORK", logEntry);

    // 🧹 Memory Cleanup
    pendingRequests.delete(details.requestId);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"],
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (!isRecording) {
      pendingRequests.delete(details.requestId);
      return;
    }
    const req = pendingRequests.get(details.requestId);
    if (req) {
      appendLog("NETWORK", {
        method: req.method,
        url: req.url,
        status: 0,
        type: determineResourceType(req.url, req.initiator, req.type),
        message: details.error,
        startTimeAbs: req.startTime,
        duration: Date.now() - req.startTime,
      });
    }
    pendingRequests.delete(details.requestId);
  },
  { urls: ["<all_urls>"] },
);

// Initialize log storage
async function resetLogs() {
  await chrome.storage.local.set({
    sessionLogs: { console: [], network: [], actions: [], backend: [] },
  });
}

chrome.runtime.onInstalled.addListener(() => {
  resetLogs();
  // Setup alarm for auto deletion check
  chrome.alarms.create("cleanupDrive", { periodInMinutes: 1440 }); // every day
});

// Alarm Listener
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "cleanupDrive") {
    // You would fetch files from drive, check their date and status, and delete old ones
    console.log("Cleanup Drive triggered. Implementation needed.");
  }
});

// Log processing queue to prevent race conditions
let logQueue = [];
let isProcessingQueue = false;

async function appendLog(type, payload) {
  logQueue.push({ type, payload });
  processQueue();
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  while (logQueue.length > 0) {
    const { type, payload } = logQueue.shift();
    await performAppendLog(type, payload);
  }
  isProcessingQueue = false;
}

async function performAppendLog(type, payload) {
  const data = await chrome.storage.local.get(["sessionLogs"]);
  const logs = data.sessionLogs || {
    console: [],
    network: [],
    actions: [],
    backend: [],
  };

  if (recordingStartTime) {
    const now = Date.now();
    const elapsedMs = payload.startTimeAbs
      ? payload.startTimeAbs - recordingStartTime
      : now - recordingStartTime;
    payload.relativeMs = Math.max(0, elapsedMs); // Ensure not negative

    const elapsedSecs = Math.floor(payload.relativeMs / 1000);
    const m = Math.floor(elapsedSecs / 60)
      .toString()
      .padStart(2, "0");
    const s = (elapsedSecs % 60).toString().padStart(2, "0");
    payload.time = `[${m}:${s}] `;
  } else {
    // If recording started but startTime not yet set (during picker)
    payload.relativeMs = 0;
    payload.time = `[00:00] `;
  }

  if (type === "CONSOLE") logs.console.push(payload);
  else if (type === "ACTIONS") {
    logs.actions.push(payload);

    // 🧭 URL TIMELINE TRACKING
    if (payload.event && payload.event.includes("Navigated")) {
      const timeMs = payload.relativeMs || 0;
      if (!logs.info) logs.info = {};
      if (!logs.info.urlTimeline) logs.info.urlTimeline = [];

      const lastEntry = logs.info.urlTimeline[logs.info.urlTimeline.length - 1];
      const currentUrl = payload.element;

      // Allow if it's the first entry, or the URL is different,
      // or it's been more than 500ms (to catch refreshes/redirects)
      if (
        !lastEntry ||
        lastEntry.url !== currentUrl ||
        timeMs - (lastEntry.timeMs || 0) > 500
      ) {
        logs.info.urlTimeline.push({
          time: Math.floor(timeMs / 1000),
          timeMs: timeMs,
          url: currentUrl,
        });

        // Update current URL in info
        logs.info.url = currentUrl;
      }
    }
  } else if (type === "BACKEND") logs.backend.push(payload);
  else if (type === "NETWORK") {
    if (payload.isMonkeyPatched) {
      const existing = logs.network.find(
        (n) =>
          n.url === payload.url &&
          Math.abs(n.relativeMs - payload.relativeMs) < 2000,
      );
      if (existing) {
        if (payload.requestBody)
          existing.requestBody = payload.requestBody;
        if (payload.payloadText)
          existing.payloadText = payload.payloadText;
        if (payload.parsedPayload)
          existing.parsedPayload = payload.parsedPayload;
        if (payload.payloadType)
          existing.payloadType = payload.payloadType;
        if (payload.responseBody)
          existing.responseBody = payload.responseBody;
        if (payload.requestHeaders)
          existing.requestHeaders = {
            ...existing.requestHeaders,
            ...payload.requestHeaders,
          };
        if (payload.responseHeaders)
          existing.responseHeaders = {
            ...existing.responseHeaders,
            ...payload.responseHeaders,
          };
        await chrome.storage.local.set({ sessionLogs: logs });
        return;
      }
    }
    logs.network.push(payload);
    const status = payload.status;
    if (status && typeof status === "number" && status >= 400) {
      const traceInfo = payload.traceIds
        ? Object.entries(payload.traceIds)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" | ")
        : "";
      logs.backend.push({
        time: payload.time,
        type: "API Failure",
        message: `${payload.method} ${payload.url} → ${status}`,
        stack: traceInfo ? `Trace IDs:\n${traceInfo}` : "",
        source: payload.url,
        relativeMs: payload.relativeMs,
      });
    }
  }

  if (logs.console.length > 500) logs.console.shift();
  if (logs.network.length > 500) logs.network.shift();
  if (logs.actions.length > 500) logs.actions.shift();
  if (logs.backend && logs.backend.length > 500) logs.backend.shift();

  await chrome.storage.local.set({ sessionLogs: logs });
}

// Ensure offscreen document exists
async function setupOffscreenDocument(path) {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(path)],
  });

  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: path,
    reasons: ["USER_MEDIA"],
    justification: "Recording screen for T.R.A.C.E report",
  });
}

// ---------------- CDP / chrome.debugger Integration ----------------
async function attachCDPToTab(tabId) {
  if (!chrome.debugger) {
    console.warn('[BERIBUG][CDP] chrome.debugger not available');
    return;
  }
  if (cdpAttachedTabs.has(tabId)) return;

  const debuggee = { tabId: Number(tabId) };
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(debuggee, '1.3', async () => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.error('[BERIBUG][CDP] attach error', err.message);
        return reject(err);
      }
      console.log('[BERIBUG][CDP] attached to tab', tabId);
      cdpAttachedTabs.set(tabId, true);

      // Enable Network domain
      chrome.debugger.sendCommand(debuggee, 'Network.enable', {}, (res) => {
        if (chrome.runtime.lastError) console.warn('[BERIBUG][CDP] Network.enable failed', chrome.runtime.lastError.message);
        else console.log('[BERIBUG][CDP] Network enabled');
      });

      // Set up event listener once
      // Note: listener is global; filter by tabId using debuggee
      if (!cdpListenerAdded) {
        chrome.debugger.onEvent.addListener(handleCdpEvent);
        cdpListenerAdded = true;
      }

      resolve();
    });
  });
}

function parseRequestCookies(headers) {
  const cookies = [];
  if (!headers) return cookies;
  let cookieHeader = "";
  for (const k in headers) {
    if (k.toLowerCase() === "cookie") {
      cookieHeader = headers[k];
      break;
    }
  }
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach((pair) => {
    const parts = pair.split("=");
    if (parts.length >= 1) {
      const name = parts[0].trim();
      const value = parts.slice(1).join("=").trim();
      if (name) {
        cookies.push({ name, value });
      }
    }
  });
  return cookies;
}

function parseResponseCookies(headers) {
  const cookies = [];
  const setCookieHeaders = [];
  if (!headers) return { cookies, setCookieHeaders };
  let setCookieHeader = "";
  for (const k in headers) {
    if (k.toLowerCase() === "set-cookie") {
      setCookieHeader = headers[k];
      break;
    }
  }
  if (!setCookieHeader) return { cookies, setCookieHeaders };
  // CDP joins multiple headers with \n
  const lines = setCookieHeader.split("\n");
  lines.forEach((line) => {
    if (!line.trim()) return;
    setCookieHeaders.push(line.trim());
    const parts = line.split(";")[0].split("=");
    if (parts.length >= 1) {
      const name = parts[0].trim();
      const value = parts.slice(1).join("=").trim();
      // Parse domain/path/etc. from line
      let domain = "";
      let path = "";
      line.split(";").slice(1).forEach((part) => {
        const kv = part.trim().split("=");
        const key = kv[0].trim().toLowerCase();
        const val = kv.slice(1).join("=").trim();
        if (key === "domain") domain = val;
        if (key === "path") path = val;
      });
      if (name) {
        cookies.push({ name, value, domain, path });
      }
    }
  });
  return { cookies, setCookieHeaders };
}

function handleCdpEvent(debuggeeId, method, params) {
  try {
    if (!debuggeeId || !debuggeeId.tabId) return;
    const tabId = debuggeeId.tabId;
    if (!cdpAttachedTabs.has(tabId)) return;

    // Interested events: Network.requestWillBeSent, Network.responseReceived, Network.loadingFinished, Network.loadingFailed
    if (method === 'Network.requestWillBeSent') {
      const r = params;
      const requestId = r.requestId;
      const entry = {
        requestId,
        url: r.request.url,
        method: r.request.method,
        headers: r.request.headers || {},
        timestamp: r.timestamp,
        initiator: r.initiator || {},
        frameId: r.frameId,
        type: r.type || 'other',
        requestPostData: null, // Will be filled async
        requestCookies: parseRequestCookies(r.request.headers || {}),
      };
      cdpRequests.set(requestId, entry);
      console.log(`[CDP REQUEST] requestId=${requestId} url=${entry.url} method=${entry.method}`);

      // Try to fetch request post data IMMEDIATELY (store in map)
      chrome.debugger.sendCommand({ tabId }, 'Network.getRequestPostData', { requestId }, (resp) => {
        if (chrome.runtime.lastError) {
          console.warn('[CDP] getRequestPostData failed', requestId, chrome.runtime.lastError.message);
        } else {
          const postData = resp && (resp.postData || resp.binaryData) ? (resp.postData || resp.binaryData) : null;
          if (cdpRequests.has(requestId)) {
            const mapEntry = cdpRequests.get(requestId);
            mapEntry.requestPostData = postData;
            console.log(`[CDP REQUEST] requestId=${requestId} hasPostData=${!!postData} postDataLength=${postData ? postData.length : 0}`);
            
            // Update existing log entry in storage if it exists
            if (isRecording && mapEntry.logId) {
              chrome.storage.local.get(['sessionLogs'], (data) => {
                const logs = data.sessionLogs || { network: [] };
                const logIdx = logs.network.findIndex(n => n.requestId === requestId);
                if (logIdx >= 0) {
                  logs.network[logIdx].payloadText = postData;
                  logs.network[logIdx].requestBody = postData;
                  chrome.storage.local.set({ sessionLogs: logs });
                }
              });
            }
          }
        }
      });

      // Append provisional entry to logs IMMEDIATELY (so UI shows request early with whatever payload we have)
      if (isRecording) {
        const logEntry = {
          requestId: requestId,
          method: entry.method,
          url: entry.url,
          status: 'PENDING',
          type: mapCdpTypeToResourceType(entry.type),
          requestHeaders: maskHeaders(entry.headers),
          payloadText: null, // Will be updated when available
          isMonkeyPatched: false,
          fromCDP: true,
          startTimeAbs: Date.now(),
          initiator: entry.initiator,
          initiatorType: entry.initiator.type,
          initiatorUrl: entry.initiator.url,
          stackTrace: entry.initiator.stack,
          requestCookies: entry.requestCookies,
        };
        appendLog('NETWORK', logEntry);
        // Mark in cdpRequests that we appended this entry
        entry.logId = true;
      }
    } else if (method === 'Network.responseReceived') {
      const r = params;
      const requestId = r.requestId;
      const existing = cdpRequests.get(requestId) || {};
      
      const respCookiesInfo = parseResponseCookies(r.response.headers || {});
      const timing = r.response.timing || null;
      const receiveHeadersEnd = timing ? timing.receiveHeadersEnd : null;
      
      existing.response = {
        status: r.response.status,
        headers: r.response.headers,
        mimeType: r.response.mimeType,
        encoded: r.response.encodedDataLength,
        responseCookies: respCookiesInfo.cookies,
        setCookieHeaders: respCookiesInfo.setCookieHeaders,
        timing: timing,
        receiveHeadersEnd: receiveHeadersEnd,
        responseEnd: receiveHeadersEnd, // fallback
      };
      cdpRequests.set(requestId, existing);
      console.log(`[CDP RESPONSE] requestId=${requestId} status=${existing.response.status}`);

      // Update existing log entry status
      if (isRecording) {
        chrome.storage.local.get(['sessionLogs'], (data) => {
          const logs = data.sessionLogs || { network: [] };
          const logIdx = logs.network.findIndex(n => n.requestId === requestId);
          if (logIdx >= 0) {
            logs.network[logIdx].status = existing.response.status;
            logs.network[logIdx].responseHeaders = maskHeaders(existing.response.headers);
            logs.network[logIdx].mimeType = existing.response.mimeType;
            logs.network[logIdx].size = existing.response.encoded;
            logs.network[logIdx].responseCookies = existing.response.responseCookies;
            logs.network[logIdx].setCookieHeaders = existing.response.setCookieHeaders;
            logs.network[logIdx].timing = existing.response.timing;
            logs.network[logIdx].receiveHeadersEnd = existing.response.receiveHeadersEnd;
            logs.network[logIdx].responseEnd = existing.response.responseEnd;
            chrome.storage.local.set({ sessionLogs: logs });
          }
        });
      }
    } else if (method === 'Network.loadingFinished') {
      const r = params;
      const requestId = r.requestId;
      const existing = cdpRequests.get(requestId) || {};
      
      console.log(`[CDP FINISH] requestId=${requestId} encodedDataLength=${r.encodedDataLength}`);

      // Try to get response body
      chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId }, (resp) => {
        let responseBody = null;
        if (chrome.runtime.lastError) {
          console.warn('[CDP] getResponseBody failed', requestId, chrome.runtime.lastError.message);
        } else {
          responseBody = resp && typeof resp.body !== 'undefined' ? resp.body : null;
          console.log(`[CDP FINISH] requestId=${requestId} hasResponseBody=${!!responseBody}`);
        }

        const duration = existing.timestamp 
          ? Math.round((r.timestamp - existing.timestamp) * 1000)
          : (existing.startTimeAbs ? Date.now() - existing.startTimeAbs : 0);

        // Update existing log entry with response body and other completion info
        if (isRecording) {
          chrome.storage.local.get(['sessionLogs'], (data) => {
            const logs = data.sessionLogs || { network: [] };
            const logIdx = logs.network.findIndex(n => n.requestId === requestId);
            if (logIdx >= 0) {
              if (responseBody !== null) {
                logs.network[logIdx].responseBody = responseBody;
              }
              logs.network[logIdx].status = existing.response ? existing.response.status : 200;
              logs.network[logIdx].isStatic = isStaticResourceType(logs.network[logIdx].type);
              logs.network[logIdx].fromCache = r.encodedDataLength === 0;
              logs.network[logIdx].duration = duration;
              logs.network[logIdx].encodedDataLength = r.encodedDataLength;
              if (!logs.network[logIdx].size || logs.network[logIdx].size === 0) {
                logs.network[logIdx].size = r.encodedDataLength;
              }
              chrome.storage.local.set({ sessionLogs: logs });
            }
          });
        }

        // Cleanup request mapping to avoid memory growth
        cdpRequests.delete(requestId);
      });
    } else if (method === 'Network.loadingFailed') {
      const r = params;
      const requestId = r.requestId;
      console.warn('[CDP] loadingFailed', requestId, r.errorText);
      const existing = cdpRequests.get(requestId) || {};
      
      // Update existing log entry or append if not exists
      if (isRecording) {
        chrome.storage.local.get(['sessionLogs'], (data) => {
          const logs = data.sessionLogs || { network: [] };
          let logIdx = logs.network.findIndex(n => n.requestId === requestId);
          if (logIdx >= 0) {
            logs.network[logIdx].status = 0;
            logs.network[logIdx].message = r.errorText;
          } else {
            // If we never appended this before, append now
            appendLog('NETWORK', {
              requestId: requestId,
              method: existing.method || 'GET',
              url: existing.url || '(unknown)',
              status: 0,
              type: existing.type || 'other',
              message: r.errorText,
              fromCDP: true,
              startTimeAbs: Date.now(),
            });
          }
          chrome.storage.local.set({ sessionLogs: logs });
        });
      }
      cdpRequests.delete(requestId);
    }
  } catch (e) {
    console.error('[CDP] handle event error', e && e.message);
  }
}


// Global accessor for review page to fetch
let pendingVideoBase64 = null;

// ==================== SCREENSHOT PIPELINE (MV3 SERVICE WORKER) ====================
// Flow:
// - Popup sends START_SCREENSHOT {mode, tabId}
// - For area: content script shows overlay, then sends SCREENSHOT_AREA_RESULT
// - For full/scroll: background scrolls tab + captureVisibleTab segments, stitches
// - Result is stored in chrome.storage.local.pendingScreenshot then screenshot.html is opened

let activeScreenshotFlow = null; // { mode, tabId, startedAt }

const CAPTURE_MIN_INTERVAL_MS = 1100; // be conservative to avoid quota
const __lastCaptureAtByWindowId = new Map();

function openScreenshotError(message) {
  const msg = encodeURIComponent(String(message || "Screenshot gagal"));
  chrome.tabs.create({
    url: chrome.runtime.getURL(`html/screenshot.html#error=${msg}`),
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isInjectableUrl(url) {
  if (!url) return false;
  return !(
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:")
  );
}

async function ensureContentScript(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isInjectableUrl(tab.url)) {
    throw new Error(
      "Halaman ini tidak mengizinkan screenshot dari extension (chrome://, edge://, atau halaman extension).",
    );
  }

  try {
    await chrome.tabs.sendMessage(tabId, { action: "BERIBUG_PING" });
    return;
  } catch (_) {
    // Likely after extension reload or tab not refreshed.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["js/content.js"],
    });
    await sleep(50);
    await chrome.tabs.sendMessage(tabId, { action: "BERIBUG_PING" });
  }
}

async function ensureTabActive(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  return tab;
}

async function throttleCapture(windowId) {
  const last = __lastCaptureAtByWindowId.get(windowId) || 0;
  const now = Date.now();
  const wait = CAPTURE_MIN_INTERVAL_MS - (now - last);
  if (wait > 0) await sleep(wait);
}

async function captureVisibleTabForTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  // captureVisibleTab captures the active tab in a window.
  // Ensure our target tab is active before calling.
  await chrome.tabs.update(tabId, { active: true });

  const windowId = tab.windowId;
  let attempt = 0;
  let backoff = CAPTURE_MIN_INTERVAL_MS;
  while (true) {
    await throttleCapture(windowId);
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: "png",
      });
      __lastCaptureAtByWindowId.set(windowId, Date.now());
      return dataUrl;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      // Typical error: "This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota."
      if (
        /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(msg) &&
        attempt < 5
      ) {
        attempt += 1;
        await sleep(backoff);
        backoff = Math.min(backoff * 1.6, 4000);
        continue;
      }
      throw e;
    }
  }
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return await res.blob();
}

async function blobToDataUrl(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  return `data:${blob.type};base64,${base64}`;
}

async function cropDataUrl(dataUrl, cropPx) {
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("OffscreenCanvas not available for cropping");
  }
  const blob = await dataUrlToBlob(dataUrl);
  const bmp = await createImageBitmap(blob);

  const x = Math.max(0, Math.min(cropPx.x, bmp.width - 1));
  const y = Math.max(0, Math.min(cropPx.y, bmp.height - 1));
  const w = Math.max(1, Math.min(cropPx.width, bmp.width - x));
  const h = Math.max(1, Math.min(cropPx.height, bmp.height - y));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, x, y, w, h, 0, 0, w, h);
  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  return await blobToDataUrl(outBlob);
}

async function stitchVerticalDataUrls(
  dataUrls,
  segmentHeightsPx,
  totalWidthPx,
  totalHeightPx,
) {
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("OffscreenCanvas not available for stitching");
  }
  const canvas = new OffscreenCanvas(totalWidthPx, totalHeightPx);
  const ctx = canvas.getContext("2d");

  let offsetY = 0;
  for (let i = 0; i < dataUrls.length; i++) {
    const blob = await dataUrlToBlob(dataUrls[i]);
    const bmp = await createImageBitmap(blob);
    const drawH = segmentHeightsPx[i];
    ctx.drawImage(
      bmp,
      0,
      0,
      totalWidthPx,
      drawH,
      0,
      offsetY,
      totalWidthPx,
      drawH,
    );
    offsetY += drawH;
  }

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  return await blobToDataUrl(outBlob);
}

async function openScreenshotPreview(meta, imageDataUrl) {
  await chrome.storage.local.set({
    pendingScreenshot: {
      meta,
      imageDataUrl,
      createdAt: Date.now(),
    },
  });
  await chrome.tabs.create({
    url: chrome.runtime.getURL("html/screenshot.html"),
  });
}

// Simple viewport capture - take screenshot of visible area only, no scrolling
async function captureViewport(tabId) {
  await ensureTabActive(tabId);
  await ensureContentScript(tabId);

  // Get viewport metrics for debugging
  const metrics = await chrome.tabs.sendMessage(tabId, {
    action: "SCREENSHOT_GET_METRICS",
  });
  const dpr = metrics?.devicePixelRatio || 1;
  const expectedWidthPx = (metrics?.viewportWidth || 0) * dpr;
  const expectedHeightPx = (metrics?.viewportHeight || 0) * dpr;

  console.log(
    `[captureViewport] Expected: ${expectedWidthPx}x${expectedHeightPx}px (DPR: ${dpr})`,
  );

  const dataUrl = await captureVisibleTabForTab(tabId);

  // Validate captured image dimensions
  try {
    const blob = await dataUrlToBlob(dataUrl);
    const bitmap = await createImageBitmap(blob);
    console.log(`[captureViewport] Actual: ${bitmap.width}x${bitmap.height}px`);

    if (bitmap.height < expectedHeightPx * 0.8) {
      console.warn(
        `[captureViewport] Viewport may be cropped: ${bitmap.height}px vs ${expectedHeightPx}px expected`,
      );
    }
  } catch (e) {
    console.log(`[captureViewport] Could not validate: ${e?.message}`);
  }

  const meta = {
    type: "screenshot",
    mode: "full",
    tabId,
    capturedAt: new Date().toISOString(),
  };
  await openScreenshotPreview(meta, dataUrl);
}

async function getLiveScreenshotMetrics(tabId) {
  const metrics = await chrome.tabs.sendMessage(tabId, {
    action: "SCREENSHOT_GET_METRICS",
  });
  if (!metrics || !metrics.viewportHeight) {
    throw new Error("Tidak bisa mengambil ukuran halaman");
  }
  return metrics;
}

async function waitForScrollStable(tabId, expectedY = null, options = {}) {
  const res = await chrome.tabs.sendMessage(tabId, {
    action: "SCREENSHOT_WAIT_STABLE",
    expectedY,
    tolerance: options.tolerance ?? 2,
    stableFrames: options.stableFrames ?? 3,
    settleFrames: options.settleFrames ?? 2,
    maxWaitMs: options.maxWaitMs ?? 1800,
  });

  if (!res || !res.ok || !res.metrics) {
    throw new Error(res?.error || "Gagal menunggu scroll stabil");
  }

  return res.metrics;
}

async function ensureTopAndCaptureFirstFrame(tabId, interactiveUi) {
  let topMetrics = null;

  for (let attempt = 1; attempt <= 6; attempt++) {
    await chrome.tabs.sendMessage(tabId, {
      action: "SCREENSHOT_SCROLL_TO",
      y: 0,
    });
    topMetrics = await waitForScrollStable(tabId, 0, {
      tolerance: 2,
      stableFrames: 4,
      settleFrames: 3,
      maxWaitMs: 2200,
    });

    if (Math.abs(topMetrics.scrollY || 0) <= 2) {
      break;
    }

    if (attempt === 6) {
      throw new Error(
        "Tidak bisa memulai capture dari paling atas halaman secara stabil.",
      );
    }
  }

  if (interactiveUi) {
    try {
      await chrome.tabs.sendMessage(tabId, {
        action: "SCREENSHOT_HIDE_SCROLL_UI",
      });
    } catch (_) {}
  }
  await sleep(40);
  const firstDataUrl = await captureVisibleTabForTab(tabId);
  if (interactiveUi) {
    try {
      await chrome.tabs.sendMessage(tabId, {
        action: "SCREENSHOT_SHOW_SCROLL_UI",
      });
    } catch (_) {}
  }

  return {
    dataUrl: firstDataUrl,
    scrollY: topMetrics.scrollY || 0,
    viewportHeight: topMetrics.viewportHeight,
    scrollHeight: topMetrics.scrollHeight,
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rgbDiff(
  dataA,
  dataB,
  width,
  height,
  rowOffsetB,
  sampleStepX = 6,
  sampleStepY = 3,
) {
  let score = 0;
  let count = 0;
  const stride = width * 4;

  for (let y = 0; y < height; y += sampleStepY) {
    const rowA = y * stride;
    const rowB = (rowOffsetB + y) * stride;
    for (let x = 0; x < width; x += sampleStepX) {
      const idxA = rowA + x * 4;
      const idxB = rowB + x * 4;

      score += Math.abs(dataA[idxA] - dataB[idxB]);
      score += Math.abs(dataA[idxA + 1] - dataB[idxB + 1]);
      score += Math.abs(dataA[idxA + 2] - dataB[idxB + 2]);
      count += 3;
    }
  }

  return count ? score / count : Number.POSITIVE_INFINITY;
}

async function findBestVisualOverlapPx(prevBmp, currBmp, predictedOverlapPx) {
  const width = Math.min(prevBmp.width, currBmp.width);
  const prevH = prevBmp.height;
  const currH = currBmp.height;

  if (width < 40 || prevH < 80 || currH < 80) {
    return clamp(
      predictedOverlapPx || Math.round(currH * 0.2),
      1,
      Math.max(1, currH - 1),
    );
  }

  const bandH = clamp(Math.round(Math.min(prevH, currH) * 0.12), 72, 220);
  const minOverlap = clamp(
    Math.round(currH * 0.08),
    20,
    Math.max(20, currH - 1),
  );
  const maxOverlap = clamp(
    Math.round(currH * 0.6),
    minOverlap + 1,
    Math.max(minOverlap + 1, currH - 1),
  );
  const predicted = clamp(
    typeof predictedOverlapPx === "number"
      ? predictedOverlapPx
      : Math.round(currH * 0.2),
    minOverlap,
    maxOverlap,
  );

  const searchRadius = clamp(Math.round(currH * 0.22), 110, 360);
  const candidateMin = clamp(predicted - searchRadius, minOverlap, maxOverlap);
  const candidateMax = clamp(
    predicted + searchRadius,
    candidateMin,
    maxOverlap,
  );

  if (candidateMax - candidateMin < 3 || candidateMin < bandH) {
    return clamp(predicted, bandH, maxOverlap);
  }

  const prevCanvas = new OffscreenCanvas(width, prevH);
  const prevCtx = prevCanvas.getContext("2d", { willReadFrequently: true });
  prevCtx.drawImage(prevBmp, 0, 0, width, prevH, 0, 0, width, prevH);
  const prevBandData = prevCtx.getImageData(
    0,
    prevH - bandH,
    width,
    bandH,
  ).data;

  const currCanvas = new OffscreenCanvas(width, currH);
  const currCtx = currCanvas.getContext("2d", { willReadFrequently: true });
  currCtx.drawImage(currBmp, 0, 0, width, currH, 0, 0, width, currH);

  const regionTop = candidateMin - bandH;
  const regionHeight = candidateMax - candidateMin + bandH;
  const currRegion = currCtx.getImageData(
    0,
    regionTop,
    width,
    regionHeight,
  ).data;

  let bestOverlap = predicted;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let overlap = candidateMin; overlap <= candidateMax; overlap += 2) {
    const bandStartRow = overlap - bandH - regionTop;
    if (bandStartRow < 0 || bandStartRow + bandH > regionHeight) {
      continue;
    }

    const score = rgbDiff(
      prevBandData,
      currRegion,
      width,
      bandH,
      bandStartRow,
      7,
      3,
    );
    if (score < bestScore) {
      bestScore = score;
      bestOverlap = overlap;
    }
  }

  return clamp(bestOverlap, minOverlap, maxOverlap);
}

async function stitchByActualScrollPositions(frames) {
  if (!frames || !frames.length) {
    throw new Error("Tidak ada frame untuk stitching");
  }

  const bitmaps = [];
  for (const frame of frames) {
    const blob = await dataUrlToBlob(frame.dataUrl);
    const bmp = await createImageBitmap(blob);
    bitmaps.push(bmp);
  }

  const firstFrame = frames[0];
  const firstBmp = bitmaps[0];
  const lockedScalePxPerCss =
    firstBmp.height / Math.max(1, firstFrame.viewportHeight || 1);

  const processedUrls = [firstFrame.dataUrl];
  const processedHeightsPx = [firstBmp.height];
  let totalHeightPx = firstBmp.height;
  const widthPx = firstBmp.width;

  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1];
    const curr = frames[i];
    const prevBmp = bitmaps[i - 1];
    const currBmp = bitmaps[i];

    const predictedOverlapCss = Math.max(
      0,
      prev.scrollY + prev.viewportHeight - curr.scrollY,
    );
    const predictedOverlapPx = Math.round(
      predictedOverlapCss * lockedScalePxPerCss,
    );
    const bestOverlapPx = await findBestVisualOverlapPx(
      prevBmp,
      currBmp,
      predictedOverlapPx,
    );

    const maxVisibleCss = Math.max(
      0,
      Math.min(curr.viewportHeight, curr.scrollHeight - curr.scrollY),
    );
    const maxVisiblePx = clamp(
      Math.round(maxVisibleCss * lockedScalePxPerCss),
      1,
      currBmp.height,
    );

    const cropTopPx = clamp(bestOverlapPx, 0, currBmp.height - 1);
    const maxAppendPx = Math.max(1, maxVisiblePx - cropTopPx);
    const cropHeightPx = clamp(maxAppendPx, 1, currBmp.height - cropTopPx);

    const outUrl = await cropDataUrl(curr.dataUrl, {
      x: 0,
      y: cropTopPx,
      width: currBmp.width,
      height: cropHeightPx,
    });

    processedUrls.push(outUrl);
    processedHeightsPx.push(cropHeightPx);
    totalHeightPx += cropHeightPx;
  }

  if (!processedUrls.length || !totalHeightPx) {
    throw new Error("Gagal menyiapkan frame untuk stitching");
  }

  if (totalHeightPx > 30000 || widthPx > 30000) {
    throw new Error(
      "Hasil terlalu panjang/besar untuk di-stitch. Coba area selection atau bagian tertentu.",
    );
  }

  return await stitchVerticalDataUrls(
    processedUrls,
    processedHeightsPx,
    widthPx,
    totalHeightPx,
  );
}

async function captureScrollWithActualStitching(tabId, interactiveUi = false) {
  await ensureTabActive(tabId);
  await ensureContentScript(tabId);

  let originalScrollY = 0;
  try {
    const initialMetrics = await getLiveScreenshotMetrics(tabId);
    originalScrollY = initialMetrics.scrollY || 0;
  } catch (_) {}

  if (interactiveUi) {
    try {
      await chrome.tabs.sendMessage(tabId, {
        action: "SCREENSHOT_SCROLL_UI_START",
      });
    } catch (_) {}
  }

  const frames = [];

  try {
    try {
      await chrome.tabs.sendMessage(tabId, {
        action: "SCREENSHOT_HIDE_FLOATING",
      });
    } catch (_) {}

    const firstFrame = await ensureTopAndCaptureFirstFrame(
      tabId,
      interactiveUi,
    );
    frames.push(firstFrame);

    for (let i = 0; i < 400; i++) {
      if (interactiveUi) {
        if (
          !activeScreenshotFlow ||
          activeScreenshotFlow.tabId !== tabId ||
          activeScreenshotFlow.scrollCancel
        ) {
          throw new Error("Scroll screenshot dibatalkan.");
        }

        if (activeScreenshotFlow.scrollStop) {
          break;
        }
      }

      const previous = frames[frames.length - 1];
      const live = await getLiveScreenshotMetrics(tabId);
      const viewportH = live.viewportHeight;
      const capturedBottom = previous.scrollY + previous.viewportHeight;
      const liveScrollHeight = live.scrollHeight;

      if (capturedBottom >= liveScrollHeight - 1) {
        break;
      }

      const step = Math.max(1, Math.round(viewportH * 0.8));
      const maxTopY = Math.max(0, liveScrollHeight - viewportH);
      const targetY = Math.min(previous.scrollY + step, maxTopY);

      const scrollResult = await chrome.tabs.sendMessage(tabId, {
        action: "SCREENSHOT_SCROLL_TO",
        y: targetY,
      });
      if (!scrollResult || !scrollResult.ok) {
        break;
      }

      const stable = await waitForScrollStable(tabId, targetY, {
        tolerance: 2,
        stableFrames: 3,
        settleFrames: 2,
        maxWaitMs: 1800,
      });

      const currentY = stable.scrollY || scrollResult.actualY || targetY;
      const currentViewportH = stable.viewportHeight || viewportH;
      const currentScrollHeight = stable.scrollHeight || liveScrollHeight;
      const currentCapturedBottom = currentY + currentViewportH;

      if (
        currentY <= previous.scrollY + 1 &&
        currentCapturedBottom <= capturedBottom + 1
      ) {
        if (currentCapturedBottom >= currentScrollHeight - 1) {
          break;
        }
        break;
      }

      if (interactiveUi) {
        try {
          await chrome.tabs.sendMessage(tabId, {
            action: "SCREENSHOT_HIDE_SCROLL_UI",
          });
        } catch (_) {}
      }
      await sleep(30);
      const dataUrl = await captureVisibleTabForTab(tabId);
      if (interactiveUi) {
        try {
          await chrome.tabs.sendMessage(tabId, {
            action: "SCREENSHOT_SHOW_SCROLL_UI",
          });
        } catch (_) {}
      }

      frames.push({
        dataUrl,
        scrollY: currentY,
        viewportHeight: currentViewportH,
        scrollHeight: currentScrollHeight,
      });

      if (currentCapturedBottom >= currentScrollHeight - 1) {
        break;
      }
    }

    if (!frames.length) {
      throw new Error("Tidak ada gambar yang berhasil di-capture.");
    }

    return await stitchByActualScrollPositions(frames);
  } finally {
    try {
      if (interactiveUi) {
        await chrome.tabs.sendMessage(tabId, {
          action: "SCREENSHOT_HIDE_SCROLL_UI",
        });
      }
      await chrome.tabs.sendMessage(tabId, {
        action: "SCREENSHOT_SHOW_FLOATING",
      });
      await chrome.tabs.sendMessage(tabId, {
        action: "SCREENSHOT_SCROLL_TO",
        y: originalScrollY,
      });
      if (interactiveUi) {
        await chrome.tabs.sendMessage(tabId, {
          action: "SCREENSHOT_SCROLL_UI_END",
        });
      }
    } catch (_) {}
  }
}

async function captureFull(tabId) {
  const stitched = await captureScrollWithActualStitching(tabId, false);

  const meta = {
    type: "screenshot",
    mode: "scroll",
    tabId,
    capturedAt: new Date().toISOString(),
  };
  await openScreenshotPreview(meta, stitched);
}

async function captureScrollInteractive(tabId) {
  const stitched = await captureScrollWithActualStitching(tabId, true);

  const meta = {
    type: "screenshot",
    mode: "scroll",
    tabId,
    capturedAt: new Date().toISOString(),
  };
  await openScreenshotPreview(meta, stitched);
}

// Unified message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 0. Save environment snapshot
  if (request.action === "SAVE_ENVIRONMENT") {
    chrome.storage.local.get(["sessionLogs"], (data) => {
      const logs = data.sessionLogs || {};
      if (!logs.info) logs.info = {};
      logs.info.environment = request.payload;
      chrome.storage.local.set({ sessionLogs: logs });
    });
    return;
  }

  // Retry Area Screenshot
  if (request.action === "RETRY_SCREENSHOT_AREA") {
    (async () => {
      try {
        const tabId = request.tabId;
        if (!tabId) {
          sendResponse({ ok: false, error: "Missing tabId for retry" });
          return;
        }

        activeScreenshotFlow = { mode: "area", tabId, startedAt: Date.now() };

        await ensureTabActive(tabId);
        await ensureContentScript(tabId);
        await chrome.tabs.sendMessage(tabId, {
          action: "SCREENSHOT_START_AREA_SELECT",
        });
        sendResponse({ ok: true });
      } catch (e) {
        console.error("RETRY_SCREENSHOT_AREA failed:", e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // 1. Session Logging
  if (request.action === "LOG_CAPTURED") {
    if (isRecording) {
      appendLog(request.type, request.payload);
    }
  }

  // 2. Recording Controls
  else if (request.action === "START_RECORDING") {
    resetLogs().then(async () => {
      // FIX ISSUE 1: Always clear old videos from IndexedDB and local storage on new recording!
      await clearVideoFromDB();
      await chrome.storage.local.remove(["pendingVideo", "pendingReport"]);
      pendingVideoBase64 = null;

      isRecording = true;
      recordingStartTime = null; // Don't set yet, wait for media stream
      headerCache.clear();

      chrome.storage.local.get(["sessionLogs"], (data) => {
        const logs = data.sessionLogs || {};
        if (!logs.info) logs.info = {};

        // Preserve any info already recorded (like early navigations)
        logs.info.url = logs.info.url || request.payloadUrl || "N/A";
        logs.info.location = cachedCountry || "Unknown";
        logs.info.timestamp = new Date().toLocaleString();

        if (!logs.info.urlTimeline || logs.info.urlTimeline.length === 0) {
          logs.info.urlTimeline = [{ time: 0, timeMs: 0, url: logs.info.url }];
        }

        chrome.storage.local.set({ sessionLogs: logs });
      });

      setupOffscreenDocument("html/offscreen.html").then(() => {
        chrome.runtime.sendMessage(
          { target: "offscreen", action: "startRecording" },
          (response) => {
            if (response && response.status === "started") {
              recordingStartTime = Date.now(); // Set actual start time now

              // Attach CDP to all active tabs for comprehensive network capture
              chrome.tabs.query({}, (allTabs) => {
                allTabs.forEach((tab) => {
                  if (isInjectableUrl(tab.url)) {
                    attachCDPToTab(tab.id).catch((e) =>
                      console.warn('[BERIBUG][CDP] attach failed for tab', tab.id, e),
                    );
                  }
                });
              });

              // Show widget on the active tab
              chrome.tabs.query(
                { active: true, lastFocusedWindow: true },
                function (tabs) {
                  const targetTab = tabs[0];
                  if (targetTab) {
                    chrome.tabs
                      .sendMessage(targetTab.id, {
                        action: "SHOW_WIDGET",
                        startTime: 0,
                        isPaused: isPaused,
                      })
                      .catch(() => {
                        chrome.scripting.executeScript(
                          {
                            target: { tabId: targetTab.id },
                            files: ["js/content.js"],
                          },
                          () => {
                            if (!chrome.runtime.lastError) {
                              chrome.tabs
                                .sendMessage(targetTab.id, {
                                  action: "SHOW_WIDGET",
                                  startTime: 0,
                                  isPaused: isPaused,
                                })
                                .catch(() => {});
                            }
                          },
                        );
                      });
                  }
                },
              );
              sendResponse({ status: "started" });
            } else {
              isRecording = false; // Reset if cancelled/failed
              sendResponse({
                status: "error",
                error: response ? response.error : "Cancelled or Failed",
              });
            }
          },
        );
      });
    });
    return true; // async
  } else if (request.action === "STOP_RECORDING") {
    isRecording = false;
    recordingStartTime = null;
    isPaused = false;
    headerCache.clear();
    // Detach any CDP attached tabs
    for (const [tabId] of cdpAttachedTabs) {
      try {
        chrome.debugger.detach({ tabId: Number(tabId) }, () => {});
      } catch (e) {}
    }
    cdpAttachedTabs.clear();
    cdpRequests.clear();
    try {
      if (cdpListenerAdded) {
        chrome.debugger.onEvent.removeListener(handleCdpEvent);
        cdpListenerAdded = false;
      }
    } catch (e) {}
    chrome.runtime.sendMessage({
      target: "offscreen",
      action: "stopRecording",
    });
    chrome.tabs.query(
      { active: true, lastFocusedWindow: true },
      function (tabs) {
        if (tabs[0])
          chrome.tabs
            .sendMessage(tabs[0].id, { action: "HIDE_WIDGET" })
            .catch(() => {});
      },
    );
    sendResponse({ status: "stopped" });
    return true;
  } else if (request.action === "PAUSE_RECORDING") {
    isPaused = true;
    chrome.runtime.sendMessage({
      target: "offscreen",
      action: "pauseRecording",
    });
  } else if (request.action === "RESUME_RECORDING") {
    isPaused = false;
    chrome.runtime.sendMessage({
      target: "offscreen",
      action: "resumeRecording",
    });
  } else if (request.action === "GET_RECORDING_STATE") {
    sendResponse({
      isRecording,
      startTime: recordingStartTime,
      now: Date.now(),
    });
  } else if (request.action === "recordingStopped") {
    pendingVideoBase64 = request.base64data;
    chrome.storage.local.set({ pendingVideo: request.base64data });
    chrome.tabs.create({ url: chrome.runtime.getURL("html/review.html") });
    chrome.offscreen.closeDocument();
  }

  // 3. Review & Upload
  else if (request.action === "GET_PENDING_VIDEO") {
    // Try IndexedDB first (most reliable for edited/large videos)
    getVideoFromDB()
      .then((blob) => {
        if (blob) {
          const reader = new FileReader();
          reader.onload = () =>
            sendResponse({ videoBase64: reader.result.split(",")[1] });
          reader.readAsDataURL(blob);
        } else if (pendingVideoBase64) {
          sendResponse({ videoBase64: pendingVideoBase64 });
        } else {
          chrome.storage.local.get(["pendingVideo"], (res) => {
            sendResponse({ videoBase64: res.pendingVideo });
          });
        }
      })
      .catch(() => {
        sendResponse({ videoBase64: pendingVideoBase64 });
      });
    return true; // async
  } else if (request.action === "SAVE_PENDING_VIDEO") {
    if (request.useDB) {
      // Data is already in IndexedDB, just clear memory cache
      pendingVideoBase64 = null;
    } else {
      pendingVideoBase64 = request.videoBase64;
      chrome.storage.local.set({ pendingVideo: request.videoBase64 });
    }
    sendResponse({ success: true });
  } else if (request.action === "COMMIT_UPLOAD") {
    commitUpload(
      request.title,
      request.description,
      pendingVideoBase64,
      request.info,
    )
      .then((url) => sendResponse({ success: true, url }))
      .catch((err) => sendResponse({ success: false, error: err.toString() }));
    return true;
  }

  // ==================== SCREENSHOT ENTRYPOINT ====================
  else if (request.action === "START_SCREENSHOT") {
    const mode = request.mode;
    const tabId = request.tabId;

    (async () => {
      try {
        if (!tabId || !mode) {
          sendResponse({ ok: false, error: "Missing tabId/mode" });
          return;
        }

        activeScreenshotFlow = { mode, tabId, startedAt: Date.now() };

        if (mode === "area") {
          await ensureTabActive(tabId);
          try {
            await ensureContentScript(tabId);
            await chrome.tabs.sendMessage(tabId, {
              action: "SCREENSHOT_START_AREA_SELECT",
            });
            // Only close popup when overlay successfully started.
            sendResponse({ ok: true });
          } catch (e) {
            activeScreenshotFlow = null;
            const msg =
              e?.message ||
              "Tidak bisa memulai area selection. Coba refresh tab setelah reload extension.";
            // For area, keep it simple: let popup show the error (no new tab).
            sendResponse({ ok: false, error: msg });
          }
          return;
        }

        // full/scroll runs async; reply OK so popup can close
        sendResponse({ ok: true });

        if (mode === "full") {
          // Full Page mode = viewport only (instant capture)
          await captureViewport(tabId);
        } else if (mode === "scroll") {
          // Scroll mode = full page with interactive stop button
          activeScreenshotFlow.scrollStop = false;
          activeScreenshotFlow.scrollCancel = false;
          activeScreenshotFlow.stopAtY = null;
          await captureScrollInteractive(tabId);
        } else {
          throw new Error("Mode screenshot tidak dikenal");
        }
      } catch (e) {
        console.error("START_SCREENSHOT failed:", e);
        openScreenshotError(e?.message || String(e));
      } finally {
        if (mode !== "area") activeScreenshotFlow = null;
      }
    })();

    return true;
  }

  // Result from page overlay selection
  else if (request.action === "SCREENSHOT_AREA_RESULT") {
    (async () => {
      try {
        if (!activeScreenshotFlow || activeScreenshotFlow.mode !== "area")
          return;
        const tabId = activeScreenshotFlow.tabId;

        if (request.canceled) {
          activeScreenshotFlow = null;
          return;
        }

        const rect = request.rect;
        const metrics = request.metrics;
        if (!rect || !metrics) throw new Error("Area selection data missing");

        await ensureTabActive(tabId);
        await sleep(80);

        const dataUrl = await captureVisibleTabForTab(tabId);
        const dpr = metrics.devicePixelRatio || 1;

        const meta = {
          mode: "area",
          capturedAt: new Date().toISOString(),
          tabId: tabId,
        };
        const cropPx = {
          x: Math.round(rect.x * dpr),
          y: Math.round(rect.y * dpr),
          width: Math.round(rect.width * dpr),
          height: Math.round(rect.height * dpr),
        };

        const cropped = await cropDataUrl(dataUrl, cropPx);
        await openScreenshotPreview(meta, cropped);
      } catch (e) {
        console.error("SCREENSHOT_AREA_RESULT failed:", e);
        openScreenshotError(e?.message || String(e));
      } finally {
        activeScreenshotFlow = null;
      }
    })();

    sendResponse({ ok: true });
    return true;
  }

  // Stop/cancel signals for interactive scroll mode
  else if (request.action === "SCREENSHOT_SCROLL_STOP") {
    if (activeScreenshotFlow && activeScreenshotFlow.mode === "scroll") {
      activeScreenshotFlow.scrollStop = true;
      if (typeof request.scrollY === "number")
        activeScreenshotFlow.stopAtY = request.scrollY;
    }
    sendResponse({ ok: true });
    return true;
  } else if (request.action === "SCREENSHOT_SCROLL_CANCEL") {
    if (activeScreenshotFlow && activeScreenshotFlow.mode === "scroll") {
      activeScreenshotFlow.scrollCancel = true;
    }
    sendResponse({ ok: true });
    return true;
  }

  // --- APP STATE REPORTING (Cookies) ---
  else if (request.action === "BUGLENS_GET_COOKIES") {
    const fetchCookies = (url) => {
      chrome.cookies.getAll(url ? { url } : {}, (cookies) => {
        sendResponse({ cookies: cookies || [] });
      });
    };

    if (
      request.url &&
      request.url !== "N/A" &&
      request.url.startsWith("http")
    ) {
      fetchCookies(request.url);
    } else {
      // Fallback: try active tab
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].url && tabs[0].url.startsWith("http")) {
          fetchCookies(tabs[0].url);
        } else {
          fetchCookies(null); // Get all if possible (might be limited by permissions)
        }
      });
    }
    return true; // async
  }
});

// Real-time Cookie Sync
chrome.cookies.onChanged.addListener((changeInfo) => {
  // Broadcast to any open review pages or active tabs if necessary
  // For now, we update local storage or send message to update UI
  chrome.runtime
    .sendMessage({
      action: "BUGLENS_COOKIE_CHANGED",
      change: changeInfo,
    })
    .catch(() => {}); // Avoid error when no listeners
});

// Auto-attach CDP to newly created tabs during recording
chrome.tabs.onCreated.addListener((tab) => {
  if (isRecording && tab.id && isInjectableUrl(tab.url)) {
    // Wait a bit for the tab to load before attaching
    setTimeout(() => {
      attachCDPToTab(tab.id).catch((e) =>
        console.warn('[BERIBUG][CDP] auto-attach to new tab', tab.id, 'failed', e),
      );
    }, 500);
  }
});

// Track navigations while recording, and restore floating widget when page changes
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (isRecording && changeInfo.status === "complete" && tab.url) {
    if (tab.url.startsWith("chrome-extension://")) return;

    // Re-attach CDP if tab navigated away and came back
    if (cdpAttachedTabs.has(tabId) && isInjectableUrl(tab.url)) {
      console.log('[BERIBUG][CDP] tab navigated, re-attaching to', tabId);
      attachCDPToTab(tabId).catch((e) =>
        console.warn('[BERIBUG][CDP] reattach on navigation failed', e),
      );
    }

    appendLog("ACTIONS", {
      time: new Date().toLocaleTimeString(),
      event: "🧭 Navigated to",
      element: tab.url,
    });

    const elapsed = recordingStartTime
      ? Math.floor((Date.now() - recordingStartTime) / 1000)
      : 0;
    chrome.tabs
      .sendMessage(tabId, {
        action: "SHOW_WIDGET",
        startTime: elapsed,
        isPaused: isPaused,
      })
      .catch(() => {});
  }
});

async function commitUpload(title, desc, videoBase64, infoData) {
  const data = await chrome.storage.local.get(["sessionLogs"]);
  let logsData = data.sessionLogs || {};

  // Wait for log queue to flush if it's still processing
  let retries = 0;
  while (isProcessingQueue && retries < 10) {
    await new Promise((r) => setTimeout(r, 100));
    const latest = await chrome.storage.local.get(["sessionLogs"]);
    logsData = latest.sessionLogs || logsData;
    retries++;
  }

  // Ambil data info yang sudah ada (termasuk environment snapshot dan URL asli)
  const existingInfo = logsData.info || {};

  // Gabungkan dengan infoData dari review.js (metadata visual)
  // Jangan biarkan 'url: "-"' menimpa URL asli yang sudah terekam
  const finalInfo = {
    ...existingInfo,
    ...(infoData || {}),
  };

  if (
    (!finalInfo.url || finalInfo.url === "-") &&
    existingInfo.url &&
    existingInfo.url !== "-"
  ) {
    finalInfo.url = existingInfo.url;
  }

  // Tambahkan cookies lengkap ke environment jika memungkinkan
  if (finalInfo.environment && finalInfo.url && finalInfo.url !== "-") {
    try {
      const cookies = await new Promise((resolve) => {
        chrome.cookies.getAll({ url: finalInfo.url }, resolve);
      });
      if (cookies && cookies.length > 0) {
        finalInfo.environment.cookies = cookies;
        finalInfo.environment.cookieCount = cookies.length;
      }
    } catch (e) {
      console.error("Failed to fetch full cookies for upload:", e);
    }
  }

  logsData.info = finalInfo;

  let token = await getAccessToken();
  if (!token) {
    token = await login();
  }

  if (!token) throw new Error("Could not authenticate with OneDrive");

  const folderId = await getOrCreateFolder(token, "BERIBUG_Reports_App");

  const jsonBlob = new Blob(
    [
      JSON.stringify(
        {
          version: "1.0",
          title: title,
          description: desc,
          metadata: {
            date: new Date().toISOString(),
          },
          logs: logsData,
        },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );

  // 2. Persist to Drive
  let videoBlob;
  try {
    const dbBlob = await getVideoFromDB();
    if (dbBlob) {
      videoBlob = dbBlob;
    } else {
      // Fallback to memory base64 or local storage if background restarted
      let b64 = videoBase64;
      if (!b64 || b64 === "null") {
        const res = await chrome.storage.local.get(["pendingVideo"]);
        b64 = res.pendingVideo;
      }
      if (!b64) throw new Error("No video data found in memory or storage.");

      const byteCharacters = atob(b64);
      const byteArray = new Uint8Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteArray[i] = byteCharacters.charCodeAt(i);
      }
      videoBlob = new Blob([byteArray], { type: "video/webm" });
    }
  } catch (err) {
    console.error("DB/Fallback Fetch failed:", err);
    throw new Error("Failed to prepare video blob for upload: " + err.message);
  }

  const timeStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sanitizedTitle = title.replace(/[^a-zA-Z0-9]/g, "_");

  const videoFileId = await uploadFileToOneDrive(
    token,
    `BERIBUG_${sanitizedTitle}_${timeStamp}.webm`,
    "video/webm",
    videoBlob,
    folderId,
  );
  const jsonFileId = await uploadFileToOneDrive(
    token,
    `BERIBUG_${sanitizedTitle}_${timeStamp}.json`,
    "application/json",
    jsonBlob,
    folderId,
  );

  const videoDirectUrl = await makeFilePublicAndGetDirectUrl(token, videoFileId);
  const jsonDirectUrl = await makeFilePublicAndGetDirectUrl(token, jsonFileId);

  resetLogs();
  pendingVideoBase64 = null;
  chrome.storage.local.remove(["pendingVideo", "pendingReport"]);
  await clearVideoFromDB();

  // Return Hosted Player Web App URL with direct URLs
  return `https://dynamic-rabanadas-2b5f0b.netlify.app/?vUrl=${encodeURIComponent(videoDirectUrl)}&lUrl=${encodeURIComponent(jsonDirectUrl)}`;
}

async function getVideoFromDB() {
  return new Promise((resolve) => {
    const request = indexedDB.open("BERIBUG_Storage", 2);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("videos"))
        db.createObjectStore("videos");
    };
    request.onsuccess = (e) => {
      const db = e.target.result;
      const transaction = db.transaction("videos", "readonly");
      const store = transaction.objectStore("videos");
      const getRequest = store.get("pendingVideo");
      getRequest.onsuccess = () => resolve(getRequest.result);
      getRequest.onerror = () => resolve(null);
    };
    request.onerror = () => resolve(null);
  });
}

async function clearVideoFromDB() {
  return new Promise((resolve) => {
    const request = indexedDB.open("BERIBUG_Storage", 2);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("videos"))
        db.createObjectStore("videos");
    };
    request.onsuccess = (e) => {
      const db = e.target.result;
      try {
        if (!db.objectStoreNames.contains("videos")) {
          db.close();
          const cleanup = indexedDB.deleteDatabase("BERIBUG_Storage");
          cleanup.onsuccess = () => {
            const recreate = indexedDB.open("BERIBUG_Storage", 2);
            recreate.onupgradeneeded = (ev) => {
              const freshDb = ev.target.result;
              if (!freshDb.objectStoreNames.contains("videos")) {
                freshDb.createObjectStore("videos");
              }
            };
            recreate.onsuccess = (ev2) => {
              const freshDb = ev2.target.result;
              const transaction = freshDb.transaction("videos", "readwrite");
              const store = transaction.objectStore("videos");
              store.delete("pendingVideo");
              transaction.oncomplete = () => resolve();
              transaction.onerror = () => resolve();
            };
            recreate.onerror = () => resolve();
          };
          cleanup.onerror = () => resolve();
          return;
        }

        const transaction = db.transaction("videos", "readwrite");
        const store = transaction.objectStore("videos");
        store.delete("pendingVideo");
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
      } catch (err) {
        resolve();
      }
    };
    request.onerror = () => resolve();
  });
}

async function getOrCreateFolder(token, folderName) {
  const checkUrl = `https://graph.microsoft.com/v1.0/me/drive/root:/${folderName}`;
  try {
    const res = await fetch(checkUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      return data.id;
    }
  } catch (e) {
    console.warn("Folder check failed, trying to create:", e);
  }

  // Create folder
  const createUrl = `https://graph.microsoft.com/v1.0/me/drive/root/children`;
  const createRes = await fetch(createUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: folderName,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail"
    })
  });

  if (!createRes.ok) {
    // Retry check in case of race condition
    const checkRes = await fetch(checkUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (checkRes.ok) {
      const data = await checkRes.json();
      return data.id;
    }
    throw new Error(`Failed to create folder ${folderName}: ${createRes.status} ${await createRes.text()}`);
  }
  const data = await createRes.json();
  return data.id;
}

async function uploadFileToOneDrive(token, filename, mimeType, fileBlob, folderId) {
  if (fileBlob.size < 4 * 1024 * 1024) {
    return await uploadSmallFile(token, folderId, filename, mimeType, fileBlob);
  } else {
    return await uploadLargeFile(token, folderId, filename, mimeType, fileBlob);
  }
}

async function uploadSmallFile(token, folderId, filename, mimeType, fileBlob) {
  const url = `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}:/${encodeURIComponent(filename)}:/content`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": mimeType
    },
    body: fileBlob
  });

  if (!res.ok) {
    throw new Error(`Failed to upload small file ${filename}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.id;
}

async function uploadLargeFile(token, folderId, filename, mimeType, fileBlob) {
  const sessionUrl = `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}:/${encodeURIComponent(filename)}:/createUploadSession`;
  const sessionRes = await fetch(sessionUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      item: {
        "@microsoft.graph.conflictBehavior": "rename",
        name: filename
      }
    })
  });

  if (!sessionRes.ok) {
    throw new Error(`Failed to create upload session: ${sessionRes.status} ${await sessionRes.text()}`);
  }

  const sessionData = await sessionRes.json();
  const uploadUrl = sessionData.uploadUrl;

  const fileSize = fileBlob.size;
  const chunkSize = 327680 * 10; // ~3.2 MB chunks
  let start = 0;

  while (start < fileSize) {
    const end = Math.min(start + chunkSize, fileSize);
    const chunk = fileBlob.slice(start, end);

    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": chunk.size,
        "Content-Range": `bytes ${start}-${end - 1}/${fileSize}`
      },
      body: chunk
    });

    if (!res.ok) {
      throw new Error(`Chunk upload failed at range ${start}-${end-1}: ${res.status} ${await res.text()}`);
    }

    if (res.status === 201 || res.status === 200) {
      const finishedData = await res.json();
      return finishedData.id;
    }

    start = end;
  }

  throw new Error("Upload session finished but no file ID returned");
}

async function makeFilePublicAndGetDirectUrl(token, fileId) {
  const url = `https://graph.microsoft.com/v1.0/me/drive/items/${fileId}/createLink`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      type: "view",
      scope: "anonymous"
    })
  });

  if (!res.ok) {
    throw new Error(`Failed to create sharing link: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const sharingLink = data.link.webUrl;

  // Convert to direct URL
  const base64Value = btoa(sharingLink);
  const safeBase64Value = base64Value
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `https://api.onedrive.com/v1.0/shares/u!${safeBase64Value}/root/content`;
}

async function createMondayTicket(apiKey, boardId, videoUrl, timestamp) {
  const query = `
    mutation {
      create_item (
        board_id: ${boardId}, 
        item_name: "Automated Bug Report: ${timestamp}", 
        column_values: "{}"
      ) { id }
    }
  `;

  // Create item first
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "API-Version": "2023-10",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();

  if (json.errors) {
    console.error("Monday API error:", json.errors);
    return;
  }

  const itemId = json.data.create_item.id;

  // Add video link as an update to the item
  const updateQuery = `
    mutation {
      create_update (
        item_id: ${itemId},
        body: "Recorded Video & Logs: <br> <a href='${videoUrl}'>View on OneDrive</a>"
      ) { id }
    }
  `;

  await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "API-Version": "2023-10",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: updateQuery }),
  });
}
