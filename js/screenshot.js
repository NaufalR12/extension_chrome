/**
 * BERIBUG Screenshot Preview Page
 * - Background service worker performs capture (area/full/scroll)
 * - This page shows preview + download + upload to Drive
 */

let pending = null; // { meta, imageDataUrl, createdAt }
let authToken = null;

const modeSelector = document.getElementById('modeSelector');
const areaSelector = document.getElementById('areaSelector');
const loadingScreen = document.getElementById('loadingScreen');
const previewScreen = document.getElementById('previewScreen');

const previewImage = document.getElementById('previewImage');
const screenshotTitle = document.getElementById('screenshotTitle');
const btnDownload = document.getElementById('btnDownload');
const btnSaveToDrive = document.getElementById('btnSaveToDrive');
const btnRetake = document.getElementById('btnRetake');
const btnClosePreview = document.getElementById('btnClosePreview');

const uploadStatus = document.getElementById('uploadStatus');
const successMessage = document.getElementById('successMessage');
const statusIcon = document.getElementById('statusIcon');
const statusText = document.getElementById('statusText');
const statusProgressFill = document.getElementById('statusProgressFill');
const loadingText = document.getElementById('loadingText');
const successText = document.getElementById('successText');
const btnViewInDrive = document.getElementById('btnViewInDrive');

function switchScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(screenId);
  if (el) el.classList.add('active');
}

function sanitizeTitleForFileName(title) {
  return String(title || 'Screenshot').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Screenshot';
}

function makeTimeStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function initAuth() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) {
        authToken = token;
      }
      resolve();
    });
  });
}

async function loadPendingScreenshot() {
  const data = await chrome.storage.local.get(['pendingScreenshot']);
  if (!data.pendingScreenshot) return null;
  return data.pendingScreenshot;
}

function setDefaultTitle(meta) {
  const now = new Date();
  const timeStr = now.toLocaleString('id-ID', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  const mode = meta?.mode === 'area' ? 'Area' : (meta?.mode === 'scroll' ? 'Scroll' : 'Full');
  screenshotTitle.value = `Screenshot ${mode} ${timeStr}`;
}

function showPreview() {
  if (!pending?.imageDataUrl) {
    switchScreen('modeSelector');
    return;
  }

  // Hide unused screens (selection is on page, not here)
  if (modeSelector) modeSelector.style.display = 'none';
  if (areaSelector) areaSelector.style.display = 'none';

  previewImage.src = pending.imageDataUrl;
  setDefaultTitle(pending.meta);
  switchScreen('previewScreen');
}

function downloadScreenshot() {
  const title = screenshotTitle.value || 'Screenshot';
  const safe = sanitizeTitleForFileName(title);
  const filename = `BERIBUG_${safe}_${makeTimeStamp()}.png`;

  const link = document.createElement('a');
  link.href = pending.imageDataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function updateProgress(percent, text) {
  statusProgressFill.style.width = `${percent}%`;
  if (text) statusText.textContent = text;
}

async function getOrCreateFolder() {
  const query = "name='BERIBUG_Reports_App' and mimeType='application/vnd.google-apps.folder' and trashed=false";
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${authToken}` } }
  );
  const json = await res.json();
  if (json.files && json.files.length > 0) return json.files[0].id;

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: 'BERIBUG_Reports_App',
      mimeType: 'application/vnd.google-apps.folder'
    })
  });
  const createJson = await createRes.json();
  if (!createJson.id) throw new Error('Gagal membuat folder Drive');
  return createJson.id;
}

async function uploadMultipart(metadata, fileBlob) {
  const formData = new FormData();
  formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  formData.append('file', fileBlob);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,webContentLink', {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` },
    body: formData
  });
  if (!res.ok) throw new Error(`Upload gagal: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function makeFilePublic(fileId) {
  // Make it publicly readable so we can show a link.
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ role: 'reader', type: 'anyone' })
  });
}

async function saveScreenshotToDrive() {
  if (!authToken) {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (!token) {
        alert('Anda harus login dengan Google terlebih dahulu.');
        return;
      }
      authToken = token;
      saveScreenshotToDrive();
    });
    return;
  }

  uploadStatus.classList.remove('hidden');
  statusIcon.textContent = '⏳';
  updateProgress(5, 'Menyiapkan upload...');

  try {
    const title = screenshotTitle.value || 'Screenshot';
    const safe = sanitizeTitleForFileName(title);
    const ts = makeTimeStamp();

    const folderId = await getOrCreateFolder();
    updateProgress(25, 'Mengupload gambar...');

    const imgRes = await fetch(pending.imageDataUrl);
    const imgBlob = await imgRes.blob();

    const imgMeta = {
      name: `BERIBUG_${safe}_${ts}.png`,
      parents: [folderId]
    };

    const imgFile = await uploadMultipart(imgMeta, imgBlob);
    updateProgress(60, 'Mengupload metadata...');

    const metaObj = {
      type: 'screenshot',
      title,
      mode: pending?.meta?.mode || 'unknown',
      capturedAt: pending?.meta?.capturedAt || new Date().toISOString()
    };

    const metaBlob = new Blob([JSON.stringify(metaObj, null, 2)], { type: 'application/json' });
    const jsonMeta = {
      name: `BERIBUG_${safe}_${ts}.json`,
      parents: [folderId]
    };

    const jsonFile = await uploadMultipart(jsonMeta, metaBlob);

    updateProgress(80, 'Membuat link...');
    await makeFilePublic(imgFile.id);
    await makeFilePublic(jsonFile.id);

    updateProgress(100, 'Selesai');
    uploadStatus.classList.add('hidden');

    const viewLink = imgFile.webViewLink || `https://drive.google.com/file/d/${imgFile.id}/view`;
    successText.innerHTML = `Link screenshot: <a href="${viewLink}" target="_blank" rel="noreferrer">${viewLink}</a>`;

    successMessage.classList.remove('hidden');

    btnViewInDrive.onclick = () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('html/home.html') });
      window.close();
    };

    // Clear pending data so refresh won't re-show old screenshot
    chrome.storage.local.remove(['pendingScreenshot']);
  } catch (e) {
    console.error(e);
    uploadStatus.classList.add('hidden');
    alert('Upload gagal: ' + e.message);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Screens should exist, default to loading
  switchScreen('loadingScreen');
  loadingText.textContent = 'Menyiapkan preview screenshot...';

  await initAuth();

  pending = await loadPendingScreenshot();
  if (!pending || !pending.imageDataUrl) {
    const hash = window.location.hash || '';
    const errorMatch = hash.match(/error=([^&]+)/);
    const errorMsg = errorMatch ? decodeURIComponent(errorMatch[1]) : null;

    // Opened manually: do not start capture here (mode selector is in popup)
    switchScreen('modeSelector');

    const title = modeSelector?.querySelector('h1');
    const desc = modeSelector?.querySelector('p');
    if (title) title.textContent = '📸 Screenshot';
    if (desc) {
      desc.textContent = errorMsg
        ? `Gagal: ${errorMsg}`
        : 'Mulai screenshot dari popup extension (ikon BERIBUG di toolbar).';
    }

    // Hide mode buttons except Cancel
    const btnArea = document.getElementById('btnAreaSelect');
    const btnFull = document.getElementById('btnFullPage');
    const btnScroll = document.getElementById('btnScrollPage');
    if (btnArea) btnArea.style.display = 'none';
    if (btnFull) btnFull.style.display = 'none';
    if (btnScroll) btnScroll.style.display = 'none';

    const btnCancel = document.getElementById('btnCancel');
    if (btnCancel) {
      btnCancel.addEventListener('click', () => window.close());
      const modeTitle = btnCancel.querySelector('.mode-title');
      if (modeTitle) modeTitle.textContent = 'Tutup';
    }

    // Also hide any legacy area selection screen
    if (areaSelector) areaSelector.style.display = 'none';
    return;
  }

  showPreview();

  btnDownload.addEventListener('click', downloadScreenshot);
  btnSaveToDrive.addEventListener('click', saveScreenshotToDrive);
  btnRetake.addEventListener('click', () => {
    // Popup cannot be reliably opened as a normal tab.
    alert('Untuk ulang screenshot, klik ikon BERIBUG di toolbar lalu pilih Screenshot.');
    window.close();
  });
  btnClosePreview.addEventListener('click', () => window.close());
});
