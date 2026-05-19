/**
 * BERIBUG Screenshot Preview Page - REFACTORED ARCHITECTURE
 * 
 * Fix for all render pipeline issues:
 * 1. Image fully loaded before editor initialization
 * 2. 3-layer canvas system (base + annotation + interaction)
 * 3. Viewport transform (no CSS scale)
 * 4. World coordinates for precise annotation
 * 5. Proper lifecycle management
 * 6. RequestAnimationFrame for smooth rendering
 */

// ==================== STATE MANAGEMENT ====================
let pending = null; // { meta, imageDataUrl, createdAt }
let authToken = null;

// Image ready state
let imageReady = false;
let originalImageBitmap = null;
let originalImageWidth = 0;
let originalImageHeight = 0;

// Canvas layers
let baseCanvas = null;
let annotationCanvas = null;
let interactionCanvas = null;
let baseCtx = null;
let annotationCtx = null;
let interactionCtx = null;

// Viewport state (replaces CSS transform zoom)
const viewport = {
  zoom: 1,
  panX: 0,
  panY: 0,
  viewportWidth: 0,
  viewportHeight: 0
};

// Editor state
const editorState = {
  currentTool: 'none',
  isDrawing: false,
  drawingHistory: [],
  drawingHistoryIndex: -1,
  toolColor: '#ff0000',
  toolSize: 3,
  toolOpacity: 1,
  startX: 0,
  startY: 0,
  lastX: 0,
  lastY: 0
};

// Animation frame tracking
let renderFrameId = null;

function getDevicePixelRatio() {
  return window.devicePixelRatio || 1;
}

// Editor initialization guard
let editorInitialized = false;

// DOM Elements cache (lazy-loaded on demand)
let domCache = {};

function safeEl(id) {
  if (!domCache[id]) {
    const el = document.getElementById(id);
    if (!el) {
      console.warn(`[BERIBUG] Missing DOM element: ${id}`);
      return null;
    }
    domCache[id] = el;
  }
  return domCache[id];
}

// Cached accessors for common elements
function getModeSelector() { return safeEl('modeSelector'); }
function getAreaSelector() { return safeEl('areaSelector'); }
function getLoadingScreen() { return safeEl('loadingScreen'); }
function getPreviewScreen() { return safeEl('previewScreen'); }
function getPreviewImage() { return safeEl('previewImage'); }
function getScreenshotTitle() { return safeEl('screenshotTitle'); }
function getBtnDownload() { return safeEl('btnDownload'); }
function getBtnSaveToDrive() { return safeEl('btnSaveToDrive'); }
function getBtnClosePreview() { return safeEl('btnClosePreview'); }
function getCanvasContainer() { return safeEl('canvasContainer'); }
function getFloatingTools() { return safeEl('floatingTools'); }
function getZoomDisplay() { return safeEl('zoomDisplay'); }
function getToolColorInput() { return safeEl('toolColor'); }
function getToolSizeInput() { return safeEl('toolSize'); }
function getSizeValue() { return safeEl('sizeValue'); }
function getUploadStatus() { return safeEl('uploadStatus'); }
function getSuccessMessage() { return safeEl('successMessage'); }
function getStatusIcon() { return safeEl('statusIcon'); }
function getStatusText() { return safeEl('statusText'); }
function getStatusProgressFill() { return safeEl('statusProgressFill'); }
function getLoadingText() { return safeEl('loadingText'); }
function getSuccessText() { return safeEl('successText'); }
function getBtnViewInDrive() { return safeEl('btnViewInDrive'); }

// ==================== CORE UTILITIES ====================

function switchScreen(screenId) {
  try {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(screenId);
    if (el) {
      el.classList.add('active');
      console.log(`[BERIBUG] Switched to screen: ${screenId}`);
    } else {
      console.warn(`[BERIBUG] Screen not found: ${screenId}`);
    }
  } catch (err) {
    console.error('[BERIBUG] switchScreen error:', err);
  }
}

/**
 * Update an existing Drive file with the latest image (overwrite)
 */
async function updateScreenshotOnDrive() {
  try {
    const successMessage = getSuccessMessage();
    const fileId = successMessage?.dataset?.driveFileId;
    if (!fileId) throw new Error('No Drive file id available to update');

    await ensureImageReady();

    const finalImageUrl = await exportFinalImage();
    const imgRes = await fetch(finalImageUrl);
    const imgBlob = await imgRes.blob();

    const title = getScreenshotTitle()?.value || 'Screenshot';
    const safe = sanitizeTitleForFileName(title);

    const metadata = { name: `BERIBUG_${safe}_${makeTimeStamp()}.png` };
    const formData = new FormData();
    formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    formData.append('file', imgBlob);

    const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id,webViewLink,webContentLink`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${authToken}` },
      body: formData
    });

    if (!res.ok) throw new Error('Update failed: ' + res.status);
    const json = await res.json();

    const successText = getSuccessText();
    if (successText) {
      const viewLink = json.webViewLink || `https://drive.google.com/file/d/${json.id}/view`;
      successText.innerHTML = `Link screenshot: <a href="${viewLink}" target="_blank" rel="noreferrer">${viewLink}</a> (terbaru)`;
    }

    alert('Gambar berhasil diperbarui di Drive');
  } catch (err) {
    console.error('[BERIBUG] Update to Drive failed:', err);
    alert('Update gagal: ' + err.message);
  }
}

function sanitizeTitleForFileName(title) {
  return String(title || 'Screenshot').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Screenshot';
}

function makeTimeStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// ==================== IMAGE READY PIPELINE ====================

/**
 * CRITICAL: Wait for image to fully load and decode before any rendering
 */
async function ensureImageReady() {
  if (imageReady && originalImageBitmap) {
    return;
  }

  const previewImage = getPreviewImage();
  if (!previewImage) {
    throw new Error('previewImage element not found in DOM');
  }

  if (!previewImage.src) {
    throw new Error('No image source set');
  }

  console.log('[BERIBUG] ensureImageReady() - waiting for image decode...');

  return new Promise((resolve, reject) => {
    // If already complete, try immediate decode
    if (previewImage.complete) {
      if (previewImage.naturalWidth === 0 || previewImage.naturalHeight === 0) {
        console.error('[BERIBUG] Image has zero dimensions:', previewImage.naturalWidth, 'x', previewImage.naturalHeight);
        return reject(new Error('Image has zero dimensions'));
      }
      
      console.log('[BERIBUG] Image complete, dimensions:', previewImage.naturalWidth, 'x', previewImage.naturalHeight);
      
      if (previewImage.decode) {
        previewImage.decode()
          .then(() => {
            originalImageWidth = previewImage.naturalWidth;
            originalImageHeight = previewImage.naturalHeight;
            imageReady = true;
            console.log('[BERIBUG] Image ready (decoded)');
            resolve();
          })
          .catch(err => {
            console.error('[BERIBUG] Image decode failed:', err);
            reject(new Error('Image decode failed: ' + err.message));
          });
      } else {
        // Fallback if decode not supported
        originalImageWidth = previewImage.naturalWidth;
        originalImageHeight = previewImage.naturalHeight;
        imageReady = true;
        console.log('[BERIBUG] Image ready (fallback, no decode)');
        resolve();
      }
      return;
    }

    console.log('[BERIBUG] Waiting for image load event...');

    // Wait for load event
    const onLoad = () => {
      previewImage.removeEventListener('load', onLoad);
      previewImage.removeEventListener('error', onError);

      console.log('[BERIBUG] Image load event fired');

      if (previewImage.naturalWidth === 0 || previewImage.naturalHeight === 0) {
        console.error('[BERIBUG] Image zero dimensions after load:', previewImage.naturalWidth, 'x', previewImage.naturalHeight);
        reject(new Error('Image has zero dimensions after load'));
        return;
      }

      if (previewImage.decode) {
        previewImage.decode()
          .then(() => {
            originalImageWidth = previewImage.naturalWidth;
            originalImageHeight = previewImage.naturalHeight;
            imageReady = true;
            console.log('[BERIBUG] Image ready (loaded + decoded)');
            resolve();
          })
          .catch(err => {
            console.error('[BERIBUG] Image decode after load failed:', err);
            reject(new Error('Image decode failed: ' + err.message));
          });
      } else {
        originalImageWidth = previewImage.naturalWidth;
        originalImageHeight = previewImage.naturalHeight;
        imageReady = true;
        console.log('[BERIBUG] Image ready (loaded, no decode)');
        resolve();
      }
    };

    const onError = () => {
      previewImage.removeEventListener('load', onLoad);
      previewImage.removeEventListener('error', onError);
      console.error('[BERIBUG] Image load error');
      reject(new Error('Image failed to load'));
    };

    previewImage.addEventListener('load', onLoad);
    previewImage.addEventListener('error', onError);
  });
}

/**
 * Validate image is ready for export/operations
 */
function validateImageReady() {
  if (!imageReady) {
    throw new Error('Image tidak siap. Tunggu image selesai loading.');
  }
  if (originalImageWidth === 0 || originalImageHeight === 0) {
    throw new Error('Image memiliki dimensi invalid (width/height = 0)');
  }
  const previewImage = getPreviewImage();
  if (!previewImage || !previewImage.complete) {
    throw new Error('Image belum selesai load');
  }
}

// ==================== 3-LAYER CANVAS SYSTEM ====================

/**
 * Initialize canvas layers:
 * 1. Base layer: original image
 * 2. Annotation layer: user drawings
 * 3. Interaction layer: preview shapes during draw
 */
async function initializeCanvasLayers() {
  validateImageReady();

  // Ensure preview image element is available before using it
  const previewImage = getPreviewImage();
  if (!previewImage) {
    throw new Error('previewImage element not found - cannot initialize canvas layers');
  }

  // Remove old canvases if exist
  document.querySelectorAll('canvas[data-layer]').forEach(c => c.remove());

  // Create base layer canvas
  baseCanvas = document.createElement('canvas');
  baseCanvas.id = 'baseCanvas';
  baseCanvas.setAttribute('data-layer', 'base');
  baseCanvas.width = originalImageWidth;
  baseCanvas.height = originalImageHeight;
  baseCtx = baseCanvas.getContext('2d', { willReadFrequently: true });

  // Draw original image to base canvas
  baseCtx.drawImage(previewImage, 0, 0);

  // Create annotation layer canvas (for user drawings)
  annotationCanvas = document.createElement('canvas');
  annotationCanvas.id = 'annotationCanvas';
  annotationCanvas.setAttribute('data-layer', 'annotation');
  annotationCanvas.width = originalImageWidth;
  annotationCanvas.height = originalImageHeight;
  annotationCtx = annotationCanvas.getContext('2d', { willReadFrequently: true });

  // Create interaction layer canvas (for preview shapes)
  interactionCanvas = document.createElement('canvas');
  interactionCanvas.id = 'interactionCanvas';
  interactionCanvas.setAttribute('data-layer', 'interaction');
  interactionCanvas.width = originalImageWidth;
  interactionCanvas.height = originalImageHeight;
  interactionCtx = interactionCanvas.getContext('2d', { willReadFrequently: true });

  // Hide old img element (we already have previewImage above)
  if (previewImage) {
    previewImage.style.display = 'none';
  }

  // Note: drawingCanvas no longer exists in DOM (removed in redesign), so we skip hiding it

  // Setup canvas container with proper styling
  const canvasContainer = getCanvasContainer();
  if (!canvasContainer) {
    throw new Error('canvasContainer element not found - cannot setup editor');
  }

  canvasContainer.style.position = 'relative';
  canvasContainer.style.width = '100%';
  canvasContainer.style.height = '100%';
  canvasContainer.style.overflow = 'auto';
  canvasContainer.style.backgroundColor = '#f0f0f0';

  // Setup viewport dimensions
  viewport.viewportWidth = canvasContainer.offsetWidth;
  viewport.viewportHeight = canvasContainer.offsetHeight;

  console.log('[BERIBUG] Canvas container dimensions:', viewport.viewportWidth, 'x', viewport.viewportHeight);

  // Calculate initial fit-to-screen zoom
  fitToScreenInitial();

  // Create display canvas for rendering
  createDisplayCanvas();

  // Initialize drawing history
  saveAnnotationState();
}

/**
 * Create display canvas for rendering (what user sees)
 */
function createDisplayCanvas() {
  const canvasContainer = getCanvasContainer();
  if (!canvasContainer) {
    throw new Error('canvasContainer not found');
  }

  let displayCanvas = document.getElementById('displayCanvas');
  if (displayCanvas) {
    displayCanvas.remove();
  }

  displayCanvas = document.createElement('canvas');
  displayCanvas.id = 'displayCanvas';
  displayCanvas.style.position = 'absolute';
  displayCanvas.style.top = '50%';
  displayCanvas.style.left = '50%';
  displayCanvas.style.transform = 'translate(-50%, -50%)';
  displayCanvas.style.cursor = editorState.currentTool === 'none' ? 'default' : 'crosshair';
  displayCanvas.style.border = '1px solid #ccc';
  displayCanvas.style.width = '0px';
  displayCanvas.style.height = '0px';

  canvasContainer.appendChild(displayCanvas);

  setupCanvasEvents(displayCanvas);
  renderCanvas();
}

/**
 * Render all layers to display canvas with viewport transform
 */
function renderCanvas() {
  const displayCanvas = document.getElementById('displayCanvas');
  if (!displayCanvas) return;

  // Calculate display canvas size based on zoom
  const displayWidth = Math.ceil(originalImageWidth * viewport.zoom);
  const displayHeight = Math.ceil(originalImageHeight * viewport.zoom);
  const dpr = getDevicePixelRatio();

  displayCanvas.style.width = `${displayWidth}px`;
  displayCanvas.style.height = `${displayHeight}px`;
  displayCanvas.width = Math.max(1, Math.round(displayWidth * dpr));
  displayCanvas.height = Math.max(1, Math.round(displayHeight * dpr));

  const ctx = displayCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;

  // Clear
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, displayWidth, displayHeight);

  // Draw base layer
  ctx.drawImage(baseCanvas, 0, 0, displayWidth, displayHeight);

  // Draw annotation layer
  ctx.drawImage(annotationCanvas, 0, 0, displayWidth, displayHeight);

  // Draw interaction layer (preview)
  ctx.drawImage(interactionCanvas, 0, 0, displayWidth, displayHeight);

  // Update zoom display
  const zoomDisplay = getZoomDisplay();
  if (zoomDisplay) {
    zoomDisplay.textContent = Math.round(viewport.zoom * 100) + '%';
  }
}

/**
 * Schedule render with RAF (avoid frame drops)
 */
function scheduleRender() {
  if (renderFrameId) {
    cancelAnimationFrame(renderFrameId);
  }
  renderFrameId = requestAnimationFrame(() => {
    renderCanvas();
  });
}

// ==================== VIEWPORT / ZOOM SYSTEM ====================

/**
 * Calculate initial fit-to-screen zoom based on image width
 * For long screenshots, fit by width not height
 */
function fitToScreenInitial() {
  const canvasContainer = getCanvasContainer();
  if (!canvasContainer) {
    console.warn('[BERIBUG] canvasContainer not found for fitToScreenInitial');
    return;
  }

  const containerWidth = canvasContainer.offsetWidth - 20;
  const containerHeight = canvasContainer.offsetHeight - 20;

  const scaleByWidth = containerWidth / originalImageWidth;
  const scaleByHeight = containerHeight / originalImageHeight;

  // For long screenshot: fit by width first
  const scale = scaleByWidth < 1 ? scaleByWidth : Math.min(scaleByWidth, scaleByHeight);

  viewport.zoom = Math.max(0.1, Math.min(scale, 1));
}

/**
 * Fit current view to screen
 */
async function fitToScreen() {
  await ensureImageReady();
  fitToScreenInitial();
  scheduleRender();
}

/**
 * Zoom in/out with viewport transform
 */
async function zoomViewport(factor) {
  await ensureImageReady();

  const oldZoom = viewport.zoom;
  const newZoom = Math.max(0.1, Math.min(4, viewport.zoom * factor));
  viewport.zoom = newZoom;

  scheduleRender();
}

// ==================== WORLD COORDINATES ====================

/**
 * Convert screen coordinates to world (image) coordinates
 * Accounts for viewport zoom and pan
 */
function screenToWorldCoords(screenX, screenY) {
  const displayCanvas = document.getElementById('displayCanvas');
  if (!displayCanvas) return { x: screenX, y: screenY };

  const rect = displayCanvas.getBoundingClientRect();
  const relX = screenX - rect.left;
  const relY = screenY - rect.top;

  // Reverse the zoom scaling
  const worldX = relX / viewport.zoom;
  const worldY = relY / viewport.zoom;

  return {
    x: Math.max(0, Math.min(worldX, originalImageWidth)),
    y: Math.max(0, Math.min(worldY, originalImageHeight))
  };
}

// ==================== DRAWING TOOLS ====================

function selectTool(toolName) {
  editorState.currentTool = toolName;

  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === toolName);
  });

  const floatingTools = getFloatingTools();
  if (floatingTools) {
    floatingTools.classList.toggle('hidden', toolName === 'none' || toolName === 'text' || toolName === 'blur');
  }

  const displayCanvas = document.getElementById('displayCanvas');
  if (displayCanvas) {
    displayCanvas.style.cursor = toolName === 'none' ? 'default' : 'crosshair';
  }
}

function setupCanvasEvents(canvas) {
  canvas.addEventListener('mousedown', handleCanvasMouseDown);
  canvas.addEventListener('mousemove', handleCanvasMouseMove);
  canvas.addEventListener('mouseup', handleCanvasMouseUp);
  canvas.addEventListener('mouseleave', handleCanvasMouseLeave);
}

function handleCanvasMouseDown(e) {
  if (editorState.currentTool === 'none') return;

  editorState.isDrawing = true;
  const coords = screenToWorldCoords(e.clientX, e.clientY);
  editorState.startX = coords.x;
  editorState.startY = coords.y;
  editorState.lastX = coords.x;
  editorState.lastY = coords.y;

  // Setup context for drawing
  const ctx = annotationCtx;
  ctx.globalAlpha = editorState.toolOpacity;
  ctx.strokeStyle = editorState.toolColor;
  ctx.fillStyle = editorState.toolColor;
  ctx.lineWidth = editorState.toolSize;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Clear interaction layer
  interactionCtx.clearRect(0, 0, interactionCanvas.width, interactionCanvas.height);

  switch (editorState.currentTool) {
    case 'pencil':
    case 'highlighter':
      if (editorState.currentTool === 'highlighter') {
        ctx.globalAlpha = 0.3 * editorState.toolOpacity;
      }
      ctx.beginPath();
      ctx.moveTo(editorState.startX, editorState.startY);
      break;
  }
}

function handleCanvasMouseMove(e) {
  if (!editorState.isDrawing || editorState.currentTool === 'none') return;

  const coords = screenToWorldCoords(e.clientX, e.clientY);
  const ctx = annotationCtx;
  const ictx = interactionCtx;

  // Clear interaction layer for preview
  ictx.clearRect(0, 0, interactionCanvas.width, interactionCanvas.height);

  switch (editorState.currentTool) {
    case 'pencil':
    case 'highlighter':
      ctx.lineTo(coords.x, coords.y);
      ctx.stroke();
      break;

    case 'rectangle':
      // Preview on interaction layer
      ictx.globalAlpha = editorState.toolOpacity;
      ictx.strokeStyle = editorState.toolColor;
      ictx.lineWidth = editorState.toolSize;
      ictx.strokeRect(
        editorState.startX,
        editorState.startY,
        coords.x - editorState.startX,
        coords.y - editorState.startY
      );
      break;

    case 'arrow':
      // Preview on interaction layer
      ictx.globalAlpha = editorState.toolOpacity;
      ictx.strokeStyle = editorState.toolColor;
      ictx.fillStyle = editorState.toolColor;
      ictx.lineWidth = editorState.toolSize;
      drawArrow(ictx, editorState.startX, editorState.startY, coords.x, coords.y);
      break;
  }

  editorState.lastX = coords.x;
  editorState.lastY = coords.y;

  scheduleRender();
}

function handleCanvasMouseUp(e) {
  if (!editorState.isDrawing || editorState.currentTool === 'none') return;

  const coords = screenToWorldCoords(e.clientX, e.clientY);
  const ctx = annotationCtx;

  // Setup context
  ctx.globalAlpha = editorState.toolOpacity;
  ctx.strokeStyle = editorState.toolColor;
  ctx.fillStyle = editorState.toolColor;
  ctx.lineWidth = editorState.toolSize;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (editorState.currentTool) {
    case 'rectangle':
      ctx.strokeRect(
        editorState.startX,
        editorState.startY,
        coords.x - editorState.startX,
        coords.y - editorState.startY
      );
      break;

    case 'arrow':
      drawArrow(ctx, editorState.startX, editorState.startY, coords.x, coords.y);
      break;
  }

  // Clear interaction layer
  interactionCtx.clearRect(0, 0, interactionCanvas.width, interactionCanvas.height);

  ctx.globalAlpha = 1;
  editorState.isDrawing = false;

  saveAnnotationState();
  scheduleRender();
}

function handleCanvasMouseLeave(e) {
  if (editorState.isDrawing) {
    handleCanvasMouseUp(e);
  }
}

function drawArrow(ctx, fromX, fromY, toX, toY) {
  const headlen = Math.max(15, editorState.toolSize * 5);
  const angle = Math.atan2(toY - fromY, toX - fromX);

  // Draw line
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();

  // Draw arrowhead
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - headlen * Math.cos(angle - Math.PI / 6), toY - headlen * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - headlen * Math.cos(angle + Math.PI / 6), toY - headlen * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

// ==================== ANNOTATION HISTORY ====================

function saveAnnotationState() {
  const imageData = annotationCtx.getImageData(0, 0, annotationCanvas.width, annotationCanvas.height);
  editorState.drawingHistory.splice(editorState.drawingHistoryIndex + 1);
  editorState.drawingHistory.push(imageData);
  editorState.drawingHistoryIndex++;
}

async function undo() {
  if (editorState.drawingHistoryIndex > 0) {
    editorState.drawingHistoryIndex--;
    restoreAnnotationState();
  }
}

async function redo() {
  if (editorState.drawingHistoryIndex < editorState.drawingHistory.length - 1) {
    editorState.drawingHistoryIndex++;
    restoreAnnotationState();
  }
}

function restoreAnnotationState() {
  const imageData = editorState.drawingHistory[editorState.drawingHistoryIndex];
  if (imageData) {
    annotationCtx.putImageData(imageData, 0, 0);
    scheduleRender();
  }
}

async function clearAll() {
  if (!confirm('Hapus semua anotasi?')) return;
  annotationCtx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
  saveAnnotationState();
  scheduleRender();
}

// ==================== EXPORT / DOWNLOAD ====================

/**
 * Export final image: merge base + annotations
 * Return as Data URL
 */
async function exportFinalImage() {
  await ensureImageReady();
  validateImageReady();

  // Create final canvas at original resolution
  if (!baseCanvas || baseCanvas.width === 0 || baseCanvas.height === 0) {
    throw new Error('Base canvas invalid (width/height = 0)');
  }

  if (!annotationCanvas || annotationCanvas.width === 0 || annotationCanvas.height === 0) {
    throw new Error('Annotation canvas invalid (width/height = 0)');
  }

  const finalCanvas = new OffscreenCanvas(originalImageWidth, originalImageHeight);
  const ctx = finalCanvas.getContext('2d');

  if (!ctx) {
    throw new Error('Failed to get canvas context');
  }

  // Draw base
  ctx.drawImage(baseCanvas, 0, 0);

  // Draw annotations
  ctx.drawImage(annotationCanvas, 0, 0);

  // Convert to blob and return data URL
  const blob = await finalCanvas.convertToBlob({ type: 'image/png', quality: 0.95 });

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to convert image'));
    reader.readAsDataURL(blob);
  });
}

async function downloadScreenshot() {
  try {
    await ensureImageReady();
    
    const btnDownload = getBtnDownload();
    if (btnDownload) {
      btnDownload.disabled = true;
      btnDownload.textContent = '⏳ Processing...';
    }

    const screenshotTitle = getScreenshotTitle();
    const title = screenshotTitle?.value || 'Screenshot';
    const safe = sanitizeTitleForFileName(title);
    const filename = `BERIBUG_${safe}_${makeTimeStamp()}.png`;

    const finalImageUrl = await exportFinalImage();

    const link = document.createElement('a');
    link.href = finalImageUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    if (btnDownload) {
      btnDownload.textContent = '✅ Downloaded!';
      setTimeout(() => {
        btnDownload.textContent = '⬇ Download';
        btnDownload.disabled = false;
      }, 2000);
    }
  } catch (err) {
    console.error('Download failed:', err);
    alert('Download gagal: ' + err.message);
    btnDownload.textContent = '⬇ Download';
    btnDownload.disabled = false;
  }
}

// ==================== DRIVE UPLOAD ====================

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
  if (!res.ok) throw new Error(`Upload gagal: ${res.status}`);
  return await res.json();
}

async function makeFilePublic(fileId) {
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ role: 'reader', type: 'anyone' })
  });
}

function updateProgress(percent, text) {
  const statusProgressFill = getStatusProgressFill();
  const statusText = getStatusText();
  
  if (statusProgressFill) statusProgressFill.style.width = `${percent}%`;
  if (statusText) statusText.textContent = text;
}

function showUploadStatus() {
  const uploadStatus = getUploadStatus();
  if (uploadStatus) uploadStatus.classList.remove('hidden');
}

function hideUploadStatus() {
  const uploadStatus = getUploadStatus();
  if (uploadStatus) uploadStatus.classList.add('hidden');
}

function showSuccessMessage() {
  const successMessage = getSuccessMessage();
  if (successMessage) successMessage.classList.remove('hidden');
}

async function saveScreenshotToDrive() {
  try {
    await ensureImageReady();

    if (!authToken) {
      return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: true }, (token) => {
          if (!token) {
            alert('Anda harus login dengan Google terlebih dahulu.');
            reject(new Error('No token'));
            return;
          }
          authToken = token;
          saveScreenshotToDrive().then(resolve).catch(reject);
        });
      });
    }

    const btnSaveToDrive = getBtnSaveToDrive();
    if (btnSaveToDrive) btnSaveToDrive.disabled = true;

    showUploadStatus();
    const statusIcon = getStatusIcon();
    if (statusIcon) statusIcon.textContent = '⏳';
    updateProgress(5, 'Menyiapkan upload...');

    const screenshotTitle = getScreenshotTitle();
    const title = screenshotTitle?.value || 'Screenshot';
    const safe = sanitizeTitleForFileName(title);
    const ts = makeTimeStamp();

    const folderId = await getOrCreateFolder();
    updateProgress(25, 'Mengupload gambar...');

    const finalImageUrl = await exportFinalImage();
    const imgRes = await fetch(finalImageUrl);
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
    hideUploadStatus();

    const viewLink = imgFile.webViewLink || `https://drive.google.com/file/d/${imgFile.id}/view`;
    const successText = getSuccessText();
    if (successText) {
      successText.innerHTML = `Link screenshot: <a href="${viewLink}" target="_blank" rel="noreferrer">${viewLink}</a>`;
    }

    showSuccessMessage();

    // Persist last saved file id so user can update it later
    try {
      await chrome.storage.local.set({ lastSavedScreenshotFileId: imgFile.id });
    } catch (e) {
      console.warn('[BERIBUG] Could not persist lastSavedScreenshotFileId', e);
    }

    const successMessage = getSuccessMessage();
    if (successMessage) {
      successMessage.dataset.driveFileId = imgFile.id;
      const btnUpdate = document.getElementById('btnUpdateInDrive');
      if (btnUpdate) btnUpdate.classList.remove('hidden');
    }

    const btnViewInDrive = getBtnViewInDrive();
    if (btnViewInDrive) {
      btnViewInDrive.onclick = () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('html/home.html') });
      };
    }

    // Do not remove pendingScreenshot so user can continue editing after saving
    if (btnSaveToDrive) btnSaveToDrive.disabled = false;
  } catch (err) {
    console.error('[BERIBUG] Save to Drive failed:', err);
    hideUploadStatus();
    alert('Upload gagal: ' + err.message);
    const btnSaveToDrive = getBtnSaveToDrive();
    if (btnSaveToDrive) btnSaveToDrive.disabled = false;
  }
}

// ==================== INITIALIZATION ====================

async function loadPendingScreenshot() {
  const data = await chrome.storage.local.get(['pendingScreenshot']);
  return data.pendingScreenshot || null;
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
  
  const screenshotTitle = getScreenshotTitle();
  if (screenshotTitle) {
    screenshotTitle.value = `Screenshot ${mode} ${timeStr}`;
  }
}

async function initializeEditor() {
  try {
    // Guard against multiple initialization
    if (editorInitialized) {
      console.log('[BERIBUG] Editor already initialized, skipping...');
      return;
    }

    console.log('[BERIBUG] Initializing editor...');

    const loadingText = getLoadingText();
    if (loadingText) loadingText.textContent = 'Memproses screenshot panjang...';

    // CRITICAL: Wait for image to fully load and decode
    await ensureImageReady();
    validateImageReady();

    if (loadingText) loadingText.textContent = 'Menginisialisasi canvas layers...';

    // Initialize 3-layer canvas system
    await initializeCanvasLayers();

    if (loadingText) loadingText.textContent = 'Setup tools...';

    // Setup tool buttons
    try {
      document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          selectTool(btn.dataset.tool);
        });
      });
      console.log('[BERIBUG] Tool buttons setup OK');
    } catch (e) {
      console.warn('[BERIBUG] Error setting up tool buttons:', e);
    }

    // Setup zoom buttons
    try {
      const btnZoomIn = document.getElementById('btnZoomIn');
      const btnZoomOut = document.getElementById('btnZoomOut');
      const btnZoomFit = document.getElementById('btnZoomFit');
      if (btnZoomIn) btnZoomIn.addEventListener('click', () => zoomViewport(1.2));
      if (btnZoomOut) btnZoomOut.addEventListener('click', () => zoomViewport(0.8));
      if (btnZoomFit) btnZoomFit.addEventListener('click', fitToScreen);
      console.log('[BERIBUG] Zoom buttons setup OK');
    } catch (e) {
      console.warn('[BERIBUG] Error setting up zoom buttons:', e);
    }

    // Setup tool settings (opacity control removed)
    try {
      const toolColorInput = getToolColorInput();
      const toolSizeInput = getToolSizeInput();
      const sizeValue = getSizeValue();

      if (toolColorInput) {
        toolColorInput.addEventListener('change', (e) => {
          editorState.toolColor = e.target.value;
        });
      }

      if (toolSizeInput) {
        toolSizeInput.addEventListener('input', (e) => {
          editorState.toolSize = parseInt(e.target.value);
          if (sizeValue) sizeValue.textContent = editorState.toolSize;
        });
      }

      console.log('[BERIBUG] Tool settings setup OK');
    } catch (e) {
      console.warn('[BERIBUG] Error setting up tool settings:', e);
    }

    // Setup undo/redo/clear
    try {
      const btnUndo = document.getElementById('btnUndo');
      const btnRedo = document.getElementById('btnRedo');
      const btnClearAll = document.getElementById('btnClearAll');
      if (btnUndo) btnUndo.addEventListener('click', undo);
      if (btnRedo) btnRedo.addEventListener('click', redo);
      if (btnClearAll) btnClearAll.addEventListener('click', clearAll);
      console.log('[BERIBUG] Undo/Redo setup OK');
    } catch (e) {
      console.warn('[BERIBUG] Error setting up undo/redo:', e);
    }

    // Setup mouse wheel zoom
    try {
      const canvasContainer = getCanvasContainer();
      if (canvasContainer) {
        canvasContainer.addEventListener('wheel', (e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            zoomViewport(e.deltaY > 0 ? 0.9 : 1.1);
          }
        });
        console.log('[BERIBUG] Mouse wheel zoom setup OK');
      }
    } catch (e) {
      console.warn('[BERIBUG] Error setting up mouse wheel zoom:', e);
    }

    // Enable action buttons
    try {
      const btnDownload = getBtnDownload();
      const btnSaveToDrive = getBtnSaveToDrive();
      if (btnDownload) btnDownload.disabled = false;
      if (btnSaveToDrive) btnSaveToDrive.disabled = false;
      console.log('[BERIBUG] Action buttons enabled');
    } catch (e) {
      console.warn('[BERIBUG] Error enabling action buttons:', e);
    }

    // Success modal controls: close (x) and update-in-drive
    try {
      const btnCloseSuccess = document.getElementById('btnCloseSuccess');
      const btnUpdateInDrive = document.getElementById('btnUpdateInDrive');
      if (btnCloseSuccess) btnCloseSuccess.addEventListener('click', () => {
        const sm = getSuccessMessage(); if (sm) sm.classList.add('hidden');
      });
      if (btnUpdateInDrive) btnUpdateInDrive.addEventListener('click', updateScreenshotOnDrive);
    } catch (e) {
      console.warn('[BERIBUG] Error setting up success modal controls:', e);
    }

    if (loadingText) loadingText.textContent = '';
    switchScreen('previewScreen');

    editorInitialized = true;
    console.log('[BERIBUG] Editor initialization complete');

  } catch (err) {
    console.error('[BERIBUG] Editor initialization failed:', err);
    const loadingText = getLoadingText();
    if (loadingText) loadingText.textContent = `Gagal: ${err.message}`;
    
    const btnDownload = getBtnDownload();
    const btnSaveToDrive = getBtnSaveToDrive();
    if (btnDownload) btnDownload.disabled = true;
    if (btnSaveToDrive) btnSaveToDrive.disabled = true;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[BERIBUG] DOMContentLoaded fired');

  switchScreen('loadingScreen');
  const loadingText = getLoadingText();
  if (loadingText) loadingText.textContent = 'Menyiapkan preview screenshot...';

  try {
    console.log('[BERIBUG] Initializing auth...');
    await initAuth();

    pending = await loadPendingScreenshot();
    if (!pending || !pending.imageDataUrl) {
      console.log('[BERIBUG] No pending screenshot, showing mode selector');
      const hash = window.location.hash || '';
      const errorMatch = hash.match(/error=([^&]+)/);
      const errorMsg = errorMatch ? decodeURIComponent(errorMatch[1]) : null;

      switchScreen('modeSelector');

      const modeSelector = getModeSelector();
      if (modeSelector) {
        const title = modeSelector.querySelector('h1');
        const desc = modeSelector.querySelector('p');
        if (title) title.textContent = '📸 Screenshot';
        if (desc) {
          desc.textContent = errorMsg
            ? `Gagal: ${errorMsg}`
            : 'Mulai screenshot dari popup extension (ikon BERIBUG di toolbar).';
        }
      }

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

      const areaSelector = getAreaSelector();
      if (areaSelector) areaSelector.style.display = 'none';
      return;
    }

    console.log('[BERIBUG] Found pending screenshot, setting up preview');

    // Set image source
    const previewImage = getPreviewImage();
    if (!previewImage) {
      throw new Error('previewImage element not found - cannot display screenshot');
    }

    previewImage.src = pending.imageDataUrl;
    setDefaultTitle(pending.meta);

    // Disable buttons until image is ready
    const btnDownload = getBtnDownload();
    const btnSaveToDrive = getBtnSaveToDrive();
    const btnClosePreview = getBtnClosePreview();

    if (btnDownload) btnDownload.disabled = true;
    if (btnSaveToDrive) btnSaveToDrive.disabled = true;

    // Setup event listeners
    if (btnDownload) btnDownload.addEventListener('click', downloadScreenshot);
    if (btnSaveToDrive) btnSaveToDrive.addEventListener('click', saveScreenshotToDrive);
    if (btnClosePreview) btnClosePreview.addEventListener('click', () => window.close());

    // Retry button
    const btnRetake = document.getElementById('btnRetake');
    if (btnRetake) {
      btnRetake.addEventListener('click', () => {
        if (pending?.meta?.mode === 'area' && pending?.meta?.tabId) {
          chrome.runtime.sendMessage(
            { action: 'RETRY_SCREENSHOT_AREA', tabId: pending.meta.tabId },
            (res) => {
              if (res && res.ok) {
                window.close();
              } else {
                alert('Gagal mengulang screenshot area: ' + (res?.error || 'Unknown error'));
              }
            }
          );
        } else {
          alert('Untuk ulang screenshot, klik ikon BERIBUG di toolbar lalu pilih mode yang diinginkan.');
          window.close();
        }
      });
    }

    console.log('[BERIBUG] Preview setup done, initializing editor...');

    // Wait for next animation frame to ensure preview screen is rendered
    await new Promise(requestAnimationFrame);
    
    // Initialize editor (waits for image load + decode)
    await initializeEditor();

  } catch (err) {
    console.error('[BERIBUG] DOMContentLoaded error:', err);
    const loadingText = getLoadingText();
    if (loadingText) loadingText.textContent = `Error: ${err.message}`;
  }
});
