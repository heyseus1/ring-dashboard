let currentActivityFilter = "all";
let lastDashboardData = {
  health: null,
  status: null,
  activity: null,
  snapshots: null,
};

function redirectToLogin() {
  window.location.replace("/login");
}

async function getJson(url) {
  const response = await fetch(url);

  if (response.status === 401) {
    redirectToLogin();
    throw new Error("Session expired");
  }

  if (!response.ok) {
    throw new Error(`Request failed: ${url}`);
  }

  return response.json();
}

async function postJson(url, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (response.status === 401) {
    redirectToLogin();
    throw new Error("Session expired");
  }

  if (!response.ok) {
    throw new Error(`Request failed: ${url}`);
  }

  return response.json();
}

function escapeHtml(value) {
  return String(value ?? "Unknown")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) {
    return "Unknown";
  }

  return new Date(value).toLocaleString();
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) {
    return "Unknown";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatPercent(value) {
  if (value === null || value === undefined) {
    return "Unknown";
  }

  return `${value}%`;
}

function sourceLabel(source) {
  switch (source) {
    case "ring_notification":
      return "Ring Notification";
    case "ring_history":
      return "Ring History";
    case "synthetic_test":
      return "Synthetic Test";
    case "legacy_local":
      return "Legacy Local";
    default:
      return "Unknown";
  }
}

function sourceBadgeClass(source) {
  switch (source) {
    case "ring_notification":
    case "ring_history":
      return "good";
    case "synthetic_test":
      return "warning";
    default:
      return "";
  }
}

function warningBadgeClass(severity) {
  switch (severity) {
    case "critical":
      return "bad";
    case "warning":
      return "warning";
    default:
      return "";
  }
}

function renderSummaryCards(health, status, snapshots) {
  const element = document.getElementById("summary-cards");
  const warningCount = status.warnings?.length || 0;
  const latestCamera = status.cameras?.[0];
  const latestStatus = latestCamera?.status;

  element.innerHTML = `
    <article class="summary-card">
      <span class="summary-label">Cameras</span>
      <strong>${escapeHtml(health.cameras)}</strong>
      <small>${escapeHtml(health.locations)} location(s)</small>
    </article>

    <article class="summary-card">
      <span class="summary-label">Chimes</span>
      <strong>${escapeHtml(health.chimes ?? status.totalChimes ?? 0)}</strong>
      <small>Ring chime devices</small>
    </article>

    <article class="summary-card">
      <span class="summary-label">Connection</span>
      <strong>${escapeHtml(latestStatus?.connectionStatus || "Unknown")}</strong>
      <small>${escapeHtml(latestCamera?.name || "No camera")}</small>
    </article>

    <article class="summary-card">
      <span class="summary-label">Snapshots</span>
      <strong>${escapeHtml(snapshots.count)}</strong>
      <small>${escapeHtml(health.snapshotRetentionDays)} day retention</small>
    </article>

    <article class="summary-card">
      <span class="summary-label">Warnings</span>
      <strong>${escapeHtml(warningCount)}</strong>
      <small>${warningCount ? "Review warnings" : "Looks good"}</small>
    </article>
  `;
}

function renderHealth(health, status, snapshots) {
  const element = document.getElementById("health");

  element.innerHTML = `
    <div class="status-line">
      <span class="badge good">Online</span>
      <span>${escapeHtml(health.app)}</span>
    </div>

    <p><strong>Cameras:</strong> ${escapeHtml(health.cameras)}</p>
    <p><strong>Chimes:</strong> ${escapeHtml(health.chimes ?? status.totalChimes ?? 0)}</p>
    <p><strong>Locations:</strong> ${escapeHtml(health.locations)}</p>
    <p><strong>Activity Events:</strong> ${escapeHtml(status.totalActivityEvents)}</p>
    <p><strong>Snapshots:</strong> ${escapeHtml(snapshots.count)}</p>
    <p><strong>Retention:</strong> ${escapeHtml(health.snapshotRetentionDays)} days / ${escapeHtml(health.maxSnapshots)} max</p>
    <p><strong>Updated:</strong> ${escapeHtml(formatDate(health.timestamp))}</p>
  `;
}

function renderWarnings(status) {
  const element = document.getElementById("warnings");
  const warnings = status.warnings || [];

  if (!warnings.length) {
    element.innerHTML = `
      <div class="status-line">
        <span class="badge good">Healthy</span>
        <span>No dashboard warnings detected.</span>
      </div>
    `;
    return;
  }

  element.innerHTML = `
    <div class="warning-list">
      ${warnings
        .map(
          (warning) => `
            <div class="warning-item">
              <span class="badge ${warningBadgeClass(warning.severity)}">
                ${escapeHtml(warning.severity)}
              </span>
              <span>${escapeHtml(warning.message)}</span>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderRecentActivity(activityResponse) {
  const element = document.getElementById("recent-activity");
  const recent = activityResponse.activity.slice(0, 3);

  if (!recent.length) {
    element.innerHTML = `<p>No recent activity. Try <strong>Add Synthetic Test</strong>.</p>`;
    return;
  }

  element.innerHTML = `
    <div class="compact-list">
      ${recent
        .map(
          (event) => `
            <div class="compact-item">
              <div>
                <strong>${escapeHtml(event.eventType)}</strong>
                <small>${escapeHtml(event.cameraName)} · ${escapeHtml(formatDate(event.receivedAt))}</small>
              </div>
              <span class="badge ${sourceBadgeClass(event.source)}">
                ${escapeHtml(sourceLabel(event.source))}
              </span>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderLatestSnapshot(snapshotResponse) {
  const element = document.getElementById("latest-snapshot");
  const latest = snapshotResponse.snapshots?.[0];

  if (!latest) {
    element.innerHTML = `<p>No snapshots saved yet.</p>`;
    return;
  }

  element.innerHTML = `
    <div class="latest-snapshot-preview">
      <img src="${escapeHtml(latest.url)}?thumb=${Date.now()}" alt="${escapeHtml(latest.filename)}" />
      <div>
        <strong>${escapeHtml(latest.cameraName || "Unknown camera")}</strong>
        <small>${escapeHtml(formatDate(latest.createdAt))}</small>
        <button
          class="small-button gallery-snapshot-button"
          data-snapshot-url="${escapeHtml(latest.url)}"
          data-camera-name="${escapeHtml(latest.cameraName || "Camera")}"
          data-event-type="${escapeHtml(latest.eventType || "Snapshot")}"
        >
          Open
        </button>
      </div>
    </div>
  `;
}

function renderMetricRow(label, value) {
  return `
    <div class="metric-row">
      <span>${escapeHtml(label)}</span>
      <strong>${value}</strong>
    </div>
  `;
}

function renderCameraStatus(status) {
  const element = document.getElementById("camera-status");

  if (!status.cameras.length) {
    element.innerHTML = `<p>No cameras found.</p>`;
    return;
  }

  element.innerHTML = status.cameras
    .map((camera) => {
      const cameraStatus = camera.status;

      const batteries =
        cameraStatus.batteries && cameraStatus.batteries.length
          ? cameraStatus.batteries
              .map((battery) => {
                const active =
                  cameraStatus.activeBattery === battery.slot ? " active" : "";

                const details = [
                  `Battery ${battery.slot}: ${formatPercent(battery.percentage)}`,
                  battery.category ? battery.category : null,
                  battery.voltage ? `${battery.voltage} mV` : null,
                ]
                  .filter(Boolean)
                  .join(" · ");

                return `<div class="battery-line${active}">${escapeHtml(details)}</div>`;
              })
              .join("")
          : "Unknown";

      const connectionBadge =
        cameraStatus.connectionStatus === "Online"
          ? `<span class="badge good">Online</span>`
          : cameraStatus.connectionStatus === "Offline"
            ? `<span class="badge bad">Offline</span>`
            : `<span class="badge">${escapeHtml(cameraStatus.connectionStatus)}</span>`;

      const wifi =
        cameraStatus.wifiSignal !== null
          ? `${escapeHtml(cameraStatus.wifiSignal)} dBm (${escapeHtml(cameraStatus.wifiQuality)})`
          : "Unknown";

      const firmware = `${escapeHtml(cameraStatus.firmwareVersion)} <span class="muted">(${escapeHtml(cameraStatus.firmwareStatus)})</span>`;

      const packetLoss =
        cameraStatus.packetLoss !== null
          ? `${escapeHtml(cameraStatus.packetLoss)}% (${escapeHtml(cameraStatus.packetLossQuality)})`
          : "Unknown";

      const bandwidth =
        cameraStatus.currentBandwidthMbps !== null
          ? `${escapeHtml(cameraStatus.currentBandwidthMbps)} Mbps (${escapeHtml(cameraStatus.bandwidthQuality)})`
          : "Unknown";

      return `
        <div class="camera-card">
          <div class="camera-heading">
            <div>
              <h3>${escapeHtml(camera.name)}</h3>
              <p>${escapeHtml(camera.model || "Unknown model")}</p>
            </div>
            <span class="badge">${escapeHtml(camera.deviceType || "Unknown type")}</span>
          </div>

          <div class="camera-actions">
            <button
              class="small-button snapshot-button"
              data-camera-id="${escapeHtml(camera.id)}"
              data-camera-name="${escapeHtml(camera.name)}"
            >
              View Snapshot
            </button>
          </div>

          <div class="metric-grid">
            ${renderMetricRow("Connection", connectionBadge)}
            ${renderMetricRow("Battery", batteries)}
            ${renderMetricRow("Power", escapeHtml(cameraStatus.powerStatus))}
            ${renderMetricRow("Wi-Fi Signal", wifi)}
            ${renderMetricRow("Wi-Fi Risk", escapeHtml(cameraStatus.wifiRiskLevel || "Unknown"))}
            ${renderMetricRow("Network", escapeHtml(cameraStatus.networkName))}
            ${renderMetricRow("Network Type", escapeHtml(cameraStatus.networkConnection))}
            ${renderMetricRow("Packet Loss", packetLoss)}
            ${renderMetricRow("Bandwidth", bandwidth)}
            ${renderMetricRow("Light", escapeHtml(cameraStatus.lightStatus))}
            ${renderMetricRow("Siren", escapeHtml(cameraStatus.sirenStatus))}
            ${renderMetricRow("Firmware", firmware)}
            ${renderMetricRow("Motion Alerts", escapeHtml(cameraStatus.motionAlerts))}
            ${renderMetricRow("Motion Detection", escapeHtml(cameraStatus.motionDetection))}
            ${renderMetricRow("Recording", escapeHtml(cameraStatus.recordingStatus))}
            ${renderMetricRow("Last Health Update", escapeHtml(formatDate(cameraStatus.lastHealthUpdate)))}
          </div>
        </div>
      `;
    })
    .join("");
}

function renderChimeStatus(status) {
  const element = document.getElementById("chime-status");
  const chimes = status.chimes || [];

  if (!chimes.length) {
    element.innerHTML = `<p>No Ring chimes found.</p>`;
    return;
  }

  element.innerHTML = chimes
    .map((chime) => {
      const chimeStatus = chime.status;

      const connectionBadge =
        chimeStatus.connectionStatus === "Online"
          ? `<span class="badge good">Online</span>`
          : chimeStatus.connectionStatus === "Offline"
            ? `<span class="badge bad">Offline</span>`
            : `<span class="badge">${escapeHtml(chimeStatus.connectionStatus)}</span>`;

      const wifi =
        chimeStatus.wifiSignal !== null
          ? `${escapeHtml(chimeStatus.wifiSignal)} dBm (${escapeHtml(chimeStatus.wifiQuality)})`
          : "Unknown";

      const bandwidth =
        chimeStatus.currentBandwidthMbps !== null
          ? `${escapeHtml(chimeStatus.currentBandwidthMbps)} Mbps`
          : "Unknown";

      const firmware = `${escapeHtml(chimeStatus.firmwareVersion)} <span class="muted">(${escapeHtml(chimeStatus.firmwareStatus)})</span>`;

      return `
        <div class="camera-card">
          <div class="camera-heading">
            <div>
              <h3>${escapeHtml(chime.name)}</h3>
              <p>${escapeHtml(chime.model || "Unknown model")}</p>
            </div>
            <span class="badge">${escapeHtml(chime.deviceType || "Unknown type")}</span>
          </div>

          <div class="metric-grid">
            ${renderMetricRow("Connection", connectionBadge)}
            ${renderMetricRow("Volume", escapeHtml(chimeStatus.volume ?? "Unknown"))}
            ${renderMetricRow("Do Not Disturb", escapeHtml(chimeStatus.doNotDisturb))}
            ${renderMetricRow("Night Light", escapeHtml(chimeStatus.nightLight))}
            ${renderMetricRow("Status LED", escapeHtml(chimeStatus.statusLed))}
            ${renderMetricRow("Wi-Fi Signal", wifi)}
            ${renderMetricRow("Network", escapeHtml(chimeStatus.networkName))}
            ${renderMetricRow("Network Type", escapeHtml(chimeStatus.networkConnection))}
            ${renderMetricRow("Bandwidth", bandwidth)}
            ${renderMetricRow("Packet Loss", escapeHtml(chimeStatus.packetLossQuality))}
            ${renderMetricRow("Firmware", firmware)}
            ${renderMetricRow("Uptime", escapeHtml(chimeStatus.uptime))}
            ${renderMetricRow("Last Health Update", escapeHtml(formatDate(chimeStatus.lastHealthUpdate)))}
          </div>
        </div>
      `;
    })
    .join("");
}

function renderSnapshotCell(event) {
  if (event.snapshotUrl) {
    return `
      <button
        class="small-button activity-snapshot-button"
        data-snapshot-url="${escapeHtml(event.snapshotUrl)}"
        data-camera-name="${escapeHtml(event.cameraName)}"
        data-event-type="${escapeHtml(event.eventType)}"
      >
        View
      </button>
    `;
  }

  if (event.snapshot && event.snapshot.error) {
    return `
      <span class="badge warning" title="${escapeHtml(event.snapshot.error)}">
        No Snapshot
      </span>
    `;
  }

  return `<span class="muted">No snapshot</span>`;
}

function activityMatchesFilter(event) {
  switch (currentActivityFilter) {
    case "all":
      return true;
    case "ring_notification":
      return event.source === "ring_notification";
    case "synthetic_test":
      return event.source === "synthetic_test";
    case "has_snapshot":
      return Boolean(event.snapshotUrl);
    case "no_snapshot":
      return !event.snapshotUrl;
    default:
      return true;
  }
}

function renderActivity(activityResponse) {
  const element = document.getElementById("activity-history");
  const activity = activityResponse.activity.filter(activityMatchesFilter);

  if (!activity.length) {
    element.innerHTML = `<p>No activity matches this filter.</p>`;
    return;
  }

  element.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Camera</th>
            <th>Event</th>
            <th>Source</th>
            <th>Snapshot</th>
          </tr>
        </thead>
        <tbody>
          ${activity
            .map(
              (event) => `
                <tr>
                  <td>${escapeHtml(formatDate(event.receivedAt))}</td>
                  <td>${escapeHtml(event.cameraName)}</td>
                  <td><span class="badge">${escapeHtml(event.eventType)}</span></td>
                  <td>
                    <span class="badge ${sourceBadgeClass(event.source)}">
                      ${escapeHtml(sourceLabel(event.source))}
                    </span>
                  </td>
                  <td>${renderSnapshotCell(event)}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderSnapshotGallery(snapshotResponse) {
  const element = document.getElementById("snapshot-gallery");
  const snapshots = snapshotResponse.snapshots || [];

  if (!snapshots.length) {
    element.innerHTML = `<p>No saved snapshots yet.</p>`;
    return;
  }

  element.innerHTML = `
    <div class="gallery-grid">
      ${snapshots
        .map(
          (snapshot) => `
            <article class="gallery-item">
              <img
                src="${escapeHtml(snapshot.url)}?thumb=${Date.now()}"
                alt="${escapeHtml(snapshot.filename)}"
                loading="lazy"
              />
              <div class="gallery-meta">
                <strong>${escapeHtml(snapshot.cameraName || "Unknown camera")}</strong>
                <span>${escapeHtml(formatDate(snapshot.createdAt))}</span>
                <span>${escapeHtml(snapshot.eventType || "Snapshot")}</span>
                <span>${escapeHtml(formatBytes(snapshot.sizeBytes))}</span>
                <button
                  class="small-button gallery-snapshot-button"
                  data-snapshot-url="${escapeHtml(snapshot.url)}"
                  data-camera-name="${escapeHtml(snapshot.cameraName || "Camera")}"
                  data-event-type="${escapeHtml(snapshot.eventType || "Snapshot")}"
                >
                  Open
                </button>
              </div>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function loadSnapshot(title, subtitle, snapshotUrl) {
  const snapshotCard = document.getElementById("snapshot-card");
  const snapshotSubtitle = document.getElementById("snapshot-subtitle");
  const snapshotStatus = document.getElementById("snapshot-status");
  const snapshotImage = document.getElementById("snapshot-image");

  snapshotCard.classList.remove("hidden");
  snapshotSubtitle.textContent = subtitle;
  snapshotStatus.innerHTML = `<span class="badge">Loading snapshot...</span>`;

  snapshotImage.alt = title;
  snapshotImage.removeAttribute("src");
  snapshotImage.classList.add("hidden");

  const urlWithCacheBust = `${snapshotUrl}${snapshotUrl.includes("?") ? "&" : "?"}ts=${Date.now()}`;

  snapshotImage.onload = () => {
    snapshotStatus.innerHTML = `<span class="badge good">Snapshot loaded</span>`;
    snapshotImage.classList.remove("hidden");
  };

  snapshotImage.onerror = () => {
    snapshotStatus.innerHTML = `
      <span class="badge bad">Snapshot failed</span>
      <p class="muted">The snapshot could not be loaded.</p>
    `;
    snapshotImage.classList.add("hidden");
  };

  snapshotImage.src = urlWithCacheBust;
  snapshotCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

function showCameraSnapshot(cameraId, cameraName) {
  const snapshotUrl = `/api/cameras/${encodeURIComponent(cameraId)}/snapshot`;

  loadSnapshot(
    `${cameraName} snapshot`,
    `${cameraName} latest camera snapshot`,
    snapshotUrl
  );
}

function showActivitySnapshot(snapshotUrl, cameraName, eventType) {
  loadSnapshot(
    `${cameraName} activity snapshot`,
    `${cameraName} · ${eventType}`,
    snapshotUrl
  );
}

function hideSnapshot() {
  const snapshotCard = document.getElementById("snapshot-card");
  const snapshotImage = document.getElementById("snapshot-image");
  const snapshotStatus = document.getElementById("snapshot-status");

  snapshotImage.removeAttribute("src");
  snapshotStatus.innerHTML = "";
  snapshotCard.classList.add("hidden");
}

function switchTab(tabName) {
  document
    .querySelectorAll(".tab-button")
    .forEach((button) => button.classList.remove("active"));

  document
    .querySelectorAll(".tab-panel")
    .forEach((panel) => panel.classList.remove("active"));

  document
    .querySelector(`[data-tab="${tabName}"]`)
    ?.classList.add("active");

  document
    .getElementById(`tab-${tabName}`)
    ?.classList.add("active");
}

function applyDashboard({ health, status, activity, snapshots }) {
  lastDashboardData = { health, status, activity, snapshots };

  renderSummaryCards(health, status, snapshots);
  renderHealth(health, status, snapshots);
  renderWarnings(status);
  renderRecentActivity(activity);
  renderLatestSnapshot(snapshots);
  renderCameraStatus(status);
  renderChimeStatus(status);
  renderActivity(activity);
  renderSnapshotGallery(snapshots);
}

async function loadDashboard() {
  try {
    const [health, status, activity, snapshots] = await Promise.all([
      getJson("/api/health"),
      getJson("/api/status"),
      getJson("/api/activity"),
      getJson("/api/snapshots"),
    ]);

    applyDashboard({ health, status, activity, snapshots });
  } catch (error) {
    console.error(error);

    document.getElementById("health").innerHTML = `
      <span class="badge bad">Error</span>
      <p>${escapeHtml(error.message)}</p>
    `;
  }
}

async function addTestActivity() {
  try {
    await postJson("/api/activity/test");
    await loadDashboard();
    switchTab("activity");
  } catch (error) {
    console.error(error);
    alert(error.message);
  }
}

document
  .getElementById("refresh-button")
  .addEventListener("click", loadDashboard);

document
  .getElementById("test-activity-button")
  .addEventListener("click", addTestActivity);

document
  .getElementById("close-snapshot-button")
  .addEventListener("click", hideSnapshot);

document.addEventListener("click", (event) => {
  const tabButton = event.target.closest(".tab-button");

  if (tabButton) {
    switchTab(tabButton.dataset.tab);
    return;
  }

  const filterButton = event.target.closest(".filter-button");

  if (filterButton) {
    currentActivityFilter = filterButton.dataset.activityFilter || "all";

    document
      .querySelectorAll(".filter-button")
      .forEach((button) => button.classList.remove("active"));

    filterButton.classList.add("active");

    if (lastDashboardData.activity) {
      renderActivity(lastDashboardData.activity);
    }

    return;
  }

  const cameraButton = event.target.closest(".snapshot-button");

  if (cameraButton) {
    const cameraId = cameraButton.dataset.cameraId;
    const cameraName = cameraButton.dataset.cameraName || "Camera";

    showCameraSnapshot(cameraId, cameraName);
    return;
  }

  const activitySnapshotButton = event.target.closest(
    ".activity-snapshot-button"
  );

  if (activitySnapshotButton) {
    const snapshotUrl = activitySnapshotButton.dataset.snapshotUrl;
    const cameraName = activitySnapshotButton.dataset.cameraName || "Camera";
    const eventType = activitySnapshotButton.dataset.eventType || "Activity";

    showActivitySnapshot(snapshotUrl, cameraName, eventType);
    return;
  }

  const galleryButton = event.target.closest(".gallery-snapshot-button");

  if (galleryButton) {
    const snapshotUrl = galleryButton.dataset.snapshotUrl;
    const cameraName = galleryButton.dataset.cameraName || "Camera";
    const eventType = galleryButton.dataset.eventType || "Snapshot";

    showActivitySnapshot(snapshotUrl, cameraName, eventType);
  }
});

async function initAuthControls() {
  const userEl = document.getElementById("auth-user");
  const logoutButton = document.getElementById("logout-button");

  try {
    const status = await getJson("/api/auth/status");

    if (!status.enabled) {
      return;
    }

    if (!status.authenticated) {
      redirectToLogin();
      return;
    }

    if (status.username) {
      userEl.textContent = `Signed in as ${status.username}`;
      userEl.classList.remove("hidden");
    }

    logoutButton.classList.remove("hidden");
    logoutButton.addEventListener("click", async () => {
      try {
        await postJson("/api/logout");
      } catch (error) {
        console.error(error);
      } finally {
        redirectToLogin();
      }
    });
  } catch (error) {
    console.error(error);
  }
}

function connectLiveUpdates() {
  if (typeof EventSource === "undefined") {
    // Older browsers without SSE: fall back to the original polling.
    setInterval(loadDashboard, 5000);
    return;
  }

  const source = new EventSource("/api/events");

  source.addEventListener("dashboard", (event) => {
    try {
      applyDashboard(JSON.parse(event.data));
    } catch (error) {
      console.error("Failed to apply live update:", error);
    }
  });

  source.onerror = () => {
    // EventSource reconnects on its own for transient drops. If the session
    // has expired, the reconnect will be unauthorized — detect that and send
    // the user to the login page instead of retrying forever.
    fetch("/api/auth/status")
      .then((res) => res.json())
      .then((status) => {
        if (status.enabled && !status.authenticated) {
          source.close();
          redirectToLogin();
        }
      })
      .catch(() => {});
  };
}

initAuthControls();
loadDashboard();
connectLiveUpdates();