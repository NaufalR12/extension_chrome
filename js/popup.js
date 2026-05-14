document.addEventListener('DOMContentLoaded', () => {
  // UI Elements
  const loginSection = document.getElementById('loginSection');
  const mainSection = document.getElementById('mainSection');
  const userStatusWrapper = document.getElementById('userStatusWrapper');
  const mainActions = document.getElementById('mainActions');
  const screenshotSection = document.getElementById('screenshotSection');
  
  const btnLogin = document.getElementById('btnLogin');
  const btnRecord = document.getElementById('btnRecord');
  const btnStop = document.getElementById('btnStop');
  const btnScreenshot = document.getElementById('btnScreenshot');
  const btnDashboard = document.getElementById('btnDashboard');

  const btnShotArea = document.getElementById('btnShotArea');
  const btnShotFull = document.getElementById('btnShotFull');
  const btnShotScroll = document.getElementById('btnShotScroll');
  const btnShotBack = document.getElementById('btnShotBack');

  const btnSaveSettings = document.getElementById('btnSaveSettings');
  const inputAutoDelete = document.getElementById('inputAutoDelete');
  const settingsMsg = document.getElementById('settingsMsg');
  const recordingTimer = document.getElementById('recordingTimer');
  const statusDot = document.getElementById('statusDot');
  const userStatus = document.getElementById('userStatus');

  let timerInterval = null;

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
    chrome.tabs.create({ url: chrome.runtime.getURL('html/home.html') });
  });

  function showMainActions() {
    screenshotSection.classList.add('hidden');
    mainActions.classList.remove('hidden');
  }

  function showScreenshotModes() {
    mainActions.classList.add('hidden');
    screenshotSection.classList.remove('hidden');
  }

  // Screenshot Button (show modes inside popup)
  btnScreenshot.addEventListener('click', () => {
    showScreenshotModes();
  });

  btnShotBack.addEventListener('click', showMainActions);

  async function startScreenshot(mode) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabsList) => {
      if (!tabsList || tabsList.length === 0) {
        alert('Tidak ada tab aktif.');
        return;
      }
      const tab = tabsList[0];
      chrome.runtime.sendMessage(
        {
          action: 'START_SCREENSHOT',
          mode,
          tabId: tab.id
        },
        (res) => {
          if (chrome.runtime.lastError) {
            alert('Gagal memulai screenshot: ' + chrome.runtime.lastError.message);
            return;
          }
          if (res && res.ok) {
            // Popup akan otomatis tertutup saat user klik halaman.
            window.close();
          } else {
            alert('Gagal memulai screenshot.');
          }
        }
      );
    });
  }

  btnShotArea.addEventListener('click', () => startScreenshot('area'));
  btnShotFull.addEventListener('click', () => startScreenshot('full'));
  btnShotScroll.addEventListener('click', () => startScreenshot('scroll'));

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
        
        if (res.startTime) {
          startPopupTimer(res.startTime, res.now);
        } else {
          // Recording started but picker is active
          userStatus.textContent = 'Selecting Screen...';
          statusDot.classList.add('dot-pulse');
        }
      } else {
        stopPopupTimer();
      }
    });
  }

  function startPopupTimer(startTime, nowTime) {
    if (timerInterval) clearInterval(timerInterval);
    
    recordingTimer.classList.remove('hidden');
    userStatus.textContent = 'Recording';
    statusDot.classList.add('dot-pulse');

    const update = () => {
      const now = Date.now();
      const offset = nowTime ? (now - nowTime) : 0;
      const elapsed = Math.floor((now - startTime + offset) / 1000);
      
      if (elapsed < 0) return;

      const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const s = (elapsed % 60).toString().padStart(2, '0');
      recordingTimer.textContent = `${m}:${s}`;
    };

    update();
    timerInterval = setInterval(update, 1000);
  }

  function stopPopupTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    recordingTimer.classList.add('hidden');
    userStatus.textContent = 'Ready';
    statusDot.classList.remove('dot-pulse');
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
          
          // Refresh state to start timer
          checkAuth();
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
