document.addEventListener('DOMContentLoaded', () => {
  const navMyBugs = document.getElementById('navMyBugs');
  const navSettings = document.getElementById('navSettings');
  const viewMyBugs = document.getElementById('viewMyBugs');
  const viewSettings = document.getElementById('viewSettings');
  const userEmailSpan = document.getElementById('userEmail');
  
  const btnRefresh = document.getElementById('btnRefresh');
  const btnLogout = document.getElementById('btnLogout');
  
  const loading = document.getElementById('loading');
  const errorMsg = document.getElementById('errorMsg');
  const bugTable = document.getElementById('bugTable');
  const bugListBody = document.getElementById('bugListBody');

  // Modals
  const editModal = document.getElementById('editModal');
  const deleteModal = document.getElementById('deleteModal');
  let currentActionItem = null;

  let authToken = null;
  let userEmail = '';

  // Tab Navigation
  navMyBugs.addEventListener('click', () => switchTab(navMyBugs, viewMyBugs));
  navSettings.addEventListener('click', () => switchTab(navSettings, viewSettings));

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
      
      // Get user email
      fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${token}` }
      }).then(r => r.json()).then(data => {
        userEmail = data.email;
        userEmailSpan.textContent = userEmail;
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
      const query = "name='TRACE_Reports_App' and mimeType='application/vnd.google-apps.folder' and trashed=false";
      let res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      let json = await res.json();
      if (!json.files || json.files.length === 0) {
        showError("Folder TRACE_Reports_App not found. Have you recorded any reports yet?");
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
        btnPlay.onclick = () => window.open(`http://localhost:5500/index.html?v=${bug.videoFile.id}&l=${bug.jsonFile.id}`, '_blank');
        
        const btnEdit = document.createElement('button');
        btnEdit.className = 'btn primary btn-small';
        btnEdit.textContent = 'Edit';
        btnEdit.onclick = () => openEditModal(bug);

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

  function showError(msg) {
    loading.classList.add('hidden');
    errorMsg.textContent = msg;
    errorMsg.classList.remove('hidden');
  }

  // --- EDIT LOGIC ---
  const inputEditTitle = document.getElementById('editTitle');
  const inputEditDesc = document.getElementById('editDesc');
  const btnSaveEdit = document.getElementById('btnSaveEdit');

  async function openEditModal(bug) {
    currentActionItem = bug;
    inputEditTitle.value = bug.originalTitle;
    inputEditDesc.value = "Loading description...";
    btnSaveEdit.disabled = true;
    editModal.classList.remove('hidden');

    // Fetch JSON content to get the real description
    try {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${bug.jsonFile.id}?alt=media`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await res.json();
      inputEditDesc.value = data.description || '';
      currentActionItem.fullJsonData = data; // store it to re-upload
      btnSaveEdit.disabled = false;
    } catch (err) {
      inputEditDesc.value = "Error loading desc.";
      console.error(err);
    }
  }

  document.getElementById('btnCancelEdit').onclick = () => {
    editModal.classList.add('hidden');
  };

  btnSaveEdit.onclick = async () => {
    const bug = currentActionItem;
    const newTitle = inputEditTitle.value.trim();
    const newDesc = inputEditDesc.value.trim();

    if (!newTitle) return;
    
    btnSaveEdit.disabled = true;
    btnSaveEdit.textContent = "Saving...";

    try {
      // 1. Update JSON Content
      bug.fullJsonData.title = newTitle;
      bug.fullJsonData.description = newDesc;
      
      const jsonBlob = new Blob([JSON.stringify(bug.fullJsonData, null, 2)], {type: 'application/json'});
      
      await fetch(`https://www.googleapis.com/upload/drive/v3/files/${bug.jsonFile.id}?uploadType=media`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${authToken}` },
        body: jsonBlob
      });

      // 2. Rename Files to match new title format (Bug_Title_Timestamp.*)
      const sanitizedTitle = newTitle.replace(/[^a-zA-Z0-9]/g, '_');
      const newVideoName = `Trace_${sanitizedTitle}_${bug.id}.webm`;
      const newJsonName = `Trace_${sanitizedTitle}_${bug.id}.json`;

      await fetch(`https://www.googleapis.com/drive/v3/files/${bug.videoFile.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newVideoName })
      });

      await fetch(`https://www.googleapis.com/drive/v3/files/${bug.jsonFile.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newJsonName })
      });

      editModal.classList.add('hidden');
      btnSaveEdit.textContent = "Save Changes";
      loadBugs(); // refresh

    } catch (err) {
      alert("Failed to edit: " + err);
      btnSaveEdit.textContent = "Save Changes";
      btnSaveEdit.disabled = false;
    }
  };


  // --- DELETE LOGIC ---
  const btnConfirmDelete = document.getElementById('btnConfirmDelete');

  function openDeleteModal(bug) {
    currentActionItem = bug;
    deleteModal.classList.remove('hidden');
  }

  document.getElementById('btnCancelDelete').onclick = () => {
    deleteModal.classList.add('hidden');
  };

  btnConfirmDelete.onclick = async () => {
    const bug = currentActionItem;
    btnConfirmDelete.disabled = true;
    btnConfirmDelete.textContent = "Deleting...";

    try {
      // Delete JSON
      await fetch(`https://www.googleapis.com/drive/v3/files/${bug.jsonFile.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` }
      });
      // Delete Video
      await fetch(`https://www.googleapis.com/drive/v3/files/${bug.videoFile.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` }
      });

      deleteModal.classList.add('hidden');
      btnConfirmDelete.textContent = "Yes, Delete It";
      btnConfirmDelete.disabled = false;
      loadBugs();

    } catch(err) {
      alert("Failed to delete: " + err);
      btnConfirmDelete.textContent = "Yes, Delete It";
      btnConfirmDelete.disabled = false;
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

});
