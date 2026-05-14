let isRecording = false;
let recordingStartTime = null;
let isPaused = false;
let cachedCountry = "Unknown";
let headerCache = new Map(); // Store headers by URL during recording
let pendingRequests = new Map(); // requestId -> data (for advanced tracking)

// Detect country on startup
async function updateCountryCache() {
  try {
    const res = await fetch('https://api.country.is/');
    const data = await res.json();
    if (data && data.country) {
      const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
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
  const sensitive = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key'];
  const masked = {};
  for (let key in headers) {
    if (sensitive.includes(key.toLowerCase())) {
      masked[key] = '***** Auto-filtered';
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
  headersArray.forEach(h => {
    obj[h.name] = h.value;
  });
  return obj;
}

// 🛠️ Helper: Determine Category (Fetch, JS, CSS, etc.)
function determineResourceType(url, initiator, type) {
  if (type === 'xmlhttprequest' || type === 'fetch') return 'Fetch/XHR';
  if (type === 'script') return 'JS';
  if (type === 'stylesheet') return 'CSS';
  if (type === 'image') return 'Img';
  if (type === 'font') return 'Font';
  if (type === 'media') return 'Media';
  if (type === 'main_frame' || type === 'sub_frame') return 'Doc';
  return type.charAt(0).toUpperCase() + type.slice(1);
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
      initiator: details.initiator
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!isRecording) return;
    const req = pendingRequests.get(details.requestId);
    if (!req) return;
    req.requestHeaders = maskHeaders(flattenHeaders(details.requestHeaders));
    
    // Legacy headerCache for backward compat/other tabs
    if (!headerCache.has(details.url)) headerCache.set(details.url, { request: {}, response: {} });
    headerCache.get(details.url).request = req.requestHeaders;
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
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
    const cl = details.responseHeaders.find(h => h.name.toLowerCase() === 'content-length');
    if (cl) req.size = parseInt(cl.value);

    // Legacy trace IDs
    const traceHeaderNames = ['x-trace-id', 'x-request-id', 'traceparent', 'x-amzn-trace-id', 'cf-ray', 'x-b3-traceid'];
    const rawHeaders = flattenHeaders(details.responseHeaders);
    req.traceIds = {};
    traceHeaderNames.forEach(h => { if (rawHeaders[h]) req.traceIds[h] = rawHeaders[h]; });

    // Update Legacy HeaderCache
    if (headerCache.has(details.url)) {
      const entry = headerCache.get(details.url);
      entry.response = req.responseHeaders;
      entry.status = req.status;
      if (Object.keys(req.traceIds).length > 0) entry.traceIds = req.traceIds;
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
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
      const cl = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-length');
      if (cl) req.size = parseInt(cl.value);
    }

    const logEntry = {
      method: req.method,
      url: req.url,
      status: req.status || details.statusCode || 200,
      type: determineResourceType(req.url, req.initiator, req.type),
      size: req.fromCache ? -1 : (req.size || 0),
      duration: duration,
      requestHeaders: req.requestHeaders,
      responseHeaders: req.responseHeaders,
      traceIds: req.traceIds,
      isStatic: !['xmlhttprequest', 'fetch'].includes(req.type),
      fromCache: req.fromCache,
      frameContext: req.frameId === 0 ? "Main Frame" : `Sub Frame (${req.frameId})`,
      startTimeAbs: req.startTime
    };

    appendLog('NETWORK', logEntry);

    // 🧹 Memory Cleanup
    pendingRequests.delete(details.requestId);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (!isRecording) {
      pendingRequests.delete(details.requestId);
      return;
    }
    const req = pendingRequests.get(details.requestId);
    if (req) {
      appendLog('NETWORK', {
        method: req.method,
        url: req.url,
        status: 0,
        type: determineResourceType(req.url, req.initiator, req.type),
        message: details.error,
        startTimeAbs: req.startTime,
        duration: Date.now() - req.startTime
      });
    }
    pendingRequests.delete(details.requestId);
  },
  { urls: ["<all_urls>"] }
);

// Initialize log storage
async function resetLogs() {
  await chrome.storage.local.set({ 
    sessionLogs: { console: [], network: [], actions: [], backend: [] } 
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
  const data = await chrome.storage.local.get(['sessionLogs']);
  const logs = data.sessionLogs || { console: [], network: [], actions: [], backend: [] };
  
  if (recordingStartTime) {
    const now = Date.now();
    const elapsedMs = payload.startTimeAbs ? (payload.startTimeAbs - recordingStartTime) : (now - recordingStartTime);
    payload.relativeMs = Math.max(0, elapsedMs); // Ensure not negative

    const elapsedSecs = Math.floor(payload.relativeMs / 1000);
    const m = Math.floor(elapsedSecs / 60).toString().padStart(2, '0');
    const s = (elapsedSecs % 60).toString().padStart(2, '0');
    payload.time = `[${m}:${s}] `;
  } else {
    // If recording started but startTime not yet set (during picker)
    payload.relativeMs = 0;
    payload.time = `[00:00] `;
  }
  
  if (type === 'CONSOLE') logs.console.push(payload);
  else if (type === 'ACTIONS') {
    logs.actions.push(payload);
    
    // 🧭 URL TIMELINE TRACKING
    if (payload.event && payload.event.includes('Navigated')) {
      const timeMs = payload.relativeMs || 0;
      if (!logs.info) logs.info = {};
      if (!logs.info.urlTimeline) logs.info.urlTimeline = [];
      
      const lastEntry = logs.info.urlTimeline[logs.info.urlTimeline.length - 1];
      const currentUrl = payload.element;
      
      // Allow if it's the first entry, or the URL is different, 
      // or it's been more than 500ms (to catch refreshes/redirects)
      if (!lastEntry || lastEntry.url !== currentUrl || (timeMs - (lastEntry.timeMs || 0) > 500)) {
        logs.info.urlTimeline.push({ 
          time: Math.floor(timeMs / 1000), 
          timeMs: timeMs,                 
          url: currentUrl 
        });
        
        // Update current URL in info
        logs.info.url = currentUrl;
      }
    }
  }
  else if (type === 'BACKEND') logs.backend.push(payload);
  else if (type === 'NETWORK') {
    if (payload.isMonkeyPatched) {
      const existing = logs.network.find(n => 
        n.url === payload.url && 
        Math.abs(n.relativeMs - payload.relativeMs) < 2000
      );
      if (existing) {
        existing.requestBody = payload.requestBody;
        existing.responseBody = payload.responseBody;
        if (payload.requestHeaders) existing.requestHeaders = {...existing.requestHeaders, ...payload.requestHeaders};
        await chrome.storage.local.set({ sessionLogs: logs });
        return;
      }
    }
    logs.network.push(payload);
    const status = payload.status;
    if (status && typeof status === 'number' && status >= 400) {
      const traceInfo = payload.traceIds ? Object.entries(payload.traceIds).map(([k,v]) => `${k}: ${v}`).join(' | ') : '';
      logs.backend.push({
        time: payload.time,
        type: 'API Failure',
        message: `${payload.method} ${payload.url} → ${status}`,
        stack: traceInfo ? `Trace IDs:\n${traceInfo}` : '',
        source: payload.url,
        relativeMs: payload.relativeMs
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
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(path)]
  });

  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: path,
    reasons: ['USER_MEDIA'],
    justification: 'Recording screen for T.R.A.C.E report'
  });
}

// Global accessor for review page to fetch
let pendingVideoBase64 = null;

// Unified message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 0. Save environment snapshot
  if (request.action === 'SAVE_ENVIRONMENT') {
    chrome.storage.local.get(['sessionLogs'], (data) => {
      const logs = data.sessionLogs || {};
      if (!logs.info) logs.info = {};
      logs.info.environment = request.payload;
      chrome.storage.local.set({ sessionLogs: logs });
    });
    return;
  }

  // 1. Session Logging
  if (request.action === 'LOG_CAPTURED') {
    if (isRecording) {
      appendLog(request.type, request.payload);
    }
  } 
  
  // 2. Recording Controls
  else if (request.action === 'START_RECORDING') {
    resetLogs().then(() => {
      isRecording = true;
      recordingStartTime = null; // Don't set yet, wait for media stream
      headerCache.clear();

      chrome.storage.local.get(['sessionLogs'], (data) => {
        const logs = data.sessionLogs || {};
        if (!logs.info) logs.info = {};
        
        // Preserve any info already recorded (like early navigations)
        logs.info.url = logs.info.url || request.payloadUrl || 'N/A';
        logs.info.location = cachedCountry || 'Unknown';
        logs.info.timestamp = new Date().toLocaleString();
        
        if (!logs.info.urlTimeline || logs.info.urlTimeline.length === 0) {
          logs.info.urlTimeline = [{ time: 0, timeMs: 0, url: logs.info.url }];
        }
        
        chrome.storage.local.set({ sessionLogs: logs });
      });
      
      setupOffscreenDocument('html/offscreen.html').then(() => {
        chrome.runtime.sendMessage({ target: 'offscreen', action: 'startRecording' }, (response) => {
          if (response && response.status === 'started') {
            recordingStartTime = Date.now(); // Set actual start time now
            
            // Show widget on the active tab
            chrome.tabs.query({active: true, lastFocusedWindow: true}, function(tabs) {
              const targetTab = tabs[0];
              if (targetTab) {
                chrome.tabs.sendMessage(targetTab.id, { 
                  action: 'SHOW_WIDGET', 
                  startTime: 0, 
                  isPaused: isPaused 
                }).catch(() => {
                  chrome.scripting.executeScript({
                    target: { tabId: targetTab.id },
                    files: ['js/content.js']
                  }, () => {
                    if (!chrome.runtime.lastError) {
                      chrome.tabs.sendMessage(targetTab.id, { 
                        action: 'SHOW_WIDGET', 
                        startTime: 0, 
                        isPaused: isPaused 
                      }).catch(() => {});
                    }
                  });
                });
              }
            });
            sendResponse({ status: 'started' });
          } else {
            sendResponse({ status: 'error', error: response ? response.error : 'Unknown' });
          }
        });
      });
    });
    return true; // async
  } 
  
  else if (request.action === 'STOP_RECORDING') {
    isRecording = false;
    recordingStartTime = null;
    isPaused = false;
    headerCache.clear();
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'stopRecording' });
    chrome.tabs.query({active: true, lastFocusedWindow: true}, function(tabs) {
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: 'HIDE_WIDGET' }).catch(() => {});
    });
    sendResponse({ status: 'stopped' });
    return true;
  }
  
  else if (request.action === 'PAUSE_RECORDING') {
    isPaused = true;
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'pauseRecording' });
  } 
  
  else if (request.action === 'RESUME_RECORDING') {
    isPaused = false;
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'resumeRecording' });
  } 
  
  else if (request.action === 'GET_RECORDING_STATE') {
    sendResponse({ 
      isRecording, 
      startTime: recordingStartTime,
      now: Date.now() 
    });
  } 
  
  else if (request.action === 'recordingStopped') {
    pendingVideoBase64 = request.base64data;
    chrome.storage.local.set({ pendingVideo: request.base64data });
    chrome.tabs.create({ url: chrome.runtime.getURL('html/review.html') });
    chrome.offscreen.closeDocument();
  }

  // 3. Review & Upload
  else if (request.action === 'GET_PENDING_VIDEO') {
    // Try IndexedDB first (most reliable for edited/large videos)
    getVideoFromDB().then(blob => {
      if (blob) {
        const reader = new FileReader();
        reader.onload = () => sendResponse({ videoBase64: reader.result.split(',')[1] });
        reader.readAsDataURL(blob);
      } else if (pendingVideoBase64) {
        sendResponse({ videoBase64: pendingVideoBase64 });
      } else {
        chrome.storage.local.get(['pendingVideo'], (res) => {
          sendResponse({ videoBase64: res.pendingVideo });
        });
      }
    }).catch(() => {
      sendResponse({ videoBase64: pendingVideoBase64 });
    });
    return true; // async
  } 
  
  else if (request.action === 'SAVE_PENDING_VIDEO') {
    if (request.useDB) {
      // Data is already in IndexedDB, just clear memory cache
      pendingVideoBase64 = null;
    } else {
      pendingVideoBase64 = request.videoBase64;
      chrome.storage.local.set({ pendingVideo: request.videoBase64 });
    }
    sendResponse({ success: true });
  }
  
  else if (request.action === 'COMMIT_UPLOAD') {
    commitUpload(request.title, request.description, pendingVideoBase64, request.info)
      .then(url => sendResponse({ success: true, url }))
      .catch(err => sendResponse({ success: false, error: err.toString() }));
    return true;
  }

  // --- APP STATE REPORTING (Cookies) ---
  else if (request.action === 'BUGLENS_GET_COOKIES') {
    const fetchCookies = (url) => {
      chrome.cookies.getAll(url ? { url } : {}, (cookies) => {
        sendResponse({ cookies: cookies || [] });
      });
    };

    if (request.url && request.url !== 'N/A' && request.url.startsWith('http')) {
      fetchCookies(request.url);
    } else {
      // Fallback: try active tab
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].url && tabs[0].url.startsWith('http')) {
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
  chrome.runtime.sendMessage({ 
    action: 'BUGLENS_COOKIE_CHANGED', 
    change: changeInfo 
  }).catch(() => {}); // Avoid error when no listeners
});

// Track navigations while recording, and restore floating widget when page changes
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (isRecording && changeInfo.status === 'complete' && tab.url) {
    if (tab.url.startsWith('chrome-extension://')) return;

    appendLog('ACTIONS', {
      time: new Date().toLocaleTimeString(),
      event: '🧭 Navigated to',
      element: tab.url
    });

    const elapsed = recordingStartTime ? Math.floor((Date.now() - recordingStartTime) / 1000) : 0;
    chrome.tabs.sendMessage(tabId, { 
      action: 'SHOW_WIDGET', 
      startTime: elapsed, 
      isPaused: isPaused 
    }).catch(() => {});
  }
});

async function commitUpload(title, desc, videoBase64, infoData) {
  const data = await chrome.storage.local.get(['sessionLogs']);
  let logsData = data.sessionLogs || {};
  
  // Wait for log queue to flush if it's still processing
  let retries = 0;
  while (isProcessingQueue && retries < 10) {
    await new Promise(r => setTimeout(r, 100));
    const latest = await chrome.storage.local.get(['sessionLogs']);
    logsData = latest.sessionLogs || logsData;
    retries++;
  }
  
  // Ambil data info yang sudah ada (termasuk environment snapshot dan URL asli)
  const existingInfo = logsData.info || {};
  
  // Gabungkan dengan infoData dari review.js (metadata visual)
  // Jangan biarkan 'url: "-"' menimpa URL asli yang sudah terekam
  const finalInfo = {
    ...existingInfo,
    ...(infoData || {})
  };

  if ((!finalInfo.url || finalInfo.url === '-') && existingInfo.url && existingInfo.url !== '-') {
    finalInfo.url = existingInfo.url;
  }

  // Tambahkan cookies lengkap ke environment jika memungkinkan
  if (finalInfo.environment && finalInfo.url && finalInfo.url !== '-') {
    try {
      const cookies = await new Promise(resolve => {
        chrome.cookies.getAll({ url: finalInfo.url }, resolve);
      });
      if (cookies && cookies.length > 0) {
        finalInfo.environment.cookies = cookies;
        finalInfo.environment.cookieCount = cookies.length;
      }
    } catch (e) { console.error("Failed to fetch full cookies for upload:", e); }
  }

  logsData.info = finalInfo;

  const token = await new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({interactive: true}, (token) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(token);
    });
  });
  
  if (!token) throw new Error("Could not authenticate with Google");

  const folderId = await getOrCreateFolder(token, 'BERIBUG_Reports_App');

  const jsonBlob = new Blob([JSON.stringify({
    version: "1.0",
    title: title,
    description: desc,
    metadata: { 
      date: new Date().toISOString()
    },
    logs: logsData
  }, null, 2)], {type: 'application/json'});
  
  // 2. Persist to Drive
  let videoBlob;
  try {
    const dbBlob = await getVideoFromDB();
    if (dbBlob) {
      videoBlob = dbBlob;
    } else {
      // Fallback to memory base64
      const byteCharacters = atob(videoBase64);
      const byteArray = new Uint8Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteArray[i] = byteCharacters.charCodeAt(i);
      }
      videoBlob = new Blob([byteArray], {type: 'video/webm'});
    }
  } catch (err) {
    console.error("DB Fetch failed, falling back:", err);
    const byteCharacters = atob(videoBase64);
    const byteArray = new Uint8Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteArray[i] = byteCharacters.charCodeAt(i);
    }
    videoBlob = new Blob([byteArray], {type: 'video/webm'});
  }

  const timeStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sanitizedTitle = title.replace(/[^a-zA-Z0-9]/g, '_');
  
  const videoFileId = await uploadFileToDrive(token, `BERIBUG_${sanitizedTitle}_${timeStamp}.webm`, 'video/webm', videoBlob, folderId);
  const jsonFileId = await uploadFileToDrive(token, `BERIBUG_${sanitizedTitle}_${timeStamp}.json`, 'application/json', jsonBlob, folderId);

  await makeFilePublic(token, videoFileId);
  await makeFilePublic(token, jsonFileId); // Make JSON public as well to be read by Player

  // Give Google a moment to propagate permissions
  await new Promise(r => setTimeout(r, 1000));

  resetLogs();
  pendingVideoBase64 = null;
  chrome.storage.local.remove(['pendingVideo', 'pendingReport']);
  await clearVideoFromDB();
  
  // Return Hosted Player Web App URL (Netlify Public Link)
  return `https://dynamic-rabanadas-2b5f0b.netlify.app/?v=${videoFileId}&l=${jsonFileId}`;
}

async function getVideoFromDB() {
  return new Promise((resolve) => {
    const request = indexedDB.open("BERIBUG_Storage", 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("videos")) db.createObjectStore("videos");
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
    const request = indexedDB.open("BERIBUG_Storage", 1);
    request.onsuccess = (e) => {
      const db = e.target.result;
      const transaction = db.transaction("videos", "readwrite");
      const store = transaction.objectStore("videos");
      store.delete("pendingVideo");
      transaction.oncomplete = () => resolve();
    };
    request.onerror = () => resolve();
  });
}

async function getOrCreateFolder(token, folderName) {
  const query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`;
  
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  const json = await res.json();

  if (json.files && json.files.length > 0) {
    return json.files[0].id; // Folder exists
  }

  // Create folder
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder'
    })
  });
  const createJson = await createRes.json();
  return createJson.id;
}

async function uploadFileToDrive(token, filename, mimeType, fileBlob, folderId) {
  // 1. Create file metadata
  const metadata = {
    name: filename,
    mimeType: mimeType,
    parents: [folderId]
  };

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(metadata)
  });
  
  if (!createRes.ok) {
    throw new Error(`Failed to create file metadata: ${createRes.status} ${await createRes.text()}`);
  }
  
  const fileData = await createRes.json();
  const fileId = fileData.id;

  // 2. Upload file content (Simple Media Upload - supports up to 5TB)
  const uploadRes = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': mimeType
    },
    body: fileBlob
  });

  if (!uploadRes.ok) {
    throw new Error(`Failed to upload file content: ${uploadRes.status} ${await uploadRes.text()}`);
  }

  return fileId;
}

async function makeFilePublic(token, fileId) {
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      role: 'reader',
      type: 'anyone'
    })
  });
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
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
      'API-Version': '2023-10',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query })
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
        body: "Recorded Video & Logs: <br> <a href='${videoUrl}'>View on Google Drive</a>"
      ) { id }
    }
  `;

  await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
      'API-Version': '2023-10',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: updateQuery })
  });
}
