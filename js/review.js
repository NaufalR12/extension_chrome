import { getAccessToken, login } from './auth.js';

document.addEventListener("DOMContentLoaded", () => {
  const videoPreview = document.getElementById("videoPreview");
  const btnSave = document.getElementById("btnSave");
  const inputTitle = document.getElementById("inputTitle");
  const inputDesc = document.getElementById("inputDesc");
  const stepForm = document.getElementById("stepForm");
  const stepSuccess = document.getElementById("stepSuccess");
  const shareLink = document.getElementById("shareLink");
  const btnCopy = document.getElementById("btnCopy");
  const loading = document.getElementById("loading");
  const errorMsg = document.getElementById("errorMsg");
  const btnEditVideo = document.getElementById("btnEditVideo");

  if (btnEditVideo) {
    btnEditVideo.addEventListener("click", () => {
      // Simpan logs saat ini ke sessionStorage agar bisa diakses editor
      sessionStorage.setItem("editLogs", JSON.stringify(sessionLogs));
      // Buka halaman editor
      window.location.href = "edit.html";
    });
  }

  // Logs Tabs Setup
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));

      tab.classList.add("active");
      const targetId = tab.getAttribute("data-target");
      document.getElementById(targetId).classList.add("active");
    });
  });

  // Global State
  let sessionLogs = {
    console: [],
    network: [],
    actions: [],
    backend: [],
    info: {},
  };
  let isExistingReport = false;
  let existingJsonId = null;
  let authToken = null;

  // 1. Check for URL Parameters (Playback/Edit mode)
  const urlParams = new URL(window.location.href).searchParams;
  const vId = urlParams.get("v");
  const lId = urlParams.get("l");
  const isEditMode = urlParams.get("edit") === "true";

  if (vId && lId) {
    isExistingReport = true;
    existingJsonId = lId;
    loadFromDrive(vId, lId, isEditMode);
  } else {
    loadFromStorage();
  }

  function loadFromStorage() {
    const editedLogs = sessionStorage.getItem("editLogs");

    chrome.storage.local.get(["sessionLogs", "pendingReport"], (res) => {
      // Prioritaskan editedLogs dari session (hasil edit baru)
      // Jika tidak ada, gunakan sessionLogs dari storage (bisa jadi hasil edit sebelumnya yang sudah dipersist)
      const logs = editedLogs
        ? JSON.parse(editedLogs)
        : res.sessionLogs || {
            console: [],
            network: [],
            actions: [],
            backend: [],
            info: {},
          };

      // Load Title & Desc dari storage agar tidak hilang saat refresh
      if (res.pendingReport) {
        inputTitle.value = res.pendingReport.title || "";
        inputDesc.value = res.pendingReport.description || "";
      }

      initReviewUI(logs);
    });

    chrome.runtime.sendMessage({ action: "GET_PENDING_VIDEO" }, (res) => {
      if (res && res.videoBase64) {
        try {
          const byteCharacters = atob(res.videoBase64);
          const byteNumbers = new Array(byteCharacters.length);
          for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
          }
          const byteArray = new Uint8Array(byteNumbers);
          const blob = new Blob([byteArray], { type: "video/webm" });
          videoPreview.src = URL.createObjectURL(blob);
        } catch (e) {
          console.error("Video decode failed", e);
          showError("Error decoding video data.");
        }
      } else {
        showError("Error: No video found to review.");
      }
    });
  }

  async function loadFromDrive(vId, lId, edit) {
    loading.classList.remove("hidden");
    loading.textContent = "Fetching from OneDrive...";

    try {
      authToken = await getAccessToken();
      if (!authToken) {
        authToken = await login();
      }
      if (!authToken) throw new Error("Could not authenticate with OneDrive");

      // Fetch JSON first for immediate log rendering
      const jsonRes = await fetch(
        `https://graph.microsoft.com/v1.0/me/drive/items/${lId}/content`,
        {
          headers: { Authorization: `Bearer ${authToken}` },
        },
      );
      if (!jsonRes.ok) {
        throw new Error("Failed to fetch JSON content: " + jsonRes.status);
      }
      const reportData = await jsonRes.json();

      // Setup Save Button for Edit Mode
      if (edit) {
        btnSave.textContent = "Update Report";
        btnSave.classList.remove("hidden");
      } else {
        btnSave.classList.add("hidden");
      }

      // Render logs immediately
      if (reportData && (reportData.logs || reportData.console)) {
        inputTitle.value = reportData.title || "";
        inputDesc.value = reportData.description || "";
        initReviewUI(reportData.logs || reportData);
      }

      loading.textContent = "Fetching video...";

      // Fetch Video in background
      const videoFetchUrl = `https://graph.microsoft.com/v1.0/me/drive/items/${vId}/content`;
      fetch(videoFetchUrl, {
        headers: { Authorization: `Bearer ${authToken}` },
      })
        .then((r) => {
          if (!r.ok) throw new Error("Fetch failed with status " + r.status);
          return r.blob();
        })
        .then(async (blob) => {
          // Save to IndexedDB so edit.js can find it
          try {
            await saveVideoToDB(blob);
            console.log("Video saved to DB for editing.");
          } catch (dbErr) {
            console.error("Failed to save video to DB", dbErr);
          }
          videoPreview.src = URL.createObjectURL(blob);
          loading.classList.add("hidden");
        })
        .catch((err) => {
          console.error("Video fetch failed", err);
          loading.textContent = "Logs loaded. Video failed.";
          setTimeout(() => loading.classList.add("hidden"), 3000);
        });
    } catch (err) {
      showError("Failed to load from OneDrive: " + err);
    }
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.remove("hidden");
    loading.classList.add("hidden");
  }

  // CORE UI INITIALIZATION
  function initReviewUI(logs) {
    sessionLogs = logs;

    function parseSec(timeStr) {
      if (!timeStr) return 0;
      const match = timeStr.match(/\[(\d+):(\d+)\]/);
      if (match) {
        return parseInt(match[1]) * 60 + parseInt(match[2]);
      }
      return 0;
    }

    // Helper to jump video time and highlight log
    function jumpToVideoTime(timeMs, element) {
      if (!videoPreview || timeMs === undefined || timeMs === null) return;

      // Precise jump (no buffer)
      const targetSec = timeMs / 1000;
      videoPreview.currentTime = targetSec;

      // Visual feedback: remove highlight from others, add to this one
      document
        .querySelectorAll(".log-entry-active")
        .forEach((el) => el.classList.remove("log-entry-active"));
      if (element) {
        element.classList.add("log-entry-active");
        // Smooth scroll to keep element in view if needed
        element.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }

    // --- JSON TREE RENDERER ---
    // Fungsi rekursif yang menghasilkan HTML tree seperti DevTools
    let _jtCounter = 0; // unique ID per node untuk toggle tanpa framework
    function renderJsonTree(value, depth) {
      depth = depth || 0;
      const uid = "_jt" + ++_jtCounter;

      if (value === null) return `<span class="jt-val-null">null</span>`;
      if (value === undefined)
        return `<span class="jt-val-undefined">undefined</span>`;

      const type = typeof value;
      if (type === "string") {
        const safe = value
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        const short = safe.length > 80 ? safe.substring(0, 80) + "…" : safe;
        return `<span class="jt-val-string">"${short}"</span>`;
      }
      if (type === "number")
        return `<span class="jt-val-number">${value}</span>`;
      if (type === "boolean")
        return `<span class="jt-val-boolean">${value}</span>`;

      if (Array.isArray(value)) {
        if (value.length === 0) return `<span class="jt-bracket">[]</span>`;
        const summary = `Array(${value.length})`;
        const items = value
          .slice(0, 50)
          .map(
            (v, i) =>
              `<span class="jt-node"><span class="jt-key">${i}</span><span class="jt-punct">: </span>${renderJsonTree(v, depth + 1)}</span>`,
          )
          .join("");
        return `<span class="jt-toggle" data-toggle="json" data-target="${uid}"><span class="jt-caret">▶</span><span class="jt-bracket">[</span><span class="jt-summary">${summary}</span><span class="jt-bracket">]</span></span><span class="jt-children" id="${uid}">${items}${value.length > 50 ? '<span class="jt-val-null">…' + value.length + " items</span>" : ""}</span>`;
      }

      if (type === "object") {
        const keys = Object.keys(value);
        if (keys.length === 0) return `<span class="jt-bracket">{}</span>`;
        const summary = `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`;
        const items = keys
          .slice(0, 50)
          .map((k) => {
            const safeK = k.replace(/&/g, "&amp;");
            return `<span class="jt-node"><span class="jt-key">"${safeK}"</span><span class="jt-punct">: </span>${renderJsonTree(value[k], depth + 1)}</span>`;
          })
          .join("");
        return `<span class="jt-toggle" data-toggle="json" data-target="${uid}"><span class="jt-caret">▶</span><span class="jt-bracket">{</span><span class="jt-summary">${summary}</span><span class="jt-bracket">}</span></span><span class="jt-children" id="${uid}">${items}${keys.length > 50 ? '<span class="jt-val-null">…' + keys.length + " keys</span>" : ""}</span>`;
      }

      return `<span>${String(value)}</span>`;
    }

    // Render satu console log entry dengan expand/collapse DevTools-style
    function renderConsoleEntry(item, uid) {
      const level = item.level || "log";
      const t = (item.time || "").match(/\[(\d+:\d+)\]/);
      const timeStr = t ? t[1] : "0:00";
      const sec = parseSec(item.time);
      const hasArgs = item.args && item.args.length > 0;
      const hasStack = item.stack && item.stack.trim();
      const isExpandable = hasArgs || hasStack;

      // Short message preview (always visible)
      const msgShort = (item.message || "").substring(0, 120);

      // Build expanded body: json tree per arg
      let bodyHtml = "";
      if (hasArgs) {
        bodyHtml += `<div class="jt-root">`;
        bodyHtml += item.args
          .map((a, i) => {
            if (a === null || a === undefined || typeof a !== "object") {
              return `<div class="jt-node">${renderJsonTree(a)}</div>`;
            }
            return `<div class="jt-node">${renderJsonTree(a)}</div>`;
          })
          .join(
            '<hr style="border:none;border-top:1px solid #eee;margin:4px 0;">',
          );
        bodyHtml += `</div>`;
      } else {
        // fallback: full message text
        bodyHtml += `<div style="font-family:monospace;font-size:11px;white-space:pre-wrap;">${(item.message || "").replace(/</g, "&lt;")}</div>`;
      }
      if (hasStack) {
        bodyHtml += `<div class="log-stack-label" style="margin-top:6px;">Stack Trace</div>`;
        bodyHtml += `<div class="log-stack-trace">${item.stack.replace(/</g, "&lt;")}</div>`;
      }

      const chevronSection = isExpandable
        ? `<span class="log-chevron" id="chev_${uid}">▶</span>`
        : `<span class="log-chevron" style="visibility:hidden;">▶</span>`;

      const headerData = isExpandable
        ? `data-toggle="console" data-target="${uid}"`
        : "";

      const jumpIcon = `<span class="log-jump-btn" title="Jump to video time">⏯️</span>`;

      return `<div class="log-entry-expandable log-jump-target" data-time="${sec}" data-time-ms="${item.relativeMs || sec * 1000}">
        <div class="log-entry-header" ${headerData}>
          ${jumpIcon}
          ${chevronSection}
          <span class="log-level-badge ${level}">${level}</span>
          <span class="log-message-short">${msgShort.replace(/</g, "&lt;")}</span>
          <span class="log-time-badge">${timeStr}</span>
        </div>
        ${isExpandable ? `<div class="log-entry-body" id="body_${uid}">${bodyHtml}</div>` : ""}
      </div>`;
    }

    // --- CONSOLE & UNIFIED LOGIC ---
    let unified = [];
    function rebuildUnified() {
      unified = [];
      (sessionLogs.console || []).forEach((l) =>
        unified.push({ ...l, _cat: "console" }),
      );
      (sessionLogs.network || []).forEach((n) =>
        unified.push({ ...n, _cat: "network" }),
      );
      (sessionLogs.actions || []).forEach((a) =>
        unified.push({ ...a, _cat: "action" }),
      );
      unified.sort(
        (a, b) =>
          (a.relativeMs || parseSec(a.time) * 1000) -
          (b.relativeMs || parseSec(b.time) * 1000),
      );
    }

    let uSearch = "";
    let showPageNav = true;
    let showNetErr = true;
    let showUsrAct = true;
    let showThirdParty = true;

    // Deteksi domain utama dari sessionLogs.info
    const mainDomain = (() => {
      try {
        const url =
          sessionLogs.info && sessionLogs.info.url ? sessionLogs.info.url : "";
        return url ? new URL(url).hostname : "";
      } catch (e) {
        return "";
      }
    })();

    function renderUnified() {
      const filtered = unified.filter((item) => {
        if (
          !showPageNav &&
          item._cat === "action" &&
          item.event &&
          item.event.includes("Navigated")
        )
          return false;
        if (!showNetErr && item._cat === "network") {
          const isErr =
            item.status === "CACHE_MISS" || (item.status && item.status >= 400);
          if (!isErr) return false;
        }
        if (
          !showUsrAct &&
          item._cat === "action" &&
          !item.event.includes("Navigated")
        )
          return false;
        if (!showThirdParty && item._cat === "network" && mainDomain) {
          try {
            const itemDomain = new URL(item.url).hostname;
            if (itemDomain !== mainDomain) return false;
          } catch (e) {}
        }
        if (!showThirdParty && item._cat === "console") {
          // Filter log dari URL yang berbeda domain jika tersedia
          if (item.url && mainDomain) {
            try {
              if (new URL(item.url).hostname !== mainDomain) return false;
            } catch (e) {}
          }
        }

        if (uSearch) {
          const lowerS = uSearch.toLowerCase();
          const str = JSON.stringify(item).toLowerCase();
          if (!str.includes(lowerS)) return false;
        }
        return true;
      });

      const cHtml = filtered
        .map((item, idx) => {
          const match = (item.time || "").match(/\[(\d+:\d+)\]/);
          const t = match ? match[1] : "0:00";
          const sec = parseSec(item.time);

          // Console items: gunakan renderer baru dengan object inspector
          if (item._cat === "console") {
            return renderConsoleEntry(item, "u_" + idx + "_" + sec);
          }

          let icon = "",
            content = "",
            css = "";
          if (item._cat === "network") {
            const isErr =
              item.status === "CACHE_MISS" ||
              (item.status && item.status >= 400);
            icon = "⇄";
            css = isErr ? "error" : "net";
            content = `<b>${item.method}</b> ${item.url}`;
          } else if (item._cat === "action") {
            const isNav = item.event && item.event.includes("Navigated");
            const isClick = item.event && item.event.includes("Click");
            const isType =
              item.event &&
              (item.event.includes("Typed") || item.event.includes("Input"));

            if (isNav) {
              css = "nav";
              icon = "🌐";
              const methodTag = item.method
                ? ` <span style="color:#888;font-size:11px">via ${item.method}</span>`
                : "";
              content = `Navigated to <a href="${item.element}" target="_blank" style="color: #1a73e8; text-decoration: none;">${item.element}</a>${methodTag}`;
            } else if (isClick) {
              icon = "🖱️";
              css = "clicked";
              const rawEl = item.element || "";
              const tagMatch = rawEl.match(/^<([a-z0-9]+)/i);
              const tagName = tagMatch ? tagMatch[1] : "element";
              const attrs = rawEl
                .replace(/^<[a-z0-9]+/i, "")
                .replace(/>$/, "")
                .trim();
              const xpathLine = item.xpath
                ? `<div style="font-size:10px;color:#888;margin-top:2px;font-family:monospace;">XPath: ${item.xpath}</div>`
                : "";

              // Detail panel HTML
              const detailUid = "ud_" + idx + "_" + sec;
              const detailHtml = `<div class="action-detail-panel" id="dp_${detailUid}">
              ${item.cssSelector ? `<div class="action-detail-row"><span class="action-detail-label">Selector</span><span class="action-detail-value selector">${item.cssSelector}</span></div>` : ""}
              ${item.xpath ? `<div class="action-detail-row"><span class="action-detail-label">XPath</span><span class="action-detail-value xpath">${item.xpath}</span></div>` : ""}
              ${item.clientX != null ? `<div class="action-detail-row"><span class="action-detail-label">Viewport (x,y)</span><span class="action-detail-value coord">${item.clientX}, ${item.clientY}</span></div>` : ""}
              ${item.pageX != null ? `<div class="action-detail-row"><span class="action-detail-label">Page (x,y)</span><span class="action-detail-value coord">${item.pageX}, ${item.pageY}</span></div>` : ""}
              ${item.textContent ? `<div class="action-detail-row"><span class="action-detail-label">Text</span><span class="action-detail-value text">${item.textContent.replace(/</g, "&lt;")}</span></div>` : ""}
            </div>`;

              content = `Clicked <b>&lt;${tagName}</b> 
                      ${attrs ? `<span class="attr-text" style="color:#666; font-family:monospace;">${attrs.substring(0, 50)}${attrs.length > 50 ? "..." : ""}</span>` : ""}
                      <b>&gt;</b>
                      <button class="action-expand-btn" data-toggle="action" data-target="${detailUid}">▶ details</button>
                      ${xpathLine}
                      ${detailHtml}`;
            } else if (isType) {
              icon = "⌨️";
              css = "typed";
              content = `Typed <b style="background:#f0f0f0;padding:2px 4px;border-radius:4px;font-family:monospace;font-weight:normal;border:1px solid #ddd;">${item.value || "***"}</b>`;
            } else {
              icon = "🪄";
              content = `${item.event} ${item.element}`;
            }
          }
          const jumpIcon = `<span class="log-jump-btn" style="margin-right:4px;">⏯️</span>`;
          return `<div class="u-entry ${css} log-jump-target" data-time="${sec}" data-time-ms="${item.relativeMs || sec * 1000}">
          <div class="u-time">${t} ${jumpIcon}</div>
          <div class="u-icon">${icon}</div>
          <div class="u-cont">${content}</div>
        </div>`;
        })
        .join("");

      const startEntry = `<div class="u-entry nav"><div class="u-time">0:00</div><div class="u-icon">▶</div><div class="u-cont">Video started</div></div>`;
      document.getElementById("consoleLogs").innerHTML = startEntry + cHtml;
    }

    rebuildUnified();
    renderUnified();

    // Attach Listeners
    const cInput = document.getElementById("consoleFilterInput");
    if (cInput)
      cInput.addEventListener("input", (e) => {
        uSearch = e.target.value;
        renderUnified();
      });
    const tNav = document.getElementById("toggleNav");
    if (tNav)
      tNav.addEventListener("click", () => {
        showPageNav = !showPageNav;
        tNav.classList.toggle("active", showPageNav);
        renderUnified();
      });
    const tNet = document.getElementById("toggleNetErr");
    if (tNet)
      tNet.addEventListener("click", () => {
        showNetErr = !showNetErr;
        tNet.classList.toggle("active", showNetErr);
        renderUnified();
      });
    const tUsr = document.getElementById("toggleUsrAct");
    if (tUsr)
      tUsr.addEventListener("click", () => {
        showUsrAct = !showUsrAct;
        tUsr.classList.toggle("active", showUsrAct);
        renderUnified();
      });
    const tThird = document.getElementById("toggleThirdParty");
    if (tThird)
      tThird.addEventListener("click", () => {
        showThirdParty = !showThirdParty;
        tThird.classList.toggle("active", showThirdParty);
        renderUnified();
      });

    // --- NETWORK LOGIC ---
    let nSearch = "";
    let nTypeFilter = "all";
    let nErrorsOnly = false;
    let selectedReq = null;

    function formatSize(bytes) {
      if (!bytes || bytes === 0) return "";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    function renderNetwork() {
      const netArr = (sessionLogs.network || [])
        .slice()
        .sort((a, b) => (a.relativeMs || 0) - (b.relativeMs || 0));

      // Calculate total session time for Waterfall scaling
      let maxRelativeMs = 1000; // default min 1s
      netArr.forEach((n) => {
        const end = (n.relativeMs || 0) + (n.duration || 0);
        if (end > maxRelativeMs) maxRelativeMs = end;
      });
      // Also check other log types for end time
      sessionLogs.console.forEach((c) => {
        if (c.relativeMs > maxRelativeMs) maxRelativeMs = c.relativeMs;
      });
      sessionLogs.actions.forEach((a) => {
        if (a.relativeMs > maxRelativeMs) maxRelativeMs = a.relativeMs;
      });

      const filtered = netArr.filter((n) => {
        if (nErrorsOnly) {
          const isErr = (n.status && n.status >= 400) || n.status === 0;
          if (!isErr) return false;
        }
        if (nTypeFilter !== "all") {
          const t = (n.type || "xhr").toLowerCase();
          if (nTypeFilter === "xhr" && !["xhr", "fetch"].includes(t))
            return false;
          if (nTypeFilter !== "xhr" && !t.includes(nTypeFilter)) return false;
        }
        if (nSearch) {
          if (!n.url.toLowerCase().includes(nSearch.toLowerCase()))
            return false;
        }
        return true;
      });

      const nHtml = filtered
        .map((n, i) => {
          const isErr = (n.status && n.status >= 400) || n.status === 0;
          const statusClass =
            n.status >= 400
              ? "status-error"
              : n.status >= 300
                ? "status-redirect"
                : "status-success";

          let name = "unknown";
          let domain = "unknown";
          try {
            const urlObj = new URL(n.url);
            name = urlObj.pathname.split("/").pop() || urlObj.pathname || "/";
            domain = urlObj.hostname;
          } catch (e) {
            name = n.url || "invalid-url";
          }

          // Waterfall logic
          const startPct = ((n.relativeMs || 0) / maxRelativeMs) * 100;
          const widthPct = Math.max(
            0.5,
            ((n.duration || 0) / maxRelativeMs) * 100,
          );

          // Preflight Detection (Jika ada OPTIONS untuk URL yang sama di waktu berdekatan)
          const hasPreflight = netArr.some(
            (prev) =>
              prev.method === "OPTIONS" &&
              prev.url === n.url &&
              Math.abs(prev.relativeMs - n.relativeMs) < 1000,
          );

          return `<tr class="${selectedReq === n ? "selected" : ""} log-jump-target" data-idx="${netArr.indexOf(n)}" data-time-ms="${n.relativeMs || 0}">
          <td class="col-idx">${i + 1}</td>
          <td>
            <div class="col-name-container" title="${n.url}">
              <span class="log-jump-btn">⏯️</span>
              <span style="font-weight:500;">${name}</span>
            </div>
          </td>
          <td class="col-method">
            ${n.method}${hasPreflight ? ' <small style="color:#888;font-weight:normal;">+Preflight</small>' : ""}
          </td>
          <td class="col-status ${statusClass}">
            ${n.status || "Error"}
          </td>
          <td class="col-domain" title="${domain}">${domain}</td>
          <td class="col-type">${n.type || "xhr"}</td>
          <td style="font-size:11px; color:#666;">${n.frameContext || "Main Frame"}</td>
          <td class="col-size">${n.fromCache ? "(Cached)" : formatSize(n.size)}</td>
          <td class="col-time">${n.duration ? n.duration + "ms" : "-"}</td>
          <td class="col-waterfall">
            <div class="wf-bg">
              <div class="wf-bar ${isErr ? "error" : n.fromCache ? "cached" : ""}" style="left:${startPct}%; width:${widthPct}%;"></div>
            </div>
          </td>
        </tr>`;
        })
        .join("");

      document.getElementById("networkLogs").innerHTML =
        nHtml ||
        '<tr><td colspan="10" style="text-align:center; padding:40px; color:#999;">No network logs found matching filters.</td></tr>';

      // Attach row clicks
      document.querySelectorAll("#networkLogs tr").forEach((row) => {
        row.addEventListener("click", () => {
          const idx = parseInt(row.getAttribute("data-idx"));
          selectedReq = netArr[idx];
          renderNetwork();
          showDetails(selectedReq);
        });
      });
    }

    // Detail Panel Logic
    const panel = document.getElementById("networkDetailsPanel");
    const closeBtn = document.getElementById("closeDetails");
    const dPanels = document.querySelectorAll(".d-panel");
    const dList = document.getElementById("detailsHeaders");

    function getHeaderValue(headers, name) {
      if (!headers) return "";
      const target = String(name || "").toLowerCase();
      for (const key in headers) {
        if (String(key).toLowerCase() === target) return headers[key];
      }
      return "";
    }

    function getResponseBodyText(req) {
      if (!req) return "";
      if (req.responseBody !== undefined && req.responseBody !== null) return String(req.responseBody);
      if (req.responseText !== undefined && req.responseText !== null) return String(req.responseText);
      if (req.body !== undefined && req.body !== null) return String(req.body);
      return "";
    }

    function getResponseMeta(req) {
      const responseHeaders = (req && req.responseHeaders) || {};
      const requestHeaders = (req && req.requestHeaders) || {};
      const contentType = String(
        req && (req.mimeType || getHeaderValue(responseHeaders, "content-type") || getHeaderValue(requestHeaders, "content-type") || "")
      ).toLowerCase();
      const contentEncoding = String(getHeaderValue(responseHeaders, "content-encoding") || getHeaderValue(requestHeaders, "content-encoding") || "").toLowerCase();
      const bodyText = getResponseBodyText(req);
      const trimmed = bodyText.trim();
      const size = Number(req && (req.encodedDataLength || req.size || bodyText.length || 0)) || 0;
      return {
        contentType,
        contentEncoding,
        bodyText,
        trimmed,
        size,
        mimeType: String((req && req.mimeType) || contentType || ""),
        isBase64: !!(req && (req.responseBodyBase64Encoded || req.responseBase64Encoded)),
      };
    }

    function looksLikeBase64(text) {
      const s = String(text || "").replace(/\s+/g, "");
      return s.length > 80 && /^[A-Za-z0-9+/=]+$/.test(s);
    }

    function looksLikeEventStream(text, contentType) {
      const ct = (contentType || "").toLowerCase();
      if (ct.includes("event-stream") || ct.includes("eventstream")) return true;
      
      const s = String(text || "").trim();
      if (!s) return false;
      
      const lines = s.split("\n");
      let matchCount = 0;
      const checkCount = Math.min(lines.length, 10);
      for (let i = 0; i < checkCount; i++) {
        const line = lines[i].trim();
        if (line.startsWith("event:") || line.startsWith("data:") || line.startsWith("id:") || line.startsWith("retry:")) {
          matchCount++;
        }
      }
      return matchCount >= 1;
    }

    function renderEventStream(text) {
      const lines = String(text || "").split("\n");
      let html = `<div class="event-stream-container" style="font-family: monospace; font-size: 11px; padding: 12px; line-height: 1.5;">`;
      
      lines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          html += `<div class="event-stream-separator" style="margin-top: 12px; border-top: 1px dashed #ddd; height: 1px;"></div>`;
          return;
        }
        
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx === -1) {
          html += `<div style="color: #666; margin-bottom: 2px;">${escapeHtml(trimmed)}</div>`;
          return;
        }
        
        const key = trimmed.slice(0, colonIdx).trim();
        const val = trimmed.slice(colonIdx + 1).trim();
        const displayKey = key.charAt(0).toUpperCase() + key.slice(1);
        
        let valHtml = "";
        if (val.startsWith("{") || val.startsWith("[")) {
          try {
            const parsed = JSON.parse(val);
            const pretty = JSON.stringify(parsed, null, 2);
            valHtml = `<pre style="margin: 4px 0 0 0; padding: 8px; background: #fafafa; border: 1px solid #eaeaea; border-radius: 4px; font-family: monospace; font-size: 11px; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; color: #111;">${escapeHtml(pretty)}</pre>`;
          } catch (e) {
            valHtml = `<span style="color: #222; font-weight: normal; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;">${escapeHtml(val)}</span>`;
          }
        } else {
          valHtml = `<span style="color: #222; font-weight: normal; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;">${escapeHtml(val)}</span>`;
        }
        
        let keyStyle = "font-weight: bold; color: #1a73e8; min-width: 60px; display: inline-block;";
        if (key.toLowerCase() === "data") {
          keyStyle = "font-weight: bold; color: #188038; display: block; margin-top: 4px;";
        } else if (key.toLowerCase() === "event") {
          keyStyle = "font-weight: bold; color: #b06000; min-width: 60px; display: inline-block;";
        } else if (key.toLowerCase() === "id") {
          keyStyle = "font-weight: bold; color: #5f6368; min-width: 60px; display: inline-block;";
        }
        
        if (key.toLowerCase() === "data") {
          html += `<div style="margin-bottom: 6px;"><span style="${keyStyle}">${displayKey}:</span>${valHtml}</div>`;
        } else {
          html += `<div style="margin-bottom: 2px;"><span style="${keyStyle}">${displayKey}:</span> ${valHtml}</div>`;
        }
      });
      
      html += `</div>`;
      return html;
    }

    function guessResponseKind(meta) {
      const ct = meta.contentType || "";
      const body = meta.bodyText || "";
      const trimmed = body.trim();

      if (looksLikeEventStream(body, ct)) {
        return "event-stream";
      }

      if (ct.includes("application/json") || ct.includes("+json") || (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        return "json";
      }

      if (ct.includes("text/html") || (trimmed.startsWith("<html") || trimmed.startsWith("<!DOCTYPE html"))) {
        return "html";
      }

      if (ct.includes("xml") || trimmed.startsWith("<?xml") || (trimmed.startsWith("<") && trimmed.includes("xmlns="))) {
        return "xml";
      }

      if (ct.includes("javascript") || ct.includes("ecmascript")) {
        return "javascript";
      }

      if (ct.startsWith("image/")) {
        return "image";
      }

      if (ct.includes("gzip") || ct.includes("application/octet-stream") || ct.includes("binary") || (meta.isBase64 && looksLikeBase64(body))) {
        return "binary";
      }

      return "text";
    }

    function highlightPlainCode(text, kind) {
      const safe = escapeHtml(text || "");
      if (kind === "html" || kind === "xml") {
        return safe
          .replace(/(&lt;\/?)([A-Za-z0-9:-]+)/g, '$1<span class="code-token tag-name" style="color: #c80000; font-weight: bold;">$2</span>')
          .replace(/([A-Za-z0-9:-]+)=(&quot;.*?&quot;|&#39;.*?&#39;)/g, '<span class="code-token attr-name" style="color: #188038;">$1</span>=<span class="code-token attr-value" style="color: #0f7d3e;">$2</span>');
      }
      if (kind === "javascript") {
        return safe
          .replace(/\b(const|let|var|function|return|if|else|for|while|try|catch|throw|async|await|new|class|extends|import|from|export)\b/g, '<span class="code-token keyword" style="color: #1a73e8; font-weight: bold;">$1</span>')
          .replace(/(&quot;(?:\\.|[^&])*?&quot;|'(?:\\.|[^'])*?')/g, '<span class="code-token string" style="color: #0f7d3e;">$1</span>')
          .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="code-token number" style="color: #1050a0;">$1</span>');
      }
      if (kind === "json") {
        return safe
          .replace(/(&quot;[^&]*?&quot;)(?=\s*:)/g, '<span class="code-token json-key" style="color: #c80000; font-weight: 600;">$1</span>')
          .replace(/(:\s*)(&quot;[^&]*?&quot;)/g, '$1<span class="code-token json-string" style="color: #0f7d3e;">$2</span>')
          .replace(/(:\s*)(\b\d+(?:\.\d+)?\b)/g, '$1<span class="code-token json-number" style="color: #1050a0;">$2</span>')
          .replace(/(:\s*)(\b(?:true|false|null)\b)/g, '$1<span class="code-token json-boolean" style="color: #b5500e; font-weight: 500;">$2</span>');
      }
      return safe;
    }

    function renderCodeBlock(text, kind, title) {
      const safeKind = kind || "text";
      const header = title ? `<div class="detail-section-header">${escapeHtml(title)}</div>` : "";
      return `<div class="detail-section response-section"><div class="code-block-shell">${header}<pre class="response-code response-code-${safeKind}" style="white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; padding: 12px; background: #f8f9fa; border: 1px solid #eee; border-radius: 4px; font-family: monospace; font-size: 11px; margin: 0; line-height: 1.4;">${highlightPlainCode(text, safeKind)}</pre></div></div>`;
    }

    function renderBodySummary(req, label) {
      const meta = getResponseMeta(req);
      const mime = meta.mimeType ? escapeHtml(meta.mimeType) : "(unknown)";
      const encoding = meta.contentEncoding ? ` • ${escapeHtml(meta.contentEncoding)}` : "";
      return `<div class="response-empty-state"><div class="response-empty-title">${escapeHtml(label || "No response captured")}</div><div class="response-empty-meta">${mime}${encoding ? ` • ${encoding}` : ""} • ${meta.size} bytes</div></div>`;
    }

    function renderCookieRows(items, emptyLabel) {
      const list = Array.isArray(items) ? items : [];
      if (!list.length) return `<div class="response-empty-state"><div class="response-empty-title">${escapeHtml(emptyLabel || "No cookies captured")}</div></div>`;
      const rows = list.map((item) => {
        if (typeof item === "string") {
          return `<div class="detail-item"><div class="detail-label">Cookie</div><div class="detail-value">${escapeHtml(item)}</div></div>`;
        }
        const cookie = item.cookie || item;
        const name = cookie.name || item.name || "(unnamed)";
        const value = cookie.value || item.value || "";
        const domain = cookie.domain || item.domain || "";
        const path = cookie.path || item.path || "";
        const reasons = item.blockedReasons || item.reasons || [];
        const meta = [domain, path ? `path=${path}` : "", reasons.length ? `blocked: ${reasons.join(", ")}` : ""].filter(Boolean).join(" • ");
        return `<div class="detail-item"><div class="detail-label">${escapeHtml(name)}</div><div class="detail-value"><div>${escapeHtml(value || "")}</div>${meta ? `<div class="response-cookie-meta">${escapeHtml(meta)}</div>` : ""}</div></div>`;
      }).join("");
      return `<div class="detail-section">${rows}</div>`;
    }

    function renderCookiesPanel(req) {
      const requestCookies = (req.requestCookies && req.requestCookies.length > 0)
        ? req.requestCookies
        : (req.requestCookieHeader ? [req.requestCookieHeader] : (req.associatedCookies || []));
      const responseCookies = req.responseCookies || req.setCookieHeaders || [];
      const blockedCookies = req.blockedCookies || [];
      return `
        <div class="detail-section">
          <div class="detail-section-header">Request Cookies</div>
          ${renderCookieRows(requestCookies, "No request cookies captured")}
        </div>
        <div class="detail-section">
          <div class="detail-section-header">Response Cookies</div>
          ${renderCookieRows(responseCookies, "No response cookies captured")}
        </div>
        <div class="detail-section">
          <div class="detail-section-header">Blocked / Filtered Cookies</div>
          ${renderCookieRows(blockedCookies, "No blocked cookies captured")}
        </div>`;
    }

    function renderTimingPanel(req) {
      const timing = req.timing || {};
      const duration = req.duration != null ? `${req.duration} ms` : "-";
      const responseEnd = timing.receiveHeadersEnd != null ? `${Math.round(timing.receiveHeadersEnd)} ms` : (req.responseEnd != null ? `${req.responseEnd} ms` : duration);
      const ttfb = timing.receiveHeadersEnd != null ? `${Math.round(timing.receiveHeadersEnd)} ms` : (req.ttfb != null ? `${req.ttfb} ms` : "-");
      const startTime = req.startTimeAbs != null ? new Date(req.startTimeAbs).toLocaleTimeString() : (req.relativeMs != null ? `${req.relativeMs} ms` : "-");
      return `
        <div class="detail-section">
          <div class="detail-section-header">Timing</div>
          <div class="detail-item"><div class="detail-label">startTime</div><div class="detail-value">${escapeHtml(String(startTime))}</div></div>
          <div class="detail-item"><div class="detail-label">duration</div><div class="detail-value">${escapeHtml(String(duration))}</div></div>
          <div class="detail-item"><div class="detail-label">responseEnd</div><div class="detail-value">${escapeHtml(String(responseEnd))}</div></div>
          <div class="detail-item"><div class="detail-label">TTFB</div><div class="detail-value">${escapeHtml(String(ttfb))}</div></div>
        </div>`;
    }

    function renderInitiatorPanel(req) {
      const initiator = req.initiator || {};
      const type = initiator.type || req.initiatorType || req.type || "unknown";
      const url = initiator.url || req.initiatorUrl || "";
      const lineNumber = initiator.lineNumber != null ? initiator.lineNumber : "";
      const columnNumber = initiator.columnNumber != null ? initiator.columnNumber : "";
      const stack = initiator.stack || initiator.stackTrace || null;
      let html = `
        <div class="detail-section">
          <div class="detail-section-header">Initiator</div>
          <div class="detail-item"><div class="detail-label">type</div><div class="detail-value">${escapeHtml(String(type))}</div></div>
          <div class="detail-item"><div class="detail-label">url</div><div class="detail-value">${url ? escapeHtml(String(url)) : "-"}</div></div>
          <div class="detail-item"><div class="detail-label">line</div><div class="detail-value">${lineNumber !== "" ? escapeHtml(String(lineNumber)) : "-"}</div></div>
          <div class="detail-item"><div class="detail-label">column</div><div class="detail-value">${columnNumber !== "" ? escapeHtml(String(columnNumber)) : "-"}</div></div>
        </div>`;
      if (stack && stack.callFrames && stack.callFrames.length) {
        const frames = stack.callFrames.map((frame) => `<div class="initiator-frame"><span class="initiator-frame-url">${escapeHtml(frame.url || "")}</span><span class="initiator-frame-line">${frame.lineNumber != null ? frame.lineNumber : "-"}:${frame.columnNumber != null ? frame.columnNumber : "-"}</span></div>`).join("");
        html += `<div class="detail-section"><div class="detail-section-header">Stack Trace</div>${frames}</div>`;
      }
      return html;
    }

    function hasResponse(req) {
      const body =
        req?.responseBody ||
        req?.responseText ||
        req?.body ||
        '';

      const text = String(body).trim();

      // Jangan tampilkan response kalau cuma placeholder
      if (
        !text ||
        text === '(Beacon Sent)' ||
        text === 'No response body captured'
      ) {
        return false;
      }

      return true;
    }

    function hasPreview(req) {
      return hasResponse(req);
    }

    function hasCookies(req) {
      return (
        (req?.requestCookies?.length || 0) > 0 ||
        (req?.responseCookies?.length || 0) > 0 ||
        (req?.blockedCookies?.length || 0) > 0
      );
    }

    function hasTiming(req) {
      return !!(
        req?.duration ||
        req?.timing
      );
    }

    function hasInitiator(req) {
      return !!(
        req?.initiator ||
        req?.initiatorType
      );
    }

    function renderResponseBody(req, mode) {
      const meta = getResponseMeta(req);
      const kind = guessResponseKind(meta);
      const body = meta.bodyText;
      const hasBody = !!body.trim();
      const title = mode === "preview" ? "Preview" : "Response";

      if (!hasBody) {
        return renderBodySummary(req, `No ${title.toLowerCase()} body captured`);
      }

      if (kind === "event-stream") {
        const streamHtml = renderEventStream(body);
        return `<div class="detail-section response-section"><div class="code-block-shell"><div class="detail-section-header">${title} (SSE/Event-Stream)</div>${streamHtml}</div></div>`;
      }

      if (kind === "json") {
        try {
          const parsed = JSON.parse(body);
          const pretty = JSON.stringify(parsed, null, 2);
          const tree = `<div class="response-tree">${renderJsonTree(parsed)}</div>`;
          const code = renderCodeBlock(pretty, "json", "Pretty JSON");
          return mode === "preview" ? tree : `<div class="response-stack">${tree}${code}</div>`;
        } catch (err) {
          return renderCodeBlock(body, "text", title);
        }
      }

      if (kind === "image") {
        const src = meta.isBase64 || looksLikeBase64(body) ? `data:${meta.mimeType || "image/png"};base64,${body.replace(/\s+/g, "")}` : body;
        if (mode === "preview") {
          return `<div class="response-preview-card"><img class="response-image" alt="Response image preview" src="${escapeHtml(src)}"><div class="response-image-meta">${escapeHtml(meta.mimeType || "image")}${meta.contentEncoding ? ` • ${escapeHtml(meta.contentEncoding)}` : ""} • ${meta.size} bytes</div></div>`;
        }
        return `<div class="response-stack"><div class="response-preview-card"><img class="response-image" alt="Response image preview" src="${escapeHtml(src)}"></div>${renderBodySummary(req, "Image response")}</div>`;
      }

      if (kind === "html") {
        const frame = `<iframe class="response-html-frame" sandbox="allow-forms allow-scripts allow-same-origin" srcdoc="${escapeHtml(body)}" style="width: 100%; height: 350px; border: 1px solid #ddd; border-radius: 4px; background: #fff;"></iframe>`;
        if (mode === "preview") {
          return `<div class="response-preview-card">${frame}<div class="response-image-meta">${escapeHtml(meta.mimeType || "text/html")} • ${meta.size} bytes</div></div>`;
        }
        return `<div class="response-stack">${frame}${renderCodeBlock(body, "html", "HTML Source")}</div>`;
      }

      if (kind === "xml") {
        return mode === "preview" ? renderCodeBlock(body, "xml", "XML Preview") : renderCodeBlock(body, "xml", "Response Body");
      }

      if (kind === "javascript") {
        return mode === "preview" ? renderCodeBlock(body, "javascript", "JavaScript Preview") : renderCodeBlock(body, "javascript", "Response Body");
      }

      if (kind === "binary") {
        return renderBodySummary(req, `Binary response${meta.contentEncoding ? ` (${meta.contentEncoding})` : ""}`);
      }

      return renderCodeBlock(body, "text", title);
    }

    function showDetails(req) {
      if (!req) return;
      const networkTab = document.getElementById("tabNetwork");
      networkTab.classList.add("detail-open");

      // Generate dynamic tabs
      let tabsHtml = `<div class="d-tab active" data-dtool="headers">Headers</div>`;

      const hasPayload = !req.isStatic && (!!req.payloadText || !!req.requestBody || (req.parsedPayload && Object.keys(req.parsedPayload || {}).length > 0));
      if (hasPayload) {
        tabsHtml += `<div class="d-tab" data-dtool="payload">Payload</div>`;
      }

      if (hasResponse(req)) {
        tabsHtml += `
          <div class="d-tab" data-dtool="response">
            Response
          </div>
        `;
      }

      if (hasPreview(req)) {
        tabsHtml += `<div class="d-tab" data-dtool="preview">Preview</div>`;
      }

      if (hasCookies(req)) {
        tabsHtml += `<div class="d-tab" data-dtool="cookies">Cookies</div>`;
      }

      if (hasTiming(req)) {
        tabsHtml += `<div class="d-tab" data-dtool="timing">Timing</div>`;
      }

      if (hasInitiator(req)) {
        tabsHtml += `<div class="d-tab" data-dtool="initiator">Initiator</div>`;
      }

      const dynamicTabsContainer = document.getElementById("networkDynamicTabs");
      if (dynamicTabsContainer) {
        dynamicTabsContainer.innerHTML = tabsHtml;
      }

      // Hide all panels, activate headers
      const dPanelsLocal = document.querySelectorAll(".details-body .d-panel");
      dPanelsLocal.forEach((p) => p.classList.remove('active'));
      const hPanel = document.getElementById("detailsHeaders");
      if (hPanel) hPanel.classList.add('active');

      renderDetailTab("headers", req);
    }

    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const networkTab = document.getElementById("tabNetwork");
      networkTab.classList.remove("detail-open");
      selectedReq = null;
      renderNetwork();
    });

    // Event Delegation for Dynamic Tabs
    const dynamicTabsContainer = document.getElementById("networkDynamicTabs");
    if (dynamicTabsContainer) {
      dynamicTabsContainer.addEventListener("click", (e) => {
        const t = e.target.closest(".d-tab");
        if (!t) return;

        // Remove active from all tabs inside container
        dynamicTabsContainer.querySelectorAll(".d-tab").forEach(i => i.classList.remove("active"));

        // Remove active from all panels
        document.querySelectorAll(".details-body .d-panel").forEach(i => i.classList.remove("active"));

        t.classList.add("active");
        const tool = t.getAttribute("data-dtool");

        const panelId = "details" + tool.charAt(0).toUpperCase() + tool.slice(1);
        const panelEl = document.getElementById(panelId);
        if (panelEl) {
          panelEl.classList.add("active");
        }

        if (selectedReq) renderDetailTab(tool, selectedReq);
      });
    }

    function renderDetailTab(tab, req) {
      const dList = document.getElementById("detailsHeaders");
      const pCont = document.getElementById("detailsPayload");
      const rCont = document.getElementById("detailsResponse");
      const prevCont = document.getElementById("detailsPreview");
      const cCont = document.getElementById("detailsCookies");
      const tCont = document.getElementById("detailsTiming");
      const iCont = document.getElementById("detailsInitiator");

      if (tab === "headers") {
        let html = `
          <div class="detail-section">
            <div class="detail-section-header">General</div>
            <div class="detail-item"><div class="detail-label">Request URL:</div><div class="detail-value">${req.url}</div></div>
            <div class="detail-item"><div class="detail-label">Request Method:</div><div class="detail-value">${req.method}</div></div>
            <div class="detail-item"><div class="detail-label">Status Code:</div><div class="detail-value status-200">${req.status || "200"}</div></div>
            <div class="detail-item"><div class="detail-label">MIME Type:</div><div class="detail-value">${escapeHtml(String(req.mimeType || getHeaderValue(req.responseHeaders, "content-type") || getHeaderValue(req.requestHeaders, "content-type") || "-"))}</div></div>
            <div class="detail-item"><div class="detail-label">Size:</div><div class="detail-value">${req.size != null ? formatSize(req.size) : "-"}</div></div>
            <div class="detail-item"><div class="detail-label">Duration:</div><div class="detail-value">${req.duration != null ? `${req.duration}ms` : "-"}</div></div>
          </div>`;

        if (req.responseHeaders) {
          html += `<div class="detail-section">
            <div class="detail-section-header">Response Headers</div>`;
          for (let k in req.responseHeaders) {
            html += `<div class="detail-item"><div class="detail-label">${k}:</div><div class="detail-value">${req.responseHeaders[k]}</div></div>`;
          }
          html += `</div>`;
        }

        if (req.requestHeaders) {
          html += `<div class="detail-section">
            <div class="detail-section-header">Request Headers</div>`;
          for (let k in req.requestHeaders) {
            html += `<div class="detail-item"><div class="detail-label">${k}:</div><div class="detail-value">${req.requestHeaders[k]}</div></div>`;
          }
          html += `</div>`;
        }
        if (dList) dList.innerHTML = html;
      } else if (tab === "payload") {
        if (pCont) {
          if (req.isStatic) {
            pCont.innerHTML = '<div class="p-4 text-gray-500">Not available for static resources</div>';
          } else {
            pCont.innerHTML = renderPrettyPayload(req);
          }
        }
      } else if (tab === "response") {
        if (rCont) {
          if (req.isStatic) {
            rCont.innerHTML = '<div class="p-4 text-gray-500">Not available for static resources</div>';
          } else {
            rCont.innerHTML = renderResponseBody(req, "response");
          }
        }
      } else if (tab === "preview") {
        if (prevCont) {
          prevCont.innerHTML = renderResponseBody(req, "preview");
        }
      } else if (tab === "cookies") {
        if (cCont) {
          cCont.innerHTML = renderCookiesPanel(req);
        }
      } else if (tab === "timing") {
        if (tCont) {
          tCont.innerHTML = renderTimingPanel(req);
        }
      } else if (tab === "initiator") {
        if (iCont) {
          iCont.innerHTML = renderInitiatorPanel(req);
        }
      }
    }

        function renderPrettyPayload(req) {
          const payloadType = String(req && req.payloadType ? req.payloadType : '').toLowerCase();
          const parsedPayload = req ? req.parsedPayload : null;
          const payloadText = req && req.payloadText ? String(req.payloadText) : (req && req.requestBody ? String(req.requestBody) : '');
                    const ct =
                      (req.responseHeaders &&
                        (req.responseHeaders['content-type'] ||
                         req.responseHeaders['Content-Type'])) ||
                      (req.requestHeaders &&
                        (req.requestHeaders['content-type'] ||
                         req.requestHeaders['Content-Type'])) ||
                      '';
          // If no request body captured, but URL contains query params, show them like DevTools
          if ((!payloadText || !String(payloadText).trim()) && !parsedPayload) {
            try {
              if (req && req.url && req.url.indexOf('?') !== -1) {
                const u = new URL(req.url);
                const entries = [...u.searchParams.entries()];
                if (entries.length) return renderQueryParameters(entries, 'Query String Parameters');
              }
            } catch (e) {}

            return '<div style="padding:16px;background:#f8f9fa;border-radius:4px;font-size:12px;color:#666;">(No payload captured)</div>';
          }

          if (payloadType === 'binary') {
            return '<div style="padding:16px;background:#f8f9fa;border-radius:4px;font-size:12px;color:#666;">(Binary payload)</div>';
          }

          // GraphQL
          if (payloadType === 'graphql' || (parsedPayload && typeof parsedPayload === 'object' && parsedPayload.query)) {
            const query = escapeHtml(parsedPayload.query || '');
            const variables = parsedPayload.variables ? escapeHtml(JSON.stringify(parsedPayload.variables, null, 2)) : '(No variables)';
            const operation = parsedPayload.operationName ? escapeHtml(String(parsedPayload.operationName)) : '(None)';
            return `
              <div class="detail-section">
                <div class="detail-section-header">GraphQL</div>
                <div class="detail-item"><div class="detail-label">Operation</div><div class="detail-value" style="white-space:pre-wrap;font-family:monospace;">${operation}</div></div>
                <div class="detail-item"><div class="detail-label">Query</div><div class="detail-value"><pre style="margin:0;white-space:pre-wrap;background:#f8f9fa;padding:12px;border-radius:4px;font-size:11px;font-family:monospace;">${query}</pre></div></div>
                <div class="detail-item"><div class="detail-label">Variables</div><div class="detail-value"><pre style="margin:0;white-space:pre-wrap;background:#f8f9fa;padding:12px;border-radius:4px;font-size:11px;font-family:monospace;">${variables}</pre></div></div>
              </div>`;
          }

          // Form-Data
          if (payloadType === 'multipart/form-data' && parsedPayload && typeof parsedPayload === 'object') {
            return renderObjectAsTable(parsedPayload, 'Form Data');
          }

          // Try JSON
          try {
            if (payloadText) {
              const parsed = JSON.parse(payloadText);
              const pretty = JSON.stringify(parsed, null, 2);
              return `<pre style="padding:16px;background:#f8f9fa;border-radius:4px;font-size:11px;font-family:monospace;white-space:pre-wrap;overflow-x:auto;">${escapeHtml(pretty)}</pre>`;
            }
          } catch (e) {}

          // Form-urlencoded
          if (payloadType === 'application/x-www-form-urlencoded' || (payloadText && payloadText.includes('=') && payloadText.includes('&'))) {
            try {
              const params = new URLSearchParams(payloadText);
              const entries = [];
              for (let [k, v] of params) {
                entries.push([k, v]);
              }
              return renderKeyValueRows(entries, 'Form Parameters');
            } catch (e) {}
          }

          // Default: raw text
          // But try to detect binary-like payloads (numeric arrays/base64) and render nicer
          const binaryRendered = tryRenderBinaryPayload(payloadText, ct);
          if (binaryRendered) return binaryRendered;

          return `<pre style="padding:16px;background:#f8f9fa;border-radius:4px;font-size:11px;font-family:monospace;white-space:pre-wrap;overflow-x:auto;">${escapeHtml(payloadText)}</pre>`;
        }

        function renderObjectAsTable(obj, title) {
          const rows = Object.entries(obj || {}).map(([key, value]) => {
            const displayValue = Array.isArray(value) || (value && typeof value === 'object')
              ? escapeHtml(JSON.stringify(value, null, 2))
              : escapeHtml(String(value));
            return `<div class="detail-item"><div class="detail-label">${escapeHtml(key)}</div><div class="detail-value" style="white-space:pre-wrap;font-family:monospace;word-break:break-word;font-size:11px;">${displayValue}</div></div>`;
          }).join('');
          return `<div class="detail-section"><div class="detail-section-header">${escapeHtml(title)}</div>${rows}</div>`;
        }

        function renderKeyValueRows(entries, title) {
          const rows = entries.map(([key, value]) => 
            `<div class="detail-item"><div class="detail-label">${escapeHtml(String(key))}</div><div class="detail-value" style="white-space:pre-wrap;font-family:monospace;word-break:break-word;font-size:11px;">${escapeHtml(String(value))}</div></div>`
          ).join('');
          return `<div class="detail-section"><div class="detail-section-header">${escapeHtml(title)}</div>${rows}</div>`;
        }

        // Render query parameters with support for complex values (JSON strings, nested key-values)
        function renderQueryParameters(entries, title) {
          const rows = entries.map(([key, value]) => {
            const raw = value == null ? '' : String(value);
            let valHtml = escapeHtml(raw);

            // Try JSON parse
            try {
              const trimmed = raw.trim();
              if (trimmed && (trimmed[0] === '{' || trimmed[0] === '[')) {
                const parsed = JSON.parse(trimmed);
                valHtml = `<div class="jt-root">${renderJsonTree(parsed)}</div>`;
              } else if (trimmed.includes('=') && trimmed.includes('&')) {
                // value looks like nested querystring (encoded object)
                try {
                  const sp = new URLSearchParams(trimmed);
                  const sub = [...sp.entries()].map(([k, v]) => `<div style="display:flex"><div style="width:220px;color:#666">${escapeHtml(k)}</div><div style="flex:1">${escapeHtml(v)}</div></div>`).join('');
                  valHtml = `<div style="font-family:monospace">${sub}</div>`;
                } catch (e) {}
              }
            } catch (e) {
              valHtml = escapeHtml(raw);
            }

            return `<div class="detail-item"><div class="detail-label">${escapeHtml(String(key))}</div><div class="detail-value" style="white-space:pre-wrap;font-family:monospace;word-break:break-word;font-size:11px;">${valHtml}</div></div>`;
          }).join('');
          return `<div class="detail-section"><div class="detail-section-header">${escapeHtml(title)}</div>${rows}</div>`;
        }

        // Binary detection & rendering helper
        function tryRenderBinaryPayload(payload, contentType) {
          if (!payload) return null;
          const s = String(payload).trim();

          // Detect numeric CSV byte arrays like: 31,139,8,0,0...
          const csvMatch = /^\s*\d+(?:\s*,\s*\d+)+\s*$/;
          let bytes = null;
          if (csvMatch.test(s)) {
            try {
              const nums = s.split(',').map(x => parseInt(x.trim(), 10));
              bytes = new Uint8Array(nums);
            } catch (e) { bytes = null; }
          }

          // If payload was base64 encoded? Try decode if looks like base64 and fairly long
          const maybeBase64 = /^[A-Za-z0-9+/=\r\n]+$/.test(s) && s.length > 100;
          if (!bytes && maybeBase64) {
            try {
              // atob may throw
              const bin = atob(s.replace(/\s+/g, ''));
              const arr = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
              bytes = arr;
            } catch (e) { bytes = null; }
          }

          // If contentType suggests binary
          const ct = (contentType || '').toLowerCase();
          if (!bytes && (ct.includes('application/octet-stream') || ct.includes('gzip') || ct.includes('application/x-protobuf') || ct.includes('multipart/form-data'))) {
            // nothing to convert if payload is textual string but content-type binary
            // attempt to interpret payload as latin1 bytes
            try {
              const arr = new Uint8Array(s.length);
              for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i) & 0xff;
              bytes = arr;
            } catch (e) { bytes = null; }
          }

          if (!bytes) return null;

          // Try decode as UTF-8
          try {
            const dec = new TextDecoder('utf-8', { fatal: false });
            const text = dec.decode(bytes);
            // Measure readability: ratio of printable chars
            let printable = 0;
            for (let i = 0; i < text.length; i++) {
              const code = text.charCodeAt(i);
              if (code === 9 || code === 10 || code === 13) printable++;
              else if (code >= 32 && code <= 126) printable++;
            }
            const ratio = text.length ? printable / text.length : 0;
            if (ratio > 0.6) {
              return `<pre style="padding:16px;background:#f8f9fa;border-radius:4px;font-size:11px;font-family:monospace;white-space:pre-wrap;overflow-x:auto;">${escapeHtml(text)}</pre>`;
            }
          } catch (e) {}

          // If not readable, show binary indicator
          const len = bytes.length;
          const gzipHint = (bytes[0] === 0x1f && bytes[1] === 0x8b) ? ' (gzip)' : '';
          const mimeHint = ct ? ` — ${escapeHtml(ct)}` : '';
          return `<div style="padding:16px;background:#f8f9fa;border-radius:4px;font-size:12px;color:#666;">(Binary payload)<br/>Byte length: ${len}${gzipHint}${mimeHint}</div>`;
        }

        function escapeHtml(text) {
          return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }

        // Copy as cURL (bash) handler — attach to the specific button
        const btnCurlNet = document.getElementById('btnCurlNet');
        if (btnCurlNet) {
          btnCurlNet.addEventListener('click', async () => {
            if (!selectedReq) return;
            const originalText = btnCurlNet.innerText;
            try {
              const curl = buildCurlCommand(selectedReq);
              await navigator.clipboard.writeText(curl);
              btnCurlNet.innerText = 'Copied!';
              setTimeout(() => (btnCurlNet.innerText = originalText), 2000);
            } catch (err) {
              console.error('[BERIBUG] cURL copy failed:', err.message);
              btnCurlNet.innerText = 'Copy failed';
              setTimeout(() => (btnCurlNet.innerText = originalText), 2000);
            }
          });
        }

        function buildCurlCommand(req) {
          const headers = req.requestHeaders || {};
          const headerFlags = Object.entries(headers)
            .filter(([k]) => k.toLowerCase() !== 'content-length')
            .map(([k, v]) => `-H '${escapeSingleQuotes(`${k}: ${v}`)}'`)
            .join(' ');
          const method = req.method || 'GET';
          const payloadType = String(req.payloadType || '').toLowerCase();
          const body = req.payloadText || req.requestBody || '';
          let bodyFlag = '';

          if (payloadType === 'multipart/form-data' && req.parsedPayload && typeof req.parsedPayload === 'object') {
            const formFlags = [];
            Object.entries(req.parsedPayload).forEach(([key, value]) => {
              if (Array.isArray(value)) {
                value.forEach(item => {
                  if (item && typeof item === 'object' && item.name) {
                    formFlags.push(`-F '${escapeSingleQuotes(`${key}=@${item.name}`)}'`);
                  } else {
                    formFlags.push(`-F '${escapeSingleQuotes(`${key}=${item}`)}'`);
                  }
                });
              } else {
                formFlags.push(`-F '${escapeSingleQuotes(`${key}=${value}`)}'`);
              }
            });
            bodyFlag = formFlags.join(' ');
          } else if (body) {
            bodyFlag = `--data-raw '${escapeSingleQuotes(body)}'`;
          }

      // Preserve scheme even for chrome-extension/blob/data etc.
      const url = String(req.url || '');
      const schemeMatch = url.match(/^([a-z0-9+.-]+):/i);
      const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';
      const needsWarning = scheme && !['http', 'https'].includes(scheme);
      const warning = needsWarning
        ? "# This URL scheme may not be executable outside browser context\n"
        : '';

      const parts = ["curl", `'${escapeSingleQuotes(url)}'`, "-X", method];
      if (headerFlags) parts.push(headerFlags);
      if (bodyFlag) parts.push(bodyFlag);

      return (warning + parts.join(' ').replace(/\s+/g, ' ').trim());
    }

    function escapeSingleQuotes(s) {
      return String(s).replace(/'/g, "'\\''");
    }

    // Network Listeners
    document
      .getElementById("networkFilterInput")
      .addEventListener("input", (e) => {
        nSearch = e.target.value;
        renderNetwork();
      });
    document
      .getElementById("networkErrorsOnly")
      .addEventListener("change", (e) => {
        nErrorsOnly = e.target.checked;
        renderNetwork();
      });
    document.querySelectorAll("#networkPills button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document
          .querySelectorAll("#networkPills button")
          .forEach((b) => b.classList.remove("active", "pill-dark"));
        btn.classList.add("active", "pill-dark");
        nTypeFilter = btn.getAttribute("data-filter");
        renderNetwork();
      });
    });

    renderNetwork();

    // --- ACTIONS LIST ---
    const actions = (sessionLogs.actions || [])
      .slice()
      .sort(
        (a, b) =>
          (a.relativeMs || parseSec(a.time) * 1000) -
          (b.relativeMs || parseSec(b.time) * 1000),
      );
    const aHtml = actions
      .map((a) => {
        const match = (a.time || "").match(/\[(\d+:\d+)\]/);
        const t = match ? match[1] : "0:00";
        const sec = parseSec(a.time);
        const isNav = a.event && a.event.includes("Navigated");
        const isClick = a.event && a.event.includes("Click");
        const isInput =
          a.event &&
          (a.event.includes("Typed") ||
            a.event.includes("Input") ||
            a.event.includes("Change"));
        const isScroll = a.event && a.event.includes("Scroll");

        let icon = "🪄",
          content = "",
          css = "";
        if (isNav) {
          icon = "🌐";
          css = "nav";
          const methodTag = a.method
            ? ` <span style="color:#888;font-size:11px">via ${a.method}</span>`
            : "";
          content = `Navigated to <a href="${a.element}" target="_blank" style="color: #1a73e8; text-decoration: none;">${a.element || "Unknown URL"}</a>${methodTag}`;
        } else if (isClick) {
          icon = "🖱️";
          css = "clicked";
          const rawEl = a.element || "";
          const tagMatch = rawEl.match(/^<([a-z0-9]+)/i);
          const tagName = tagMatch ? tagMatch[1] : "element";
          const attrs = rawEl
            .replace(/^<[a-z0-9]+/i, "")
            .replace(/>$/, "")
            .trim();
          const cleanFull = (a.fullHtml || a.element || "")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          const xpathLine = a.xpath
            ? `<div style="font-size:10px;color:#888;margin-top:2px;font-family:monospace;">XPath: ${a.xpath}</div>`
            : "";

          // Detail panel dengan koordinat dan CSS selector
          const detailUid = "ap_" + Math.random().toString(36).substr(2, 6);
          const detailHtml = `<div class="action-detail-panel" id="dp_${detailUid}">
              ${a.cssSelector ? `<div class="action-detail-row"><span class="action-detail-label">Selector</span><span class="action-detail-value selector">${a.cssSelector}</span></div>` : ""}
              ${a.xpath ? `<div class="action-detail-row"><span class="action-detail-label">XPath</span><span class="action-detail-value xpath">${a.xpath}</span></div>` : ""}
              ${a.clientX != null ? `<div class="action-detail-row"><span class="action-detail-label">Viewport (x,y)</span><span class="action-detail-value coord">${a.clientX}, ${a.clientY}</span></div>` : ""}
              ${a.pageX != null ? `<div class="action-detail-row"><span class="action-detail-label">Page (x,y)</span><span class="action-detail-value coord">${a.pageX}, ${a.pageY}</span></div>` : ""}
              ${a.textContent ? `<div class="action-detail-row"><span class="action-detail-label">Text</span><span class="action-detail-value text">${a.textContent.replace(/</g, "&lt;")}</span></div>` : ""}
              <div class="action-detail-row" style="margin-top:6px;border-top:1px solid #eee;padding-top:6px;">
                <span class="action-detail-label">Full HTML</span>
                <pre style="margin:0;font-size:10px;color:#d93025;white-space:pre-wrap;overflow-x:auto;">${cleanFull}</pre>
              </div>
            </div>`;

          content = `Clicked <b>&lt;${tagName}</b> 
                      ${attrs ? `<span class="attr-text" style="color:#666; font-family:monospace;">${attrs.substring(0, 50)}${attrs.length > 50 ? "..." : ""}</span>` : ""}
                      <b>&gt;</b>
                      <button class="action-expand-btn" data-toggle="action" data-target="${detailUid}">▶ details</button>
                      ${xpathLine}
                      ${detailHtml}`;
        } else if (isInput) {
          icon = "⌨️";
          css = "typed";
          const val = a.value || "***";
          content = `Typed <b style="background:#f0f0f0;padding:2px 4px;border-radius:4px;font-family:monospace;font-weight:normal;border:1px solid #ddd;">${val}</b>`;
        } else if (isScroll) {
          icon = "📜";
          css = "";
          content = `<span style="color:#5f6368;">Scrolled</span> <b style="background:#f0f0f0;padding:2px 4px;border-radius:4px;font-family:monospace;font-weight:normal;border:1px solid #ddd;">${a.value || "?"}</b>`;
        } else {
          content = `<strong>${a.event}</strong><br><small>${a.element}</small>`;
        }

        return `<div class="u-entry ${css} log-jump-target" data-time="${sec}" data-time-ms="${a.relativeMs || sec * 1000}" style="cursor:pointer">
          <div class="u-time">${t} <span class="log-jump-btn" style="display:block;margin-top:4px;">⏯️</span></div>
          <div class="u-icon">${icon}</div>
          <div class="u-cont">${content}</div>
        </div>`;
      })
      .join("");
    document.getElementById("actionLogs").innerHTML =
      aHtml ||
      '<div class="u-entry" style="padding:20px; text-align:center; color:#999;">No actions recorded.</div>';

    // Click to seek in review
    // Click to seek in review (Legacy handler merged into global delegator below)
    /*
    document.querySelectorAll('#actionLogs .u-entry').forEach(el => {
      el.addEventListener('click', () => {
        const t = parseFloat(el.getAttribute('data-time'));
        videoPreview.currentTime = t;
      });
    });
    */

    // --- AUTO-STEPS GENERATOR (Copy Steps Button) ---
    function generateAutoSteps(actions) {
      return actions
        .map((a, i) => {
          const n = i + 1;
          const t = (a.time || "").replace(/[\[\]]/g, "").trim();
          const timeStr = t ? `[${t}]` : "";
          const isNav = a.event && a.event.includes("Navigated");
          const isClick = a.event && a.event.includes("Click");
          const isTyped = a.event && a.event.includes("Typed");
          const isScroll = a.event && a.event.includes("Scroll");

          if (isNav) return `${n}. ${timeStr} Navigated to ${a.element || "?"}`;
          if (isClick) {
            const tagMatch = (a.element || "").match(/^<([a-z0-9]+)/i);
            const tag = tagMatch ? tagMatch[1] : "element";
            const idMatch = (a.element || "").match(/id="([^"]+)"/);
            const id = idMatch ? `#${idMatch[1]}` : "";
            const textContent = (a.fullHtml || "")
              .replace(/<[^>]+>/g, "")
              .trim()
              .substring(0, 40);
            return `${n}. ${timeStr} Clicked <${tag}>${id}${textContent ? ` "${textContent}"` : ""}`;
          }
          if (isTyped) {
            const val =
              a.value === "***"
                ? "[password]"
                : (a.value || "").substring(0, 50);
            const tagMatch = (a.element || "").match(/id="([^"]+)"/);
            const id = tagMatch
              ? `#${tagMatch[1]}`
              : (a.element || "").match(/^<([a-z0-9]+)/i)?.[1] || "input";
            return `${n}. ${timeStr} Typed "${val}" in ${id}`;
          }
          if (isScroll) return `${n}. ${timeStr} Scrolled ${a.value || "?"}`;
          return `${n}. ${timeStr} ${a.event || "Action"}: ${a.element || ""}`;
        })
        .join("\n");
    }

    const btnCopySteps = document.getElementById("btnCopySteps");
    if (btnCopySteps) {
      btnCopySteps.addEventListener("click", () => {
        const steps = generateAutoSteps(sessionLogs.actions || []);
        if (!steps) {
          btnCopySteps.textContent = "No steps!";
          setTimeout(() => {
            btnCopySteps.innerHTML = "📋 Copy Steps";
          }, 2000);
          return;
        }
        navigator.clipboard.writeText(steps).then(() => {
          btnCopySteps.textContent = "Copied!";
          setTimeout(() => {
            btnCopySteps.innerHTML = "📋 Copy Steps";
          }, 2000);
        });
      });
    }

    // Update Backend Logs
    if (sessionLogs.backend && sessionLogs.backend.length > 0) {
      const sortedBackend = (sessionLogs.backend || [])
        .slice()
        .sort(
          (a, b) =>
            (a.relativeMs || parseSec(a.time) * 1000) -
            (b.relativeMs || parseSec(b.time) * 1000),
        );
      const backendLogHtml = sortedBackend
        .map(
          (s) => `
        <div class="log-entry error log-jump-target" data-time-ms="${s.relativeMs || parseSec(s.time) * 1000}" style="padding:12px; border-bottom:1px solid #eee; cursor:pointer;">
          <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
            <strong style="color:#d93025;"><span class="log-jump-btn">⏯️</span> ${s.type}</strong>
            <span style="color:#888; font-size:11px;">${s.time}</span>
          </div>
          <div style="font-weight:bold; margin-bottom:8px;">${s.message}</div>
          ${s.stack ? `<pre style="background:#fff5f5; padding:10px; border-radius:4px; font-size:11px; overflow-x:auto; border:1px solid #ffd2cf; color:#444;">${s.stack}</pre>` : ""}
          ${s.source ? `<div style="font-size:11px; color:#666; margin-top:4px;">Source: ${s.source}</div>` : ""}
        </div>
      `,
        )
        .join("");
      document.getElementById("backendLogs").innerHTML = backendLogHtml;
    } else {
      document.getElementById("backendLogs").innerHTML =
        '<div class="log-entry" style="padding:20px; text-align:center; color:#999;">No backend errors detected during this session.</div>';
    }

    // URL Timeline Logic
    function renderUrlTimeline() {
      let tl = [];
      if (sessionLogs.info && sessionLogs.info.urlTimeline) {
        tl = sessionLogs.info.urlTimeline;
      } else if (sessionLogs.info && sessionLogs.info.url) {
        tl = [{ time: 0, url: sessionLogs.info.url }];
      } else {
        tl = [{ time: 0, url: "-" }];
      }

      const visitedUrlsList = document.getElementById("visitedUrlsList");
      if (visitedUrlsList) {
        function formatT(sec) {
          const m = Math.floor(sec / 60);
          const s = Math.floor(sec % 60)
            .toString()
            .padStart(2, "0");
          return `${m}:${s}`;
        }

        const listHtml = tl
          .map((item, idx) => {
            // Fix: Ensure 0 is not treated as falsy
            const timeMs =
              item.timeMs !== undefined ? item.timeMs : item.time * 1000;
            const sec = timeMs / 1000;
            return `
            <div class="url-item ${idx === 0 ? "active" : ""}" data-time="${sec}" data-time-ms="${timeMs}">
              <div class="url-time">${formatT(sec)}</div>
              <a href="${item.url}" target="_blank" class="url-path" title="${item.url}">${item.url}</a>
            </div>
          `;
          })
          .join("");

        visitedUrlsList.innerHTML =
          listHtml || '<div class="log-entry">No URLs recorded</div>';

        const urlItems = visitedUrlsList.querySelectorAll(".url-item");
        urlItems.forEach((el) => {
          el.addEventListener("click", () => {
            const t = parseFloat(el.getAttribute("data-time-ms")) / 1000;
            videoPreview.currentTime = t;
          });
        });
      }
    }

    renderUrlTimeline();

    // Listen for storage changes (for when the background queue is still flushing)
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.sessionLogs) {
        sessionLogs = changes.sessionLogs.newValue;
        renderUrlTimeline();

        // Also refresh Actions list as Navigations are also Actions
        const actions = (sessionLogs.actions || [])
          .slice()
          .sort(
            (a, b) =>
              (a.relativeMs || parseSec(a.time) * 1000) -
              (b.relativeMs || parseSec(b.time) * 1000),
          );
        const aHtml = actions.map(renderActionEntry).join("");
        const actionLogsContainer = document.getElementById("actionLogs");
        if (actionLogsContainer) {
          actionLogsContainer.innerHTML =
            aHtml ||
            '<div class="u-entry" style="padding:20px; text-align:center; color:#999;">No actions recorded.</div>';
        }

        // Update counts
        const actionCount = document.getElementById("countACTIONS");
        if (actionCount) actionCount.textContent = actions.length;
      }
    });

    // Helper for rendering action entry (to avoid duplication)
    function renderActionEntry(a) {
      const match = (a.time || "").match(/\[(\d+:\d+)\]/);
      const t = match ? match[1] : "0:00";
      const sec = parseSec(a.time);
      const isNav = a.event && a.event.includes("Navigated");
      const isClick = a.event && a.event.includes("Click");
      const isInput =
        a.event &&
        (a.event.includes("Typed") ||
          a.event.includes("Input") ||
          a.event.includes("Change"));
      const isScroll = a.event && a.event.includes("Scroll");

      let icon = "🪄",
        content = "",
        css = "";
      if (isNav) {
        icon = "🌐";
        css = "nav";
        const methodTag = a.method
          ? ` <span style="color:#888;font-size:11px">via ${a.method}</span>`
          : "";
        content = `Navigated to <a href="${a.element}" target="_blank" style="color: #1a73e8; text-decoration: none;">${a.element || "Unknown URL"}</a>${methodTag}`;
      } else if (isClick) {
        icon = "🖱️";
        css = "clicked";
        const rawEl = a.element || "";
        const tagMatch = rawEl.match(/^<([a-z0-9]+)/i);
        const tagName = tagMatch ? tagMatch[1] : "element";
        const attrs = rawEl
          .replace(/^<[a-z0-9]+/i, "")
          .replace(/>$/, "")
          .trim();
        const cleanFull = (a.fullHtml || a.element || "")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        const xpathLine = a.xpath
          ? `<div style="font-size:10px;color:#888;margin-top:2px;font-family:monospace;">XPath: ${a.xpath}</div>`
          : "";

        const detailUid = "ap_" + Math.random().toString(36).substr(2, 6);
        const detailHtml = `<div class="action-detail-panel" id="dp_${detailUid}">
              ${a.cssSelector ? `<div class="action-detail-row"><span class="action-detail-label">Selector</span><span class="action-detail-value selector">${a.cssSelector}</span></div>` : ""}
              ${a.xpath ? `<div class="action-detail-row"><span class="action-detail-label">XPath</span><span class="action-detail-value xpath">${a.xpath}</span></div>` : ""}
              ${a.clientX != null ? `<div class="action-detail-row"><span class="action-detail-label">Viewport (x,y)</span><span class="action-detail-value coord">${a.clientX}, ${a.clientY}</span></div>` : ""}
              ${a.pageX != null ? `<div class="action-detail-row"><span class="action-detail-label">Page (x,y)</span><span class="action-detail-value coord">${a.pageX}, ${a.pageY}</span></div>` : ""}
              ${a.textContent ? `<div class="action-detail-row"><span class="action-detail-label">Text</span><span class="action-detail-value text">${a.textContent.replace(/</g, "&lt;")}</span></div>` : ""}
              <div class="action-detail-row" style="margin-top:6px;border-top:1px solid #eee;padding-top:6px;">
                <span class="action-detail-label">Full HTML</span>
                <pre style="margin:0;font-size:10px;color:#d93025;white-space:pre-wrap;overflow-x:auto;">${cleanFull}</pre>
              </div>
            </div>`;

        content = `Clicked <b>&lt;${tagName}</b> 
                      ${attrs ? `<span class="attr-text" style="color:#666; font-family:monospace;">${attrs.substring(0, 50)}${attrs.length > 50 ? "..." : ""}</span>` : ""}
                      <b>&gt;</b>
                      <button class="action-expand-btn" data-toggle="action" data-target="${detailUid}">▶ details</button>
                      ${xpathLine}
                      ${detailHtml}`;
      } else if (isInput) {
        icon = "⌨️";
        css = "typed";
        const val = a.value || "***";
        content = `Typed <b style="background:#f0f0f0;padding:2px 4px;border-radius:4px;font-family:monospace;font-weight:normal;border:1px solid #ddd;">${val}</b>`;
      } else if (isScroll) {
        icon = "📜";
        css = "";
        content = `<span style="color:#5f6368;">Scrolled</span> <b style="background:#f0f0f0;padding:2px 4px;border-radius:4px;font-family:monospace;font-weight:normal;border:1px solid #ddd;">${a.value || "?"}</b>`;
      } else {
        content = `<strong>${a.event}</strong><br><small>${a.element}</small>`;
      }

      return `<div class="u-entry ${css} log-jump-target" data-time="${sec}" data-time-ms="${a.relativeMs || sec * 1000}" style="cursor:pointer">
          <div class="u-time">${t} <span class="log-jump-btn" style="display:block;margin-top:4px;">⏯️</span></div>
          <div class="u-icon">${icon}</div>
          <div class="u-cont">${content}</div>
        </div>`;
    }

    // Populate Environment Info
    document.getElementById("infoBrowser").textContent =
      sessionLogs.info?.browser || getBrowserInfo();
    document.getElementById("infoOS").textContent =
      sessionLogs.info?.os || getOSInfo();
    document.getElementById("infoRes").textContent =
      sessionLogs.info?.resolution ||
      window.screen.width + "x" + window.screen.height;
    document.getElementById("infoLocation").textContent =
      sessionLogs.info?.location || "-";
    document.getElementById("infoTimestamp").textContent =
      sessionLogs.info?.timestamp || "Unknown";

    // Render environment snapshot if available
    const env = sessionLogs.info?.environment;
    if (env) {
      // Timezone, Language, Cookies
      const tzEl = document.getElementById("infoTimezone");
      if (tzEl) tzEl.textContent = env.timezone || "-";
      const langEl = document.getElementById("infoLanguage");
      if (langEl) langEl.textContent = env.language || "-";
      const cookieEl = document.getElementById("infoCookies");
      if (cookieEl)
        cookieEl.textContent =
          env.cookieCount != null
            ? `${env.cookieCount} cookies (${(env.cookieNames || []).slice(0, 5).join(", ")}${env.cookieCount > 5 ? "..." : ""})`
            : "-";

      // --- APP STATE REPORTING (Advanced UI) ---
      const envSection = document.getElementById("envSection");
      if (envSection) envSection.style.display = "block";

      let currentLS = env.localStorage || {};
      let currentSS = env.sessionStorage || {};
      let currentCK = []; // Will fetch from BG or logs

      // 1. Initial Render (Storage & Cookies)
      renderEnvTable("LS", currentLS);
      renderEnvTable("SS", currentSS);

      // Prioritas: Gunakan cookies dari snapshot log jika ada (lengkap),
      // jika tidak (atau jika ingin data terbaru), ambil dari background.
      if (env.cookies && env.cookies.length > 0) {
        currentCK = env.cookies;
        renderEnvTable("CK", currentCK);
      } else {
        const targetUrl =
          sessionLogs.info?.url !== "N/A" ? sessionLogs.info?.url : null;
        chrome.runtime.sendMessage(
          {
            action: "BUGLENS_GET_COOKIES",
            url: targetUrl,
          },
          (res) => {
            if (res && res.cookies) {
              currentCK = res.cookies;
              renderEnvTable("CK", currentCK);
            }
          },
        );
      }

      // 2. Toggles
      document.querySelectorAll("[data-toggle-env]").forEach((h) => {
        h.addEventListener("click", () => {
          const type = h.getAttribute("data-toggle-env").toUpperCase();
          const body = document.getElementById(`envBody${type}`);
          if (body)
            body.style.display =
              body.style.display === "none" ? "block" : "none";
        });
      });

      // 3. Search handling
      document.querySelectorAll(".env-search").forEach((input) => {
        input.addEventListener("input", (e) => {
          const type = input.getAttribute("data-filter-env").toUpperCase();
          const query = e.target.value.toLowerCase();
          const data =
            type === "LS" ? currentLS : type === "SS" ? currentSS : currentCK;
          renderEnvTable(type, data, query);
        });
      });

      // 4. Copy All handling
      document.querySelectorAll(".btn-copy-env").forEach((btn) => {
        btn.addEventListener("click", () => {
          const type = btn.getAttribute("data-copy-env").toUpperCase();
          const data =
            type === "LS" ? currentLS : type === "SS" ? currentSS : currentCK;
          navigator.clipboard.writeText(JSON.stringify(data, null, 2));
          btn.textContent = "Copied!";
          setTimeout(() => (btn.textContent = "Copy All"), 2000);
        });
      });

      // 5. JSON Parsing Helper
      function smartParse(str) {
        try {
          const obj = JSON.parse(str);
          if (obj && typeof obj === "object")
            return { isJson: true, val: JSON.stringify(obj, null, 2) };
        } catch (e) {}
        return { isJson: false, val: str };
      }

      function renderEnvTable(type, data, filter = "") {
        const tbody = document.querySelector(`#table${type} tbody`);
        if (!tbody) return;
        tbody.innerHTML = "";

        let count = 0;
        if (type === "CK") {
          const filtered = data.filter(
            (c) =>
              c.name.toLowerCase().includes(filter) ||
              (c.value || "").toLowerCase().includes(filter) ||
              (c.domain || "").toLowerCase().includes(filter),
          );
          count = filtered.length;
          tbody.innerHTML = filtered
            .map(
              (c) => `
            <tr>
              <td><strong>${c.name}</strong></td>
              <td class="val-raw">${c.value}</td>
              <td>${c.domain}</td>
              <td style="text-align:center">${c.httpOnly ? '<span class="lock-icon" title="HttpOnly">🔒</span>' : ""}</td>
              <td><button class="btn-copy-row" data-copy-val='${JSON.stringify(c).replace(/'/g, "&apos;")}'>Copy</button></td>
            </tr>
          `,
            )
            .join("");
        } else {
          const keys = Object.keys(data).filter(
            (k) =>
              k.toLowerCase().includes(filter) ||
              (data[k] || "").toLowerCase().includes(filter),
          );
          count = keys.length;
          tbody.innerHTML = keys
            .map((k) => {
              const { isJson, val } = smartParse(data[k]);
              return `
              <tr>
                <td><strong>${k}</strong></td>
                <td class="${isJson ? "val-pretty" : "val-raw"}">${val}</td>
                <td><button class="btn-copy-row" data-copy-val='${JSON.stringify({ key: k, value: data[k] }).replace(/'/g, "&apos;")}'>Copy</button></td>
              </tr>
            `;
            })
            .join("");
        }
        document.getElementById(`count${type}`).textContent = count;

        // Attach row copy listeners
        tbody.querySelectorAll(".btn-copy-row").forEach((btn) => {
          btn.onclick = (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(btn.getAttribute("data-copy-val"));
            const og = btn.textContent;
            btn.textContent = "Copied";
            setTimeout(() => (btn.textContent = og), 2000);
          };
        });
      }

      // 6. Real-time Cookie Update Listener
      chrome.runtime.onMessage.addListener((req) => {
        if (req.action === "BUGLENS_COOKIE_CHANGED") {
          // Re-fetch all to be accurate
          chrome.runtime.sendMessage(
            { action: "BUGLENS_GET_COOKIES" },
            (res) => {
              if (res && res.cookies) {
                currentCK = res.cookies;
                const filter = document.querySelector(
                  '[data-filter-env="ck"]',
                ).value;
                renderEnvTable("CK", currentCK, filter.toLowerCase());
              }
            },
          );
        }
      });
    }

    // --- GLOBAL EVENT DELEGATION (Fix CSP onclick issue) ---
    document.addEventListener("click", (e) => {
      // 1. Log Jump to Video (Priority)
      const jumpTrigger = e.target.closest(".log-jump-target");
      if (jumpTrigger) {
        // Check if we should skip jump (e.g. clicking strict detail buttons like in Actions)
        const isActionDetailBtn =
          e.target.classList.contains("action-expand-btn");
        const isJsonToggle = e.target.closest('[data-toggle="json"]');

        if (!isActionDetailBtn && !isJsonToggle) {
          const timeMs = parseInt(jumpTrigger.getAttribute("data-time-ms"));
          if (!isNaN(timeMs)) {
            jumpToVideoTime(timeMs, jumpTrigger);
          }
        }
      }

      // 2. JSON Tree Toggle
      const jtToggle = e.target.closest('[data-toggle="json"]');
      if (jtToggle) {
        // stopPropagation removed to allow bubbling/other logic if needed,
        // but since it's document listener, we just handle logic
        const targetId = jtToggle.getAttribute("data-target");
        const content = document.getElementById(targetId);
        const caret = jtToggle.querySelector(".jt-caret");
        if (content) content.classList.toggle("open");
        if (caret) caret.classList.toggle("open");
        return;
      }

      // 3. Console Entry Toggle
      const consoleToggle = e.target.closest('[data-toggle="console"]');
      if (consoleToggle) {
        const targetId = consoleToggle.getAttribute("data-target");
        const body = document.getElementById("body_" + targetId);
        const chev = document.getElementById("chev_" + targetId);
        if (body) body.classList.toggle("open");
        if (chev) chev.classList.toggle("open");
        return;
      }

      // 4. Action Detail Toggle
      const actionToggle = e.target.closest('[data-toggle="action"]');
      if (actionToggle) {
        const targetId = actionToggle.getAttribute("data-target");
        const detailPanel = document.getElementById("dp_" + targetId);
        if (detailPanel) {
          detailPanel.classList.toggle("open");
          actionToggle.textContent = detailPanel.classList.contains("open")
            ? "▼ collapse"
            : "▶ details";
        }
        return;
      }
    });

    // INITIAL RENDER
    rebuildUnified();
    renderUnified();
    renderNetwork();
    renderUrlTimeline();
  } // End initReviewUI

  // Timeline tracker (attached to video preview)
  videoPreview.addEventListener("timeupdate", () => {
    const currentSec = videoPreview.currentTime;

    // Calculate active URL
    const items = document.querySelectorAll(".url-item");
    let activeIdx = 0;
    items.forEach((item, idx) => {
      const t = parseFloat(item.getAttribute("data-time") || 0);
      if (t <= currentSec) activeIdx = idx;
    });

    items.forEach((item, idx) => {
      if (idx === activeIdx) {
        item.classList.add("active");
      } else {
        item.classList.remove("active");
      }
    });

    // Sync Console and Actions timelines
    ["consoleLogs", "actionLogs"].forEach((containerId) => {
      const container = document.getElementById(containerId);
      if (!container) return;
      const entries = container.querySelectorAll(".u-entry");
      let activeEl = null;

      entries.forEach((el) => {
        const t = parseFloat(el.getAttribute("data-time") || 0);
        if (t <= currentSec) {
          activeEl = el;
        }
        el.classList.remove("active-timeline");
      });

      if (activeEl) {
        activeEl.classList.add("active-timeline");
      }
    });
  });

  btnSave.addEventListener("click", async () => {
    const title = inputTitle.value.trim();
    const desc = inputDesc.value.trim();

    if (!title) {
      inputTitle.style.borderColor = "red";
      return;
    }

    inputTitle.style.borderColor = "#ccc";
    btnSave.disabled = true;
    loading.classList.remove("hidden");
    errorMsg.classList.add("hidden");

    if (isExistingReport) {
      // --- UPDATE EXISTING REPORT ---
      try {
        const videoId = urlParams.get("v");

        // 1. Fetch current JSON content
        const res = await fetch(
          `https://graph.microsoft.com/v1.0/me/drive/items/${existingJsonId}/content`,
          {
            headers: { Authorization: `Bearer ${authToken}` },
          },
        );
        if (!res.ok) {
          throw new Error("Failed to fetch JSON content: " + res.status);
        }
        const fullData = await res.json();

        // Also fetch name specifically (media download doesn't give metadata)
        const metaRes = await fetch(
          `https://graph.microsoft.com/v1.0/me/drive/items/${existingJsonId}`,
          {
            headers: { Authorization: `Bearer ${authToken}` },
          },
        );
        if (!metaRes.ok) {
          throw new Error("Failed to fetch JSON metadata: " + metaRes.status);
        }
        const meta = await metaRes.json();
        const currentName = meta.name || ""; // e.g. BERIBUG_OldTitle_2026-04-23T12-00-00-000Z.json

        // Extract timestamp from old name
        const parts = currentName.split("_");
        const timeStampPart =
          parts.length >= 3
            ? parts[parts.length - 1].split(".")[0]
            : new Date().toISOString().replace(/[:.]/g, "-");

        // Prepare new sanitized names
        const sanitizedTitle = title.replace(/[^a-zA-Z0-9]/g, "_");
        const newJsonName = `BERIBUG_${sanitizedTitle}_${timeStampPart}.json`;
        const newVideoName = `BERIBUG_${sanitizedTitle}_${timeStampPart}.webm`;

        // 2. Update JSON content
        fullData.title = title;
        fullData.description = desc;
        if (fullData.metadata)
          fullData.metadata.lastUpdated = new Date().toISOString();

        const blob = new Blob([JSON.stringify(fullData, null, 2)], {
          type: "application/json",
        });
        const putContentRes = await fetch(
          `https://graph.microsoft.com/v1.0/me/drive/items/${existingJsonId}/content`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${authToken}`,
              "Content-Type": "application/json"
            },
            body: blob,
          },
        );
        if (!putContentRes.ok) {
          throw new Error(`Failed to update JSON content: ${putContentRes.status} ${await putContentRes.text()}`);
        }

        // 3. Update File Names (Metadata PATCH)
        // JSON Name
        const renameJsonRes = await fetch(
          `https://graph.microsoft.com/v1.0/me/drive/items/${existingJsonId}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${authToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ name: newJsonName }),
          },
        );
        if (!renameJsonRes.ok) {
          throw new Error(`Failed to rename JSON file: ${renameJsonRes.status}`);
        }

        // Video Name
        if (videoId) {
          const renameVideoRes = await fetch(
            `https://graph.microsoft.com/v1.0/me/drive/items/${videoId}`,
            {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${authToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ name: newVideoName }),
            },
          );
          if (!renameVideoRes.ok) {
            throw new Error(`Failed to rename video file: ${renameVideoRes.status}`);
          }
        }

        // Generate sharing links & direct download URLs
        let newVUrl = "";
        if (videoId) {
          newVUrl = await makeFilePublicAndGetDirectUrl(authToken, videoId);
        }
        const newLUrl = await makeFilePublicAndGetDirectUrl(authToken, existingJsonId);

        loading.classList.add("hidden");
        btnSave.disabled = false;

        // Show success
        stepForm.classList.add("hidden");
        stepSuccess.classList.remove("hidden");
        document.querySelector("#stepSuccess h2").textContent =
          "Successfully Updated!";

        // Use the Netlify player URL with direct URLs for the share link
        shareLink.value = `https://dynamic-rabanadas-2b5f0b.netlify.app/?vUrl=${encodeURIComponent(newVUrl)}&lUrl=${encodeURIComponent(newLUrl)}`;
      } catch (err) {
        showError("Failed to update: " + err);
        btnSave.disabled = false;
      }
    } else {
      // --- NORMAL COMMIT UPLOAD ---
      chrome.runtime.sendMessage(
        {
          action: "COMMIT_UPLOAD",
          title: title,
          description: desc,
          info: {
            browser: document.getElementById("infoBrowser").textContent,
            os: document.getElementById("infoOS").textContent,
            resolution: document.getElementById("infoRes").textContent,
            location: document.getElementById("infoLocation").textContent,
            timestamp: document.getElementById("infoTimestamp").textContent,
            url: "-",
          },
        },
        (res) => {
          btnSave.disabled = false;
          loading.classList.add("hidden");

          if (res && res.success) {
            stepForm.classList.add("hidden");
            stepSuccess.classList.remove("hidden");
            shareLink.value = res.url;
            // Clean up temporary data after successful upload
            chrome.storage.local.remove(["pendingReport", "sessionLogs"]);
            sessionStorage.removeItem("editLogs");
          } else {
            errorMsg.textContent =
              "Upload failed: " + (res.error || "Unknown error");
            errorMsg.classList.remove("hidden");
          }
        },
      );
    }
  });

  // Auto-save Title & Description as user types
  const autoSave = () => {
    chrome.storage.local.set({
      pendingReport: {
        title: inputTitle.value,
        description: inputDesc.value,
      },
    });
  };
  inputTitle.addEventListener("input", autoSave);
  inputDesc.addEventListener("input", autoSave);

  btnCopy.addEventListener("click", () => {
    shareLink.select();
    document.execCommand("copy");
    const ogText = btnCopy.textContent;
    btnCopy.textContent = "Copied!";
    setTimeout(() => {
      btnCopy.textContent = ogText;
    }, 2000);
  });
});


async function makeFilePublicAndGetDirectUrl(token, fileId) {
  const url = `https://graph.microsoft.com/v1.0/me/drive/items/${fileId}/createLink`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      type: "view",
      scope: "anonymous"
    })
  });

  if (!res.ok) {
    throw new Error(`Failed to create sharing link: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const sharingLink = data.link.webUrl;

  // Convert to direct URL
  const base64Value = btoa(sharingLink);
  const safeBase64Value = base64Value
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `https://api.onedrive.com/v1.0/shares/u!${safeBase64Value}/root/content`;
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

function getBrowserInfo() {
  const ua = navigator.userAgent;
  let tem,
    M =
      ua.match(
        /(opera|chrome|safari|firefox|msie|trident(?=\/))\/?\s*(\d+)/i,
      ) || [];
  if (/trident/i.test(M[1])) {
    tem = /\brv[ :]+(\d+)/g.exec(ua) || [];
    return "IE " + (tem[1] || "");
  }
  if (M[1] === "Chrome") {
    tem = ua.match(/\b(OPR|Edge)\/(\d+)/);
    if (tem != null) return tem.slice(1).join(" ").replace("OPR", "Opera");
  }
  M = M[2] ? [M[1], M[2]] : [navigator.appName, navigator.appVersion, "-?"];
  if ((tem = ua.match(/version\/(\d+)/i)) != null) M.splice(1, 1, tem[1]);
  return M.join(" ");
}

function getOSInfo() {
  if (navigator.userAgent.indexOf("Win") != -1) return "Windows";
  if (navigator.userAgent.indexOf("Mac") != -1) return "MacOS";
  if (navigator.userAgent.indexOf("Linux") != -1) return "Linux";
  if (navigator.userAgent.indexOf("X11") != -1) return "UNIX";
  return "Unknown OS";
}
