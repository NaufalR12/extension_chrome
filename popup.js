document.addEventListener('DOMContentLoaded', () => {
  // UI Elements
  const loginSection = document.getElementById('loginSection');
  const mainSection = document.getElementById('mainSection');
  const userStatusWrapper = document.getElementById('userStatusWrapper');
  
  const btnLogin = document.getElementById('btnLogin');
  const btnRecord = document.getElementById('btnRecord');
  const btnStop = document.getElementById('btnStop');
  const btnScreenshot = document.getElementById('btnScreenshot');
  const btnDashboard = document.getElementById('btnDashboard');

  const btnSaveSettings = document.getElementById('btnSaveSettings');
  const inputAutoDelete = document.getElementById('inputAutoDelete');
  const settingsMsg = document.getElementById('settingsMsg');

  // Load Settings
  chrome.storage.local.get(['autoDeleteDays'], (res) => {
    if (res.autoDeleteDays) inputAutoDelete.value = res.autoDeleteDays;
  });

  // Settings Save
  btnSaveSettings.addEventListener('click', () => {
    chrome.storage.local.set({ autoDeleteDays: inputAutoDelete.value }, () => {
      settingsMsg.classList.remove('hidden');
      setTimeout(() => settingsMsg.classList.add('hidden'), 2000);
    });
  });

  // Dashboard Button
  btnDashboard.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('home.html') });
  });

  // Screenshot Button (Placeholder)
  btnScreenshot.addEventListener('click', () => {
    alert("Screenshot feature is coming soon!");
  });

  // Check Auth Status
  function checkAuth() {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) {
        loginSection.classList.add('hidden');
        userStatusWrapper.classList.remove('hidden');
        mainSection.classList.remove('hidden');
      } else {
        loginSection.classList.remove('hidden');
        userStatusWrapper.classList.add('hidden');
        mainSection.classList.add('hidden');
      }
    });

    // Also check recording state
    chrome.runtime.sendMessage({ action: 'GET_RECORDING_STATE' }, (res) => {
      if (res && res.isRecording) {
        btnRecord.classList.add('hidden');
        btnStop.classList.remove('hidden');
      }
    });
  }

  checkAuth();

  // Login Action
  btnLogin.addEventListener('click', () => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (token) {
        checkAuth();
      } else {
        alert("Login failed or cancelled.");
      }
    });
  });

  // Record Action
  btnRecord.addEventListener('click', () => {
    // 1. Ask background to record this tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabsList) => {
      let currentUrl = 'N/A';
      if (tabsList.length > 0) currentUrl = tabsList[0].url;

      chrome.runtime.sendMessage({ 
        action: 'START_RECORDING',
        payloadUrl: currentUrl
      }, (res) => {
        if(res && res.status === 'started') {
          btnRecord.classList.add('hidden');
          btnStop.classList.remove('hidden');
        }
      });
    });
  });

  // Stop Action
  btnStop.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'STOP_RECORDING' }, (res) => {
      if(res && res.status === 'stopped') {
        window.close(); // Close popup when done
      }
    });
  });

});
