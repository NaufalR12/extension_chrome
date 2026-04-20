let isRecording = false;
let recordingStartTime = null;
let isPaused = false;
let cachedCountry = "Unknown";
let headerCache = new Map(); // Store headers by URL during recording

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

// webRequest Listeners
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!isRecording) return;
    const url = details.url;
    if (!headerCache.has(url)) headerCache.set(url, { request: {}, response: {} });
    const entry = headerCache.get(url);
    entry.request = maskHeaders(flattenHeaders(details.requestHeaders));
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (!isRecording) return;
    const url = details.url;
    if (!headerCache.has(url)) headerCache.set(url, { request: {}, response: {} });
    const entry = headerCache.get(url);
    entry.response = maskHeaders(flattenHeaders(details.responseHeaders));
    entry.status = details.statusCode;

    // Ekstrak Trace IDs dari response headers
    const traceHeaderNames = ['x-trace-id', 'x-request-id', 'traceparent', 'x-amzn-trace-id', 'cf-ray', 'x-b3-traceid'];
    const rawHeaders = flattenHeaders(details.responseHeaders);
    const traceIds = {};
    traceHeaderNames.forEach(h => {
      if (rawHeaders[h]) traceIds[h] = rawHeaders[h];
    });
    if (Object.keys(traceIds).length > 0) {
      entry.traceIds = traceIds;
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
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

// Append logs to storage
async function appendLog(type, payload) {
  const data = await chrome.storage.local.get(['sessionLogs']);
  const logs = data.sessionLogs || { console: [], network: [], actions: [], backend: [] };
  
  // Inject relative video timer
  if (recordingStartTime) {
    const elapsedSecs = Math.floor((Date.now() - recordingStartTime) / 1000);
    const m = Math.floor(elapsedSecs / 60).toString().padStart(2, '0');
    const s = (elapsedSecs % 60).toString().padStart(2, '0');
    payload.time = `[${m}:${s}] ` + (payload.time || "");
  }
  
  if (type === 'CONSOLE') logs.console.push(payload);
  else if (type === 'ACTIONS') logs.actions.push(payload);
  else if (type === 'BACKEND') logs.backend.push(payload);
  else if (type === 'NETWORK') {
    // Enrich static assets with headers from cache
    if (payload.isStatic && !payload.requestHeaders) {
      const cached = headerCache.get(payload.url);
      if (cached) {
        payload.requestHeaders = cached.request;
        payload.responseHeaders = cached.response;
        if (!payload.status) payload.status = cached.status;
      }
    }
    // Enrich dengan trace IDs dari cache
    const cached = headerCache.get(payload.url);
    if (cached && cached.traceIds) {
      payload.traceIds = cached.traceIds;
    }
    logs.network.push(payload);
    
    // Jika status 4xx atau 5xx, tambahkan ke backend sebagai API Failure
    const status = payload.status;
    if (status && typeof status === 'number' && status >= 400) {
      const traceInfo = payload.traceIds ? Object.entries(payload.traceIds).map(([k,v]) => `${k}: ${v}`).join(' | ') : '';
      logs.backend.push({
        time: payload.time,
        type: 'API Failure',
        message: `${payload.method} ${payload.url} → ${status}`,
        stack: traceInfo ? `Trace IDs:\n${traceInfo}` : '',
        source: payload.url
      });
    }
  }
  
  // Keep size manageable
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
    justification: 'Recording screen for bug report'
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
      chrome.storage.local.get(['sessionLogs'], (data) => {
        const logs = data.sessionLogs || {};
        logs.info = { 
          url: request.payloadUrl || 'N/A',
          location: cachedCountry || 'Unknown',
          timestamp: new Date().toLocaleString(),
          urlTimeline: [{ time: 0, url: request.payloadUrl || 'N/A' }]
        };
        chrome.storage.local.set({ sessionLogs: logs });
      });
      
      setupOffscreenDocument('offscreen.html').then(() => {
        chrome.runtime.sendMessage({ target: 'offscreen', action: 'startRecording' }, (response) => {
          if (response && response.status === 'started') {
            isRecording = true;
            recordingStartTime = Date.now();
            headerCache.clear();
            
            // Show widget on the active tab of the last focused window
            chrome.tabs.query({active: true, lastFocusedWindow: true}, function(tabs) {
              const targetTab = tabs[0];
              if (targetTab) {
                const elapsed = recordingStartTime ? Math.floor((Date.now() - recordingStartTime) / 1000) : 0;
                chrome.tabs.sendMessage(targetTab.id, { 
                  action: 'SHOW_WIDGET', 
                  startTime: elapsed, 
                  isPaused: isPaused 
                }).catch(() => {
                  chrome.scripting.executeScript({
                    target: { tabId: targetTab.id },
                    files: ['content.js']
                  }, () => {
                    if (!chrome.runtime.lastError) {
                      chrome.tabs.sendMessage(targetTab.id, { 
                        action: 'SHOW_WIDGET', 
                        startTime: elapsed, 
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
    sendResponse({ isRecording });
  } 
  
  else if (request.action === 'recordingStopped') {
    pendingVideoBase64 = request.base64data;
    chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
    chrome.offscreen.closeDocument();
  }

  // 3. Review & Upload
  else if (request.action === 'GET_PENDING_VIDEO') {
    sendResponse({ videoBase64: pendingVideoBase64 });
  } 
  
  else if (request.action === 'COMMIT_UPLOAD') {
    commitUpload(request.title, request.description, pendingVideoBase64, request.info)
      .then(url => sendResponse({ success: true, url }))
      .catch(err => sendResponse({ success: false, error: err.toString() }));
    return true;
  }
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

    chrome.storage.local.get(['sessionLogs'], (data) => {
      if (data.sessionLogs && data.sessionLogs.info && data.sessionLogs.info.urlTimeline) {
        const elapsedSecs = recordingStartTime ? Math.floor((Date.now() - recordingStartTime) / 1000) : 0;
        data.sessionLogs.info.urlTimeline.push({ time: elapsedSecs, url: tab.url });
        chrome.storage.local.set({ sessionLogs: data.sessionLogs });
      }
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
  const logsData = data.sessionLogs || {};
  
  // Preserve urlTimeline if exists
  if (logsData.info && logsData.info.urlTimeline) {
    infoData.urlTimeline = logsData.info.urlTimeline;
  }

  logsData.info = infoData || {
    browser: "Unknown",
    os: "Unknown",
    resolution: "-",
    url: "-"
  };

  const token = await new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({interactive: true}, (token) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(token);
    });
  });
  
  if (!token) throw new Error("Could not authenticate with Google");

  const folderId = await getOrCreateFolder(token, 'BugReports_App');

  const jsonBlob = new Blob([JSON.stringify({
    version: "1.0",
    title: title,
    description: desc,
    metadata: { 
      date: new Date().toISOString()
    },
    logs: logsData
  }, null, 2)], {type: 'application/json'});
  
  const videoBlob = await (await fetch(`data:video/webm;base64,${videoBase64}`)).blob();

  const timeStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sanitizedTitle = title.replace(/[^a-zA-Z0-9]/g, '_');
  
  const videoFileId = await uploadFileToDrive(token, `Bug_${sanitizedTitle}_${timeStamp}.webm`, 'video/webm', videoBlob, folderId);
  const jsonFileId = await uploadFileToDrive(token, `Bug_${sanitizedTitle}_${timeStamp}.json`, 'application/json', jsonBlob, folderId);

  await makeFilePublic(token, videoFileId);
  await makeFilePublic(token, jsonFileId); // Make JSON public as well to be read by Player

  resetLogs();
  self.pendingVideoBase64 = null; // Free up
  
  // Return Hosted Player Web App URL (Netlify Public Link)
  return `https://dynamic-rabanadas-2b5f0b.netlify.app/?v=${videoFileId}&l=${jsonFileId}`;
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
  const metadata = {
    name: filename,
    mimeType: mimeType,
    parents: [folderId]
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', fileBlob);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: form
  });
  const json = await res.json();
  return json.id; // File ID
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
