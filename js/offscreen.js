let mediaRecorder;
let recordedChunks = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  if (message.action === 'startRecording') {
    startRecordingFlow(sendResponse);
    return true; // async
  } else if (message.action === 'stopRecording') {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    sendResponse({ status: 'stopped' });
    return false;
  } else if (message.action === 'pauseRecording') {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.pause();
    }
    sendResponse({ status: 'paused' });
    return false;
  } else if (message.action === 'resumeRecording') {
    if (mediaRecorder && mediaRecorder.state === 'paused') {
      mediaRecorder.resume();
    }
    sendResponse({ status: 'resumed' });
    return false;
  }
});

async function startRecordingFlow(sendResponse) {
  try {
    const displayMediaOptions = {
      video: { displaySurface: "browser" },
      audio: false
    };
    
    const stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
    
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });

    mediaRecorder.ondataavailable = event => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      
      try {
        await saveVideoToDB(blob);
        chrome.runtime.sendMessage({
          action: 'recordingStopped',
          useDB: true
        });
      } catch (err) {
        console.error('Error saving video to DB, falling back to base64', err);
        const reader = new FileReader();
        reader.onloadend = () => {
          chrome.runtime.sendMessage({
            action: 'recordingStopped',
            base64data: reader.result.split(',')[1] // send base64
          });
        };
        reader.readAsDataURL(blob);
      }
      
      stream.getTracks().forEach(track => track.stop());
    };

    mediaRecorder.start();
    sendResponse({ status: 'started' });
  } catch (e) {
    console.error('Error starting recording:', e);
    sendResponse({ status: 'error', error: e.toString() });
  }
}

async function saveVideoToDB(blob) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("BERIBUG_Storage", 2);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("videos"))
        db.createObjectStore("videos");
    };
    request.onsuccess = (e) => {
      const db = e.target.result;
      const transaction = db.transaction("videos", "readwrite");
      const store = transaction.objectStore("videos");
      const putRequest = store.put(blob, "pendingVideo");
      putRequest.onsuccess = () => resolve();
      putRequest.onerror = () => reject(putRequest.error);
    };
    request.onerror = () => reject(request.error);
  });
}
