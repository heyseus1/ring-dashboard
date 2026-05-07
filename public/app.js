async function getJson(url) {
  const response = await fetch(url);

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

function renderHealth(health) {
  const element = document.getElementById("health");

  element.innerHTML = `
    <div class="status-line">
      <span class="badge good">Online</span>
      <span>${escapeHtml(health.app)}</span>
    </div>

    <p><strong>Cameras:</strong> ${escapeHtml(health.cameras)}</p>
    <p><strong>Locations:</strong> ${escapeHtml(health.locations)}</p>
    <p><strong>Updated:</strong> ${escapeHtml(formatDate(health.timestamp))}</p>
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
                  `Battery ${battery.slot}: ${formatPercent(
                    battery.percentage
                  )}`,
                  battery.category ? battery.category : null,
                  battery.voltage ? `${battery.voltage} mV` : null,
                ]
                  .filter(Boolean)
                  .join(" · ");

                return `<div class="battery-line${active}">${escapeHtml(
                  details
                )}</div>`;
              })
              .join("")
          : "Unknown";

      const connectionBadge =
        cameraStatus.connectionStatus === "Online"
          ? `<span class="badge good">Online</span>`
          : cameraStatus.connectionStatus === "Offline"
            ? `<span class="badge bad">Offline</span>`
            : `<span class="badge">${escapeHtml(
                cameraStatus.connectionStatus
              )}</span>`;

      const wifi =
        cameraStatus.wifiSignal !== null
          ? `${escapeHtml(cameraStatus.wifiSignal)} dBm (${escapeHtml(
              cameraStatus.wifiQuality
            )})`
          : "Unknown";

      const firmware = `${escapeHtml(
        cameraStatus.firmwareVersion
      )} <span class="muted">(${escapeHtml(
        cameraStatus.firmwareStatus
      )})</span>`;

      const packetLoss =
        cameraStatus.packetLoss !== null
          ? `${escapeHtml(cameraStatus.packetLoss)}% (${escapeHtml(
              cameraStatus.packetLossQuality
            )})`
          : "Unknown";

      const bandwidth =
        cameraStatus.currentBandwidthMbps !== null
          ? `${escapeHtml(cameraStatus.currentBandwidthMbps)} Mbps (${escapeHtml(
              cameraStatus.bandwidthQuality
            )})`
          : "Unknown";

      return `
        <div class="camera">
          <div class="camera-heading">
            <div>
              <h3>${escapeHtml(camera.name)}</h3>
              <p>${escapeHtml(camera.model || "Unknown model")}</p>
            </div>
            <span class="badge">${escapeHtml(
              camera.deviceType || "Unknown type"
            )}</span>
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

          ${renderMetricRow("Connection", connectionBadge)}
          ${renderMetricRow("Battery", batteries)}
          ${renderMetricRow("Power", escapeHtml(cameraStatus.powerStatus))}
          ${renderMetricRow("Wi-Fi Signal", wifi)}
          ${renderMetricRow(
            "Wi-Fi Risk",
            escapeHtml(cameraStatus.wifiRiskLevel || "Unknown")
          )}
          ${renderMetricRow("Network", escapeHtml(cameraStatus.networkName))}
          ${renderMetricRow(
            "Network Type",
            escapeHtml(cameraStatus.networkConnection)
          )}
          ${renderMetricRow("Packet Loss", packetLoss)}
          ${renderMetricRow("Bandwidth", bandwidth)}
          ${renderMetricRow("Light", escapeHtml(cameraStatus.lightStatus))}
          ${renderMetricRow("Siren", escapeHtml(cameraStatus.sirenStatus))}
          ${renderMetricRow("Firmware", firmware)}
          ${renderMetricRow(
            "Motion Alerts",
            escapeHtml(cameraStatus.motionAlerts)
          )}
          ${renderMetricRow(
            "Motion Detection",
            escapeHtml(cameraStatus.motionDetection)
          )}
          ${renderMetricRow("Recording", escapeHtml(cameraStatus.recordingStatus))}
          ${renderMetricRow(
            "Last Health Update",
            escapeHtml(formatDate(cameraStatus.lastHealthUpdate))
          )}
        </div>
      `;
    })
    .join("");
}

function renderActivity(activityResponse) {
  const element = document.getElementById("activity-history");
  const activity = activityResponse.activity;

  if (!activity.length) {
    element.innerHTML = `
      <p>No activity captured yet. Trigger motion on the camera while this app is running, or click <strong>Add Synthetic Test</strong>.</p>
    `;
    return;
  }

  element.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Camera</th>
          <th>Event</th>
          <th>Source</th>
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
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function showSnapshot(cameraId, cameraName) {
  const snapshotCard = document.getElementById("snapshot-card");
  const snapshotSubtitle = document.getElementById("snapshot-subtitle");
  const snapshotStatus = document.getElementById("snapshot-status");
  const snapshotImage = document.getElementById("snapshot-image");

  snapshotCard.classList.remove("hidden");
  snapshotSubtitle.textContent = `${cameraName} snapshot`;
  snapshotStatus.innerHTML = `<span class="badge">Loading snapshot...</span>`;

  snapshotImage.removeAttribute("src");
  snapshotImage.classList.add("hidden");

  const snapshotUrl = `/api/cameras/${encodeURIComponent(
    cameraId
  )}/snapshot?ts=${Date.now()}`;

  snapshotImage.onload = () => {
    snapshotStatus.innerHTML = `<span class="badge good">Snapshot loaded</span>`;
    snapshotImage.classList.remove("hidden");
  };

  snapshotImage.onerror = () => {
    snapshotStatus.innerHTML = `
      <span class="badge bad">Snapshot failed</span>
      <p class="muted">The camera may not have a fresh snapshot available yet.</p>
    `;
    snapshotImage.classList.add("hidden");
  };

  snapshotImage.src = snapshotUrl;
  snapshotCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

function hideSnapshot() {
  const snapshotCard = document.getElementById("snapshot-card");
  const snapshotImage = document.getElementById("snapshot-image");
  const snapshotStatus = document.getElementById("snapshot-status");

  snapshotImage.removeAttribute("src");
  snapshotStatus.innerHTML = "";
  snapshotCard.classList.add("hidden");
}

async function loadDashboard() {
  try {
    const [health, status, activity] = await Promise.all([
      getJson("/api/health"),
      getJson("/api/status"),
      getJson("/api/activity"),
    ]);

    renderHealth(health);
    renderCameraStatus(status);
    renderActivity(activity);
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
  const button = event.target.closest(".snapshot-button");

  if (!button) {
    return;
  }

  const cameraId = button.dataset.cameraId;
  const cameraName = button.dataset.cameraName || "Camera";

  showSnapshot(cameraId, cameraName);
});

loadDashboard();
setInterval(loadDashboard, 5000);