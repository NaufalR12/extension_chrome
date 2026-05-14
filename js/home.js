document.addEventListener('DOMContentLoaded', () => {
  const navMyBugs = document.getElementById('navMyBugs');
  const navTrash = document.getElementById('navTrash');
  const navSettings = document.getElementById('navSettings');
  const viewMyBugs = document.getElementById('viewMyBugs');
  const viewTrash = document.getElementById('viewTrash');
  const viewSettings = document.getElementById('viewSettings');
  const userEmailSpan = document.getElementById('userEmail');
  
  const btnRefresh = document.getElementById('btnRefresh');
  const btnRefreshTrash = document.getElementById('btnRefreshTrash');
  const btnLogout = document.getElementById('btnLogout');
  
  const loading = document.getElementById('loading');
  const errorMsg = document.getElementById('errorMsg');
  const bugTable = document.getElementById('bugTable');
  const bugListBody = document.getElementById('bugListBody');

  const loadingTrash = document.getElementById('loadingTrash');
  const errorMsgTrash = document.getElementById('errorMsgTrash');
  const trashTable = document.getElementById('trashTable');
  const trashListBody = document.getElementById('trashListBody');

  // Settings Elements
  const userNameDisplay = document.getElementById('userNameDisplay');
  const userEmailDisplay = document.getElementById('userEmailDisplay');
  const userPhoto = document.getElementById('userPhoto');
  const storageText = document.getElementById('storageText');
  const storageBarFill = document.getElementById('storageBarFill');
  const autoDeleteEnabled = document.getElementById('autoDeleteEnabled');
  const autoDeleteConfig = document.getElementById('autoDeleteConfig');
  const autoDeleteDays = document.getElementById('autoDeleteDays');
  const btnSaveSettings = document.getElementById('btnSaveSettings');

  // Modals
  const editModal = document.getElementById('editModal');
  const deleteModal = document.getElementById('deleteModal');
  let currentActionItem = null;

  let authToken = null;
  let userEmail = '';

  // Tab Navigation
  // Tab Navigation
  navMyBugs.addEventListener('click', () => {
    switchTab(navMyBugs, viewMyBugs);
    loadBugs();
  });
  navTrash.addEventListener('click', () => {
    switchTab(navTrash, viewTrash);
    loadTrash();
  });
  navSettings.addEventListener('click', () => {
    switchTab(navSettings, viewSettings);
    loadAccountInfo();
    loadAutoDeleteSettings();
  });

  function switchTab(navEl, viewEl) {
    document.querySelectorAll('.nav-menu li').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.view-panel').forEach(el => el.classList.remove('active'));
    navEl.classList.add('active');
    viewEl.classList.add('active');
  }

  // Init
  initAuth();

  function initAuth() {
    chrome.identity.getAuthToken({ interactive: true }, function(token) {
      if (chrome.runtime.lastError || !token) {
        userEmailSpan.textContent = 'Not logged in';
        showError("Authentication failed. Please login from the popup.");
        return;
      }
      authToken = token;
      
      // Get user email & full info
      fetch('https://www.googleapis.com/drive/v3/about?fields=user,storageQuota', {
        headers: { Authorization: `Bearer ${token}` }
      }).then(r => r.json()).then(data => {
        if (data.user) {
            userEmail = data.user.emailAddress;
            userEmailSpan.textContent = userEmail;
            
            // Also update settings page if open
            updateSettingsUI(data);
        }
      });

      loadBugs();
    });
  }

  // Load Data
  btnRefresh.addEventListener('click', loadBugs);

  async function loadBugs() {
    loading.classList.remove('hidden');
    bugTable.classList.add('hidden');
    errorMsg.classList.add('hidden');
    bugListBody.innerHTML = '';

    try {
      // 1. Get Folder ID
      const query = "name='BERIBUG_Reports_App' and mimeType='application/vnd.google-apps.folder' and trashed=false";
      let res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      let json = await res.json();
      if (!json.files || json.files.length === 0) {
        showError("Folder BERIBUG_Reports_App not found. Have you recorded any reports yet?");
        return;
      }
      const folderId = json.files[0].id;

      // 2. Get Files
      const fileQuery = `'${folderId}' in parents and trashed=false`;
      res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(fileQuery)}&fields=files(id,name,mimeType,createdTime)&orderBy=createdTime desc`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      json = await res.json();
      const files = json.files || [];

      // 3. Group by Timestamp
      // Expected name format: Bug_SanitizedTitle_TIMESTAMP.webm / .json
      const bugMap = {};

      files.forEach(f => {
        // Splitting by _
        const parts = f.name.split('_');
        if (parts.length >= 3) {
          const extPart = parts[parts.length - 1]; // TIMESTAMP.ext
          const tsParts = extPart.split('.');
          const ts = tsParts[0];
          const ext = tsParts[1];
          const rawTitle = parts.slice(1, parts.length - 1).join(' ');

          if (!bugMap[ts]) {
            bugMap[ts] = { id: ts, originalTitle: rawTitle, date: new Date(f.createdTime) };
          }
          if (ext === 'webm') bugMap[ts].videoFile = f;
          if (ext === 'json') bugMap[ts].jsonFile = f;
        }
      });

      const bugsArray = Object.values(bugMap)
        .filter(b => b.videoFile && b.jsonFile)
        .sort((a,b) => b.date - a.date);

      if (bugsArray.length === 0) {
        showError("No complete records found.");
        return;
      }

      // Render
      bugsArray.forEach(bug => {
        const tr = document.createElement('tr');
        
        const titleTd = document.createElement('td');
        titleTd.innerHTML = `<strong>${bug.originalTitle}</strong>`;
        
        const dateTd = document.createElement('td');
        dateTd.textContent = bug.date.toLocaleString();

        const assetsTd = document.createElement('td');
        assetsTd.textContent = "Video + JSON";
        
        const actionTd = document.createElement('td');
        actionTd.className = 'actions';
        
        const btnPlay = document.createElement('button');
        btnPlay.className = 'btn secondary btn-small';
        btnPlay.textContent = 'Play';
        btnPlay.onclick = () => window.open(`https://dynamic-rabanadas-2b5f0b.netlify.app/?v=${bug.videoFile.id}&l=${bug.jsonFile.id}`, '_blank');
        
        const btnEdit = document.createElement('button');
        btnEdit.className = 'btn primary btn-small';
        btnEdit.textContent = 'Edit';
        btnEdit.onclick = () => window.open(`review.html?v=${bug.videoFile.id}&l=${bug.jsonFile.id}&edit=true`, '_blank');

        const btnDel = document.createElement('button');
        btnDel.className = 'btn danger btn-small';
        btnDel.textContent = 'Delete';
        btnDel.onclick = () => openDeleteModal(bug);

        actionTd.appendChild(btnPlay);
        actionTd.appendChild(btnEdit);
        actionTd.appendChild(btnDel);

        tr.appendChild(titleTd);
        tr.appendChild(dateTd);
        tr.appendChild(assetsTd);
        tr.appendChild(actionTd);
        bugListBody.appendChild(tr);
      });

      loading.classList.add('hidden');
      bugTable.classList.remove('hidden');

    } catch (err) {
      showError(err.toString());
    }
  }

  async function loadTrash() {
    loadingTrash.classList.remove('hidden');
    trashTable.classList.add('hidden');
    errorMsgTrash.classList.add('hidden');
    trashListBody.innerHTML = '';

    try {
      // 1. Get Folder ID
      const query = "name='BERIBUG_Reports_App' and mimeType='application/vnd.google-apps.folder' and trashed=false";
      let res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      let json = await res.json();
      if (!json.files || json.files.length === 0) {
        showErrorTrash("Folder BERIBUG_Reports_App not found.");
        return;
      }
      const folderId = json.files[0].id;

      // 2. Get Trashed Files
      // Note: trashed=true is enough, but we want files in our app folder
      const fileQuery = `'${folderId}' in parents and trashed=true`;
      res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(fileQuery)}&fields=files(id,name,mimeType,createdTime)&orderBy=createdTime desc`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      json = await res.json();
      const files = json.files || [];

      // 3. Group by Timestamp (similar to loadBugs)
      const bugMap = {};
      files.forEach(f => {
        const parts = f.name.split('_');
        if (parts.length >= 3) {
          const extPart = parts[parts.length - 1];
          const tsParts = extPart.split('.');
          const ts = tsParts[0];
          const ext = tsParts[1];
          const rawTitle = parts.slice(1, parts.length - 1).join(' ');

          if (!bugMap[ts]) {
            bugMap[ts] = { id: ts, originalTitle: rawTitle, date: new Date(f.createdTime) };
          }
          if (ext === 'webm') bugMap[ts].videoFile = f;
          if (ext === 'json') bugMap[ts].jsonFile = f;
        }
      });

      const bugsArray = Object.values(bugMap)
        .filter(b => b.videoFile || b.jsonFile) // In trash, maybe only one is left?
        .sort((a,b) => b.date - a.date);

      if (bugsArray.length === 0) {
        showErrorTrash("Trash is empty.");
        return;
      }

      // Render Trash
      bugsArray.forEach(bug => {
        const tr = document.createElement('tr');
        
        const titleTd = document.createElement('td');
        titleTd.innerHTML = `<strong>${bug.originalTitle}</strong>`;
        
        const dateTd = document.createElement('td');
        dateTd.textContent = bug.date.toLocaleString();

        const assetsTd = document.createElement('td');
        assetsTd.textContent = (bug.videoFile && bug.jsonFile) ? "Video + JSON" : (bug.jsonFile ? "JSON Only" : "Video Only");
        
        const actionTd = document.createElement('td');
        actionTd.className = 'actions';
        
        const btnRestore = document.createElement('button');
        btnRestore.className = 'btn secondary btn-small';
        btnRestore.textContent = 'Restore';
        btnRestore.onclick = () => restoreBug(bug);
        
        const btnPermanentDel = document.createElement('button');
        btnPermanentDel.className = 'btn danger btn-small';
        btnPermanentDel.textContent = 'Delete Forever';
        btnPermanentDel.onclick = () => permanentDeleteFromTrash(bug);

        actionTd.appendChild(btnRestore);
        actionTd.appendChild(btnPermanentDel);

        tr.appendChild(titleTd);
        tr.appendChild(dateTd);
        tr.appendChild(assetsTd);
        tr.appendChild(actionTd);
        trashListBody.appendChild(tr);
      });

      loadingTrash.classList.add('hidden');
      trashTable.classList.remove('hidden');

    } catch (err) {
      showErrorTrash(err.toString());
    }
  }

  function showErrorTrash(msg) {
    loadingTrash.classList.add('hidden');
    errorMsgTrash.textContent = msg;
    errorMsgTrash.classList.remove('hidden');
  }

  btnRefreshTrash.addEventListener('click', loadTrash);

  async function restoreBug(bug) {
    if (!confirm(`Restore "${bug.originalTitle}"?`)) return;
    
    try {
      if (bug.jsonFile) {
        await fetch(`https://www.googleapis.com/drive/v3/files/${bug.jsonFile.id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ trashed: false })
        });
      }
      if (bug.videoFile) {
        await fetch(`https://www.googleapis.com/drive/v3/files/${bug.videoFile.id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ trashed: false })
        });
      }
      alert("Report restored.");
      loadTrash();
    } catch (err) {
      alert("Failed to restore: " + err);
    }
  }

  async function permanentDeleteFromTrash(bug) {
    if (!confirm(`DELETE PERMANENTLY "${bug.originalTitle}"?\nThis cannot be undone!`)) return;
    
    try {
      if (bug.jsonFile) {
        await fetch(`https://www.googleapis.com/drive/v3/files/${bug.jsonFile.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${authToken}` }
        });
      }
      if (bug.videoFile) {
        await fetch(`https://www.googleapis.com/drive/v3/files/${bug.videoFile.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${authToken}` }
        });
      }
      alert("Report deleted permanently.");
      loadTrash();
    } catch (err) {
      alert("Failed to delete: " + err);
    }
  }

  function showError(msg) {
    loading.classList.add('hidden');
    errorMsg.textContent = msg;
    errorMsg.classList.remove('hidden');
  }



  // --- DELETE LOGIC ---
  const btnConfirmTrash = document.getElementById('btnConfirmTrash');
  const btnConfirmPermanent = document.getElementById('btnConfirmPermanent');

  function openDeleteModal(bug) {
    currentActionItem = bug;
    deleteModal.classList.remove('hidden');
  }

  document.getElementById('btnCancelDelete').onclick = () => {
    deleteModal.classList.add('hidden');
  };

  btnConfirmTrash.onclick = async () => {
    const bug = currentActionItem;
    btnConfirmTrash.disabled = true;
    btnConfirmTrash.textContent = "Processing...";

    try {
      // Move JSON to trash
      await fetch(`https://www.googleapis.com/drive/v3/files/${bug.jsonFile.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true })
      });
      // Move Video to trash
      await fetch(`https://www.googleapis.com/drive/v3/files/${bug.videoFile.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true })
      });

      deleteModal.classList.add('hidden');
      btnConfirmTrash.textContent = "🗑️ Move to Trash (Safe)";
      btnConfirmTrash.disabled = false;
      loadBugs();

    } catch(err) {
      alert("Failed to trash: " + err);
      btnConfirmTrash.textContent = "🗑️ Move to Trash (Safe)";
      btnConfirmTrash.disabled = false;
    }
  };

  btnConfirmPermanent.onclick = async () => {
    if (!confirm("Are you ABSOLUTELY sure? This cannot be undone.")) return;
    
    const bug = currentActionItem;
    btnConfirmPermanent.disabled = true;
    btnConfirmPermanent.textContent = "Deleting...";

    try {
      // Delete JSON permanently
      await fetch(`https://www.googleapis.com/drive/v3/files/${bug.jsonFile.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` }
      });
      // Delete Video permanently
      await fetch(`https://www.googleapis.com/drive/v3/files/${bug.videoFile.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` }
      });

      deleteModal.classList.add('hidden');
      btnConfirmPermanent.textContent = "🔥 Delete Permanently (Irreversible)";
      btnConfirmPermanent.disabled = false;
      loadBugs();

    } catch(err) {
      alert("Failed to delete permanently: " + err);
      btnConfirmPermanent.textContent = "🔥 Delete Permanently (Irreversible)";
      btnConfirmPermanent.disabled = false;
    }
  };

  // --- LOGOUT LOGIC ---
  btnLogout.onclick = () => {
    if (!authToken) return;
    
    // Revoke from Google
    fetch('https://accounts.google.com/o/oauth2/revoke?token=' + authToken)
      .then(() => {
        // Remove from cache
        return new Promise(res => chrome.identity.removeCachedAuthToken({token: authToken}, res));
      })
      .then(() => {
        alert("Logged out successfully.");
        // Close window or reload
        window.close();
      })
      .catch(err => {
        alert("Logout error: " + err);
      });
  };

  // --- SETTINGS LOGIC ---
  function updateSettingsUI(data) {
    if (!data.user) return;
    userNameDisplay.textContent = data.user.displayName;
    userEmailDisplay.textContent = data.user.emailAddress;
    if (data.user.photoLink) {
      userPhoto.style.backgroundImage = `url(${data.user.photoLink})`;
    }

    if (data.storageQuota) {
      const used = parseInt(data.storageQuota.usage);
      const limit = parseInt(data.storageQuota.limit);
      const pct = (used / limit * 100).toFixed(1);
      
      storageText.textContent = `${formatSize(used)} / ${formatSize(limit)} (${pct}%)`;
      storageBarFill.style.width = pct + '%';
      
      if (pct > 90) storageBarFill.style.backgroundColor = '#d93025';
      else if (pct > 70) storageBarFill.style.backgroundColor = '#f29900';
    }
  }

  async function loadAccountInfo() {
    if (!authToken) return;
    try {
      const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user,storageQuota', {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await res.json();
      updateSettingsUI(data);
    } catch (e) { console.error("Failed to load account info:", e); }
  }

  function loadAutoDeleteSettings() {
    chrome.storage.local.get(['autoDeleteEnabled', 'autoDeleteDays'], (res) => {
      autoDeleteEnabled.checked = res.autoDeleteEnabled || false;
      autoDeleteDays.value = res.autoDeleteDays || 7;
      toggleAutoDeleteUI();
    });
  }

  function toggleAutoDeleteUI() {
    if (autoDeleteEnabled.checked) {
      autoDeleteConfig.classList.remove('hidden');
    } else {
      autoDeleteConfig.classList.add('hidden');
    }
  }

  autoDeleteEnabled.addEventListener('change', toggleAutoDeleteUI);

  btnSaveSettings.onclick = () => {
    const enabled = autoDeleteEnabled.checked;
    const days = parseInt(autoDeleteDays.value);

    chrome.storage.local.set({
      autoDeleteEnabled: enabled,
      autoDeleteDays: days
    }, () => {
      // Sync alarm
      chrome.runtime.sendMessage({ action: 'SYNC_AUTO_DELETE_ALARM' });
      
      const originalText = btnSaveSettings.textContent;
      btnSaveSettings.textContent = "Saved!";
      setTimeout(() => {
        btnSaveSettings.textContent = originalText;
      }, 2000);
    });
  };

  function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

});
