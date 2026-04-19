let isRecording = false;
let recordingStartTime = null;

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
  else if (type === 'NETWORK') logs.network.push(payload);
  else if (type === 'ACTIONS') logs.actions.push(payload);
  else if (type === 'BACKEND') logs.backend.push(payload);
  
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

// Listen to messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'LOG_CAPTURED') {
    if (isRecording) {
      appendLog(request.type, request.payload);
    }
  } else if (request.action === 'START_RECORDING') {
    resetLogs().then(() => {
      // Initialize info object
      chrome.storage.local.get(['sessionLogs'], (data) => {
        const logs = data.sessionLogs || {};
        logs.info = { url: request.payloadUrl || 'N/A' };
        chrome.storage.local.set({ sessionLogs: logs });
      });
      
      setupOffscreenDocument('offscreen.html').then(() => {
        chrome.runtime.sendMessage({ target: 'offscreen', action: 'startRecording' }, (response) => {
          if (response && response.status === 'started') {
            isRecording = true;
            recordingStartTime = Date.now();
            
            // Show widget on active tab (with fallback dynamic injection)
            chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
              if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, { action: 'SHOW_WIDGET' }).catch(() => {
                  // If it fails (due to extension reload without page refresh), force inject content script
                  chrome.scripting.executeScript({
                    target: { tabId: tabs[0].id },
                    files: ['content.js']
                  }, () => {
                    if (!chrome.runtime.lastError) {
                      // Try sending again after injection
                      chrome.tabs.sendMessage(tabs[0].id, { action: 'SHOW_WIDGET' }).catch(() => {});
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
  } else if (request.action === 'STOP_RECORDING') {
    isRecording = false;
    recordingStartTime = null;
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'stopRecording' });
    // Hide widget on active tab
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: 'HIDE_WIDGET' });
    });
    sendResponse({ status: 'stopped' });
    return true; // async
  } else if (request.action === 'PAUSE_RECORDING') {
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'pauseRecording' });
  } else if (request.action === 'RESUME_RECORDING') {
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'resumeRecording' });
  } else if (request.action === 'GET_RECORDING_STATE') {
    sendResponse({ isRecording });
  } else if (request.action === 'recordingStopped') {
    // Navigate to review page
    handleUploadProcess(request.base64data);
    chrome.offscreen.closeDocument();
  }
});

// Track navigations while recording, and restore floating widget when page changes
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (isRecording && changeInfo.status === 'complete' && tab.url) {
    // Prevent logging extension pages
    if (tab.url.startsWith('chrome-extension://')) return;

    // Log the navigation
    appendLog('ACTIONS', {
      time: new Date().toLocaleTimeString(),
      event: '🧭 Navigated to',
      element: tab.url
    });

    // Restore widget onto the newly loaded page
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      if (tabs[0] && tabs[0].id === tabId) {
         chrome.tabs.sendMessage(tabId, { action: 'SHOW_WIDGET' }).catch(() => {});
      }
    });
  }
});

async function handleUploadProcess(videoBase64) {
  try {
    const data = await chrome.storage.local.get(['sessionLogs', 'mondayKey', 'mondayBoard']);
    const logsData = data.sessionLogs || {};
    
    // Save to local storage for the review page
    // Using chrome.storage.local might fail for large videos due to quota. 
    // For MV3, we can open the page with a URL parameter and store data in background window memory or IndexedDB.
    // For simplicity since background is persistent enough right before tab opens, we'll assign it to a global variable.
    self.pendingVideoBase64 = videoBase64;
    
    // Open review page
    chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });

  } catch (err) {
    console.error("Upload error:", err);
  }
}

// Global accessor for review page to fetch
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'GET_PENDING_VIDEO') {
    sendResponse({ videoBase64: self.pendingVideoBase64 });
  } else if (request.action === 'COMMIT_UPLOAD') {
    // Trigger actual drive upload from review.html data
    commitUpload(request.title, request.description, self.pendingVideoBase64, request.info)
      .then(url => sendResponse({ success: true, url }))
      .catch(err => sendResponse({ success: false, error: err.toString() }));
    return true;
  }
});

async function commitUpload(title, desc, videoBase64, infoData) {
  const data = await chrome.storage.local.get(['sessionLogs']);
  const logsData = data.sessionLogs || {};
  
  // Masukkan Info Data ke dalam session logs agar seragam
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
  
  const videoData = Uint8Array.from(atob(videoBase64), c => c.charCodeAt(0));
  const videoBlob = new Blob([videoData], {type: 'video/webm'});

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
