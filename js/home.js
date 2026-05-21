import { getAccessToken, login, logout } from './auth.js';

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
  let mainFolderId = null;
  let trashFolderId = null;

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
    getAccessToken().then(token => {
      if (!token) {
        login().then(newToken => {
          if (!newToken) {
            userEmailSpan.textContent = 'Not logged in';
            showError("Authentication failed. Please login.");
            return;
          }
          authToken = newToken;
          onAuthSuccess();
        }).catch(err => {
          userEmailSpan.textContent = 'Not logged in';
          showError("Authentication failed: " + err.message);
        });
      } else {
        authToken = token;
        onAuthSuccess();
      }
    });
  }

  async function onAuthSuccess() {
    try {
      const userRes = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const userData = await userRes.json();
      userEmail = userData.userPrincipalName || userData.mail || 'OneDrive User';
      userEmailSpan.textContent = userEmail;
    } catch (e) {
      console.error("Failed to fetch user email:", e);
    }
    loadBugs();
  }

  // Helper Functions
  async function getOrCreateFolder(token, name, parentId = null) {
    const parentPath = parentId ? `items/${parentId}` : 'root';
    const checkUrl = `https://graph.microsoft.com/v1.0/me/drive/${parentPath}:/${name}`;
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

    const createUrl = `https://graph.microsoft.com/v1.0/me/drive/${parentPath}/children`;
    const createRes = await fetch(createUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: name,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail"
      })
    });

    if (!createRes.ok) {
      const checkRes = await fetch(checkUrl, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (checkRes.ok) {
        const data = await checkRes.json();
        return data.id;
      }
      throw new Error(`Failed to create folder ${name}: ${createRes.status}`);
    }
    const data = await createRes.json();
    return data.id;
  }

  async function moveFileToFolder(fileId, targetFolderId) {
    const url = `https://graph.microsoft.com/v1.0/me/drive/items/${fileId}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parentReference: {
          id: targetFolderId
        }
      })
    });
    if (!res.ok) throw new Error(`Failed to move file ${fileId}: ${res.status}`);
    return await res.json();
  }

  async function deleteFile(fileId) {
    const url = `https://graph.microsoft.com/v1.0/me/drive/items/${fileId}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete file ${fileId}: ${res.status}`);
    }
  }

  async function getSharingLink(fileId) {
    const url = `https://graph.microsoft.com/v1.0/me/drive/items/${fileId}/createLink`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        type: "view",
        scope: "anonymous"
      })
    });
    if (!res.ok) throw new Error("Failed to get sharing link: " + res.status);
    const data = await res.json();
    return data.link.webUrl;
  }

  async function getOrCreateDirectUrl(fileId) {
    const sharingLink = await getSharingLink(fileId);
    const base64Value = btoa(sharingLink);
    const safeBase64Value = base64Value
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    return `https://api.onedrive.com/v1.0/shares/u!${safeBase64Value}/root/content`;
  }

  // Load Data
  btnRefresh.addEventListener('click', loadBugs);

  async function loadBugs() {
    loading.classList.remove('hidden');
    bugTable.classList.add('hidden');
    errorMsg.classList.add('hidden');
    bugListBody.innerHTML = '';

    try {
      mainFolderId = await getOrCreateFolder(authToken, "BERIBUG_Reports_App");
      
      const fileUrl = `https://graph.microsoft.com/v1.0/me/drive/items/${mainFolderId}/children?$orderby=createdDateTime desc`;
      const res = await fetch(fileUrl, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      if (!res.ok) throw new Error("Gagal memuat file dari OneDrive: " + res.status);
      const json = await res.json();
      const files = json.value || [];

      const bugMap = {};

      files.forEach(f => {
        if (f.folder) return; // Skip subfolders like Trash
        const parts = f.name.split('_');
        if (parts.length >= 3) {
          const extPart = parts[parts.length - 1]; // TIMESTAMP.ext
          const tsParts = extPart.split('.');
          const ts = tsParts[0];
          const ext = tsParts[1];
          const rawTitle = parts.slice(1, parts.length - 1).join(' ');

          if (!bugMap[ts]) {
            bugMap[ts] = { id: ts, originalTitle: rawTitle, date: new Date(f.createdDateTime || f.fileSystemInfo?.createdDateTime || Date.now()) };
          }
          if (ext === 'webm') bugMap[ts].videoFile = f;
          if (ext === 'png') bugMap[ts].imageFile = f;
          if (ext === 'json') bugMap[ts].jsonFile = f;
        }
      });

      const bugsArray = Object.values(bugMap)
        .filter(b => (b.videoFile || b.imageFile) && b.jsonFile)
        .sort((a,b) => b.date - a.date);

      if (bugsArray.length === 0) {
        showError("No complete records found.");
        return;
      }

      bugsArray.forEach(bug => {
        const tr = document.createElement('tr');
        
        const titleTd = document.createElement('td');
        titleTd.innerHTML = `<strong>${bug.originalTitle}</strong>`;
        
        const dateTd = document.createElement('td');
        dateTd.textContent = bug.date.toLocaleString();

        const assetsTd = document.createElement('td');
        assetsTd.textContent = bug.videoFile ? "Video + JSON" : "Screenshot + JSON";
        
        const actionTd = document.createElement('td');
        actionTd.className = 'actions';

        if (bug.videoFile) {
          const btnPlay = document.createElement('button');
          btnPlay.className = 'btn secondary btn-small';
          btnPlay.textContent = 'Play';
          btnPlay.onclick = async () => {
            btnPlay.disabled = true;
            btnPlay.textContent = 'Linking...';
            try {
              const vUrl = await getOrCreateDirectUrl(bug.videoFile.id);
              const lUrl = await getOrCreateDirectUrl(bug.jsonFile.id);
              window.open(`https://dynamic-rabanadas-2b5f0b.netlify.app/?vUrl=${encodeURIComponent(vUrl)}&lUrl=${encodeURIComponent(lUrl)}`, '_blank');
            } catch (e) {
              alert("Error: " + e.message);
            } finally {
              btnPlay.disabled = false;
              btnPlay.textContent = 'Play';
            }
          };

          const btnEdit = document.createElement('button');
          btnEdit.className = 'btn primary btn-small';
          btnEdit.textContent = 'Edit';
          btnEdit.onclick = () => window.open(`review.html?v=${bug.videoFile.id}&l=${bug.jsonFile.id}&edit=true`, '_blank');

          actionTd.appendChild(btnPlay);
          actionTd.appendChild(btnEdit);
        } else if (bug.imageFile) {
          const btnOpen = document.createElement('button');
          btnOpen.className = 'btn secondary btn-small';
          btnOpen.textContent = 'Open';
          btnOpen.onclick = async () => {
            btnOpen.disabled = true;
            btnOpen.textContent = 'Linking...';
            try {
              const shareLink = await getSharingLink(bug.imageFile.id);
              window.open(shareLink, '_blank');
            } catch (e) {
              alert("Error: " + e.message);
            } finally {
              btnOpen.disabled = false;
              btnOpen.textContent = 'Open';
            }
          };
          actionTd.appendChild(btnOpen);
        }

        const btnDel = document.createElement('button');
        btnDel.className = 'btn danger btn-small';
        btnDel.textContent = 'Delete';
        btnDel.onclick = () => openDeleteModal(bug);

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

  btnRefreshTrash.addEventListener('click', loadTrash);

  async function loadTrash() {
    loadingTrash.classList.remove('hidden');
    trashTable.classList.add('hidden');
    errorMsgTrash.classList.add('hidden');
    trashListBody.innerHTML = '';

    try {
      mainFolderId = await getOrCreateFolder(authToken, "BERIBUG_Reports_App");
      trashFolderId = await getOrCreateFolder(authToken, "Trash", mainFolderId);

      const fileUrl = `https://graph.microsoft.com/v1.0/me/drive/items/${trashFolderId}/children?$orderby=createdDateTime desc`;
      const res = await fetch(fileUrl, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      if (!res.ok) throw new Error("Gagal memuat Trash dari OneDrive: " + res.status);
      const json = await res.json();
      const files = json.value || [];

      const bugMap = {};
      files.forEach(f => {
        if (f.folder) return;
        const parts = f.name.split('_');
        if (parts.length >= 3) {
          const extPart = parts[parts.length - 1];
          const tsParts = extPart.split('.');
          const ts = tsParts[0];
          const ext = tsParts[1];
          const rawTitle = parts.slice(1, parts.length - 1).join(' ');

          if (!bugMap[ts]) {
            bugMap[ts] = { id: ts, originalTitle: rawTitle, date: new Date(f.createdDateTime || f.fileSystemInfo?.createdDateTime || Date.now()) };
          }
          if (ext === 'webm') bugMap[ts].videoFile = f;
          if (ext === 'png') bugMap[ts].imageFile = f;
          if (ext === 'json') bugMap[ts].jsonFile = f;
        }
      });

      const bugsArray = Object.values(bugMap)
        .filter(b => b.videoFile || b.imageFile || b.jsonFile)
        .sort((a,b) => b.date - a.date);

      if (bugsArray.length === 0) {
        showErrorTrash("Trash is empty.");
        return;
      }

      bugsArray.forEach(bug => {
        const tr = document.createElement('tr');
        
        const titleTd = document.createElement('td');
        titleTd.innerHTML = `<strong>${bug.originalTitle}</strong>`;
        
        const dateTd = document.createElement('td');
        dateTd.textContent = bug.date.toLocaleString();

        const assetsTd = document.createElement('td');
        if (bug.videoFile && bug.jsonFile) assetsTd.textContent = "Video + JSON";
        else if (bug.imageFile && bug.jsonFile) assetsTd.textContent = "Screenshot + JSON";
        else if (bug.jsonFile) assetsTd.textContent = "JSON Only";
        else if (bug.videoFile) assetsTd.textContent = "Video Only";
        else if (bug.imageFile) assetsTd.textContent = "Screenshot Only";
        else assetsTd.textContent = "Unknown";
        
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

  async function restoreBug(bug) {
    if (!confirm(`Restore "${bug.originalTitle}"?`)) return;
    
    try {
      mainFolderId = await getOrCreateFolder(authToken, "BERIBUG_Reports_App");
      
      if (bug.jsonFile) {
        await moveFileToFolder(bug.jsonFile.id, mainFolderId);
      }
      if (bug.videoFile) {
        await moveFileToFolder(bug.videoFile.id, mainFolderId);
      }
      if (bug.imageFile) {
        await moveFileToFolder(bug.imageFile.id, mainFolderId);
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
        await deleteFile(bug.jsonFile.id);
      }
      if (bug.videoFile) {
        await deleteFile(bug.videoFile.id);
      }
      if (bug.imageFile) {
        await deleteFile(bug.imageFile.id);
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
      mainFolderId = await getOrCreateFolder(authToken, "BERIBUG_Reports_App");
      trashFolderId = await getOrCreateFolder(authToken, "Trash", mainFolderId);

      // Move JSON to trash
      await moveFileToFolder(bug.jsonFile.id, trashFolderId);
      
      // Move Video/Image to trash
      if (bug.videoFile) {
        await moveFileToFolder(bug.videoFile.id, trashFolderId);
      }
      if (bug.imageFile) {
        await moveFileToFolder(bug.imageFile.id, trashFolderId);
      }

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
      await deleteFile(bug.jsonFile.id);
      // Delete Video/Image permanently
      if (bug.videoFile) {
        await deleteFile(bug.videoFile.id);
      }
      if (bug.imageFile) {
        await deleteFile(bug.imageFile.id);
      }

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
  btnLogout.onclick = async () => {
    try {
      await logout();
      alert("Logged out successfully.");
      window.close();
    } catch (err) {
      alert("Logout error: " + err);
    }
  };

  // --- SETTINGS LOGIC ---
  function updateSettingsUI(userData, driveData, photoUrl) {
    userNameDisplay.textContent = userData.displayName || 'OneDrive User';
    userEmailDisplay.textContent = userData.userPrincipalName || userData.mail || '';
    
    if (photoUrl) {
      userPhoto.style.backgroundImage = `url(${photoUrl})`;
    } else {
      userPhoto.style.backgroundImage = 'none';
      userPhoto.textContent = (userData.displayName || 'U').substring(0, 1).toUpperCase();
    }

    if (driveData && driveData.quota) {
      const used = driveData.quota.used;
      const limit = driveData.quota.total;
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
      const userRes = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const userData = await userRes.json();
      
      const driveRes = await fetch('https://graph.microsoft.com/v1.0/me/drive', {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const driveData = await driveRes.json();

      let photoUrl = '';
      try {
        const photoRes = await fetch('https://graph.microsoft.com/v1.0/me/photo/$value', {
          headers: { Authorization: `Bearer ${authToken}` }
        });
        if (photoRes.ok) {
          const blob = await photoRes.blob();
          photoUrl = URL.createObjectURL(blob);
        }
      } catch (e) {
        console.warn("Failed to fetch profile photo:", e);
      }

      updateSettingsUI(userData, driveData, photoUrl);
    } catch (e) { 
      console.error("Failed to load account info:", e); 
    }
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
