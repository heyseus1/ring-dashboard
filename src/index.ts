import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { RingApi } from "ring-client-api";
import { installAuth, loadAuthConfig } from "./auth.js";
import { createLiveUpdates } from "./sse.js";

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || ".";
const TOKEN_FILE = path.join(DATA_DIR, ".ring-refresh-token");
const ACTIVITY_FILE = path.join(DATA_DIR, ".ring-activity-history.json");
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");

const MAX_ACTIVITY_EVENTS = 100;
const SNAPSHOT_TIMEOUT_MS = 15_000;
const SNAPSHOT_RETENTION_DAYS = Number(process.env.SNAPSHOT_RETENTION_DAYS || 7);
const MAX_SNAPSHOTS = Number(process.env.MAX_SNAPSHOTS || 250);

// Live-update (SSE) cadence. The status tick covers Ring health data that
// arrives via background polling; the heartbeat keeps the connection open.
const SSE_TICK_MS = Number(process.env.SSE_TICK_SECONDS || 15) * 1000;
const SSE_HEARTBEAT_MS = 25_000;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(SNAPSHOT_DIR)) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");

type ActivitySource =
  | "ring_notification"
  | "ring_history"
  | "synthetic_test"
  | "legacy_local";

type ActivitySnapshot = {
  available: boolean;
  filename?: string;
  capturedAt?: string;
  error?: string;
};

type ActivityEvent = {
  id: string;
  cameraId: number | string;
  cameraName: string;
  eventType: string;
  source: ActivitySource;
  receivedAt: string;
  snapshot?: ActivitySnapshot;
};

type BatteryEntry = {
  slot: number;
  percentage: number | null;
  voltage: number | null;
  present: boolean | null;
  category: string | null;
};

type DashboardWarning = {
  severity: "info" | "warning" | "critical";
  cameraId: number | string;
  cameraName: string;
  message: string;
  metric: string;
};

type SnapshotGalleryItem = {
  filename: string;
  url: string;
  sizeBytes: number;
  createdAt: string;
  relatedActivityId: string | null;
  cameraName: string | null;
  eventType: string | null;
  source: ActivitySource | null;
};

function getRefreshToken(): string {
  if (fs.existsSync(TOKEN_FILE)) {
    const tokenFromFile = fs.readFileSync(TOKEN_FILE, "utf-8").trim();

    if (tokenFromFile) {
      return tokenFromFile;
    }
  }

  const tokenFromEnv = process.env.RING_REFRESH_TOKEN;

  if (!tokenFromEnv) {
    throw new Error("Missing RING_REFRESH_TOKEN in .env or .ring-refresh-token");
  }

  return tokenFromEnv;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);

    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return null;
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return null;
}

function humanizeCategory(value: unknown): string | null {
  if (typeof value !== "string" || !value) {
    return null;
  }

  return value
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function fromUnixSeconds(value: unknown): string | null {
  const seconds = toNumber(value);

  if (seconds === null) {
    return null;
  }

  return new Date(seconds * 1000).toISOString();
}

function loadActivityHistory(): ActivityEvent[] {
  if (!fs.existsSync(ACTIVITY_FILE)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(ACTIVITY_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ActivityEvent>[];

    return parsed.map((event, index) => ({
      id: String(event.id ?? `legacy-${Date.now()}-${index}`),
      cameraId: event.cameraId ?? "unknown",
      cameraName: event.cameraName ?? "Unknown camera",
      eventType: event.eventType ?? "Unknown activity",
      source: event.source ?? "legacy_local",
      receivedAt: event.receivedAt ?? new Date().toISOString(),
      snapshot: event.snapshot,
    }));
  } catch {
    return [];
  }
}

function saveActivityHistory(events: ActivityEvent[]) {
  fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(events, null, 2));
}

function addActivityEvent(
  currentEvents: ActivityEvent[],
  event: ActivityEvent
): ActivityEvent[] {
  const updatedEvents = [event, ...currentEvents].slice(0, MAX_ACTIVITY_EVENTS);
  saveActivityHistory(updatedEvents);
  return updatedEvents;
}

function getBatteryEntries(
  data: Record<string, unknown>,
  health: Record<string, unknown>
): BatteryEntry[] {
  const healthBatteries = health.batteries;

  if (Array.isArray(healthBatteries)) {
    return healthBatteries.map((battery, index) => {
      const batteryRecord = asRecord(battery) ?? {};

      return {
        slot: toNumber(batteryRecord.battery_number) ?? index + 1,
        percentage: toNumber(batteryRecord.battery_percentage),
        voltage: toNumber(batteryRecord.battery_voltage),
        present: toBoolean(batteryRecord.battery_present),
        category: humanizeCategory(batteryRecord.battery_percentage_category),
      };
    });
  }

  const batteryOne = toNumber(health.battery_percentage ?? data.battery_life);
  const batteryTwo = toNumber(
    health.second_battery_percentage ?? data.battery_life_2
  );

  const batteries: BatteryEntry[] = [];

  if (batteryOne !== null) {
    batteries.push({
      slot: 1,
      percentage: batteryOne,
      voltage: toNumber(health.battery_voltage ?? data.battery_voltage),
      present: toBoolean(health.battery_present),
      category: humanizeCategory(health.battery_percentage_category),
    });
  }

  if (batteryTwo !== null) {
    batteries.push({
      slot: 2,
      percentage: batteryTwo,
      voltage: toNumber(
        health.second_battery_voltage ?? data.battery_voltage_2
      ),
      present: true,
      category: humanizeCategory(health.second_battery_percentage_category),
    });
  }

  return batteries;
}

function classifyRssi(rssi: number | null): string {
  if (rssi === null) {
    return "Unknown";
  }

  if (rssi >= -60) {
    return "Great";
  }

  if (rssi >= -70) {
    return "Okay";
  }

  if (rssi >= -80) {
    return "Poor";
  }

  return "Very poor";
}

function getConnectionStatus(
  health: Record<string, unknown>,
  alerts: Record<string, unknown>
): string {
  const connected = toBoolean(health.connected);

  if (connected === true) {
    return "Online";
  }

  if (connected === false) {
    return "Offline";
  }

  if (typeof alerts.connection === "string") {
    return alerts.connection;
  }

  return "Unknown";
}

function getPowerStatus(
  data: Record<string, unknown>,
  health: Record<string, unknown>,
  settings: Record<string, unknown>
): string {
  const externalConnection = toBoolean(
    health.external_connection ?? data.external_connection
  );

  const acPower = toNumber(health.ac_power);
  const powerMode = settings.power_mode;

  if (externalConnection === true || (acPower !== null && acPower > 0)) {
    return "External power connected";
  }

  if (externalConnection === false || powerMode === "battery") {
    return "Battery powered";
  }

  if (typeof powerMode === "string") {
    return powerMode;
  }

  return "Unknown";
}

function getLightStatus(
  data: Record<string, unknown>,
  health: Record<string, unknown>
): string {
  const whiteLedOn = toBoolean(health.white_led_on);
  const floodlightOn = toBoolean(health.floodlight_on);

  if (whiteLedOn === true || floodlightOn === true) {
    return "On";
  }

  if (whiteLedOn === false || floodlightOn === false) {
    return "Off";
  }

  if (typeof data.led_status === "string") {
    return data.led_status;
  }

  return "Unknown";
}

function getSirenStatus(
  data: Record<string, unknown>,
  health: Record<string, unknown>
): string {
  const sirenOn = toBoolean(health.siren_on);

  if (sirenOn === true) {
    return "On";
  }

  if (sirenOn === false) {
    return "Off";
  }

  const sirenStatus = asRecord(data.siren_status);
  const secondsRemaining = toNumber(sirenStatus?.seconds_remaining);

  if (secondsRemaining !== null && secondsRemaining > 0) {
    return `On, ${secondsRemaining}s remaining`;
  }

  if (secondsRemaining === 0) {
    return "Off";
  }

  return "Unknown";
}

function getFirmwareStatus(
  data: Record<string, unknown>,
  health: Record<string, unknown>
) {
  return {
    version:
      typeof health.firmware_version === "string"
        ? health.firmware_version
        : "Unknown",
    status:
      typeof health.firmware_version_status === "string"
        ? health.firmware_version_status
        : typeof data.firmware_version === "string"
          ? data.firmware_version
          : "Unknown",
  };
}

function getRecordingStatus(features: Record<string, unknown>) {
  const videoRecording = asRecord(features.video_recording) ?? {};

  const enabled = toBoolean(videoRecording.recording_enabled);
  const mode =
    typeof videoRecording.recording_mode === "string"
      ? videoRecording.recording_mode
      : "Unknown";
  const state =
    typeof videoRecording.recording_state === "string"
      ? videoRecording.recording_state
      : "Unknown";

  if (enabled === true) {
    return `${state} / ${mode}`;
  }

  if (enabled === false) {
    return "Disabled";
  }

  return "Unknown";
}

function serializeCamera(camera: any) {
  const data = asRecord(camera.data) ?? {};
  const health = asRecord(data.health) ?? {};
  const settings = asRecord(data.settings) ?? {};
  const features = asRecord(data.features) ?? {};
  const alerts = asRecord(data.alerts) ?? {};

  const batteries = getBatteryEntries(data, health);
  const rssi = toNumber(health.rssi);
  const firmware = getFirmwareStatus(data, health);

  const motionAlerts = toBoolean(data.subscribed_motions);
  const motionDetectionEnabled = toBoolean(settings.motion_detection_enabled);

  return {
    id: camera.id,
    name: camera.name,
    model: camera.model ?? null,
    deviceType: camera.deviceType ?? null,
    isDoorbot: camera.isDoorbot ?? false,

    status: {
      connectionStatus: getConnectionStatus(health, alerts),
      powerStatus: getPowerStatus(data, health, settings),

      batteries,
      activeBattery: toNumber(health.active_battery),

      wifiSignal: rssi,
      wifiQuality:
        humanizeCategory(health.rssi_category) ?? classifyRssi(rssi),
      wifiRiskLevel: humanizeCategory(health.rssi_risk_level),
      networkName:
        typeof health.wifi_name === "string" ? health.wifi_name : "Unknown",
      networkConnection:
        typeof health.network_connection_value === "string"
          ? health.network_connection_value
          : "Unknown",

      packetLoss: toNumber(health.packet_loss),
      packetLossQuality:
        humanizeCategory(health.packet_loss_category) ?? "Unknown",

      currentBandwidthMbps: toNumber(health.current_bandwidth_mb),
      bandwidthQuality:
        humanizeCategory(health.current_bandwidth_category) ?? "Unknown",

      lightStatus: getLightStatus(data, health),
      sirenStatus: getSirenStatus(data, health),

      firmwareVersion: firmware.version,
      firmwareStatus: firmware.status,

      motionAlerts: motionAlerts === true ? "Enabled" : "Disabled",
      motionDetection:
        motionDetectionEnabled === true ? "Enabled" : "Disabled",

      recordingStatus: getRecordingStatus(features),

      lastHealthUpdate: fromUnixSeconds(health.last_update_time),
    },

    debug: {
      rawDataKeys: Object.keys(data).sort(),
      healthKeys: Object.keys(health).sort(),
    },
  };
}

function serializeChime(chime: any) {
  const data = asRecord(chime.data) ?? {};
  const health = asRecord(data.health) ?? {};
  const settings = asRecord(data.settings) ?? {};
  const alerts = asRecord(data.alerts) ?? {};
  const doNotDisturb = asRecord(data.do_not_disturb) ?? {};

  const rssi = toNumber(health.rssi);
  const dndSecondsLeft = toNumber(doNotDisturb.seconds_left);
  const nightLightState = data.night_light_state ?? health.night_light_state;
  const statusLedEnabled = toBoolean(settings.status_led_enable);

  return {
    id: chime.id ?? data.id,
    name: chime.name ?? data.description ?? "Unknown chime",
    model: chime.model ?? data.kind ?? "Unknown model",
    deviceType: chime.deviceType ?? data.kind ?? "Unknown type",

    status: {
      connectionStatus: getConnectionStatus(health, alerts),

      firmwareVersion:
        typeof health.firmware_version === "string"
          ? health.firmware_version
          : "Unknown",

      firmwareStatus:
        typeof health.firmware_version_status === "string"
          ? health.firmware_version_status
          : typeof data.firmware_version === "string"
            ? data.firmware_version
            : "Unknown",

      wifiSignal: rssi,
      wifiQuality:
        humanizeCategory(health.rssi_category) ?? classifyRssi(rssi),

      networkName:
        typeof health.wifi_name === "string" ? health.wifi_name : "Unknown",

      networkConnection:
        typeof health.network_connection_value === "string"
          ? health.network_connection_value
          : "Unknown",

      packetLossQuality:
        humanizeCategory(health.packet_loss_category) ?? "Unknown",

      currentBandwidthMbps: toNumber(health.current_bandwidth_mb),

      volume: toNumber(settings.volume),

      doNotDisturb:
        dndSecondsLeft !== null && dndSecondsLeft > 0
          ? `On, ${dndSecondsLeft}s remaining`
          : "Off",

      nightLight:
        typeof nightLightState === "string"
          ? humanizeCategory(nightLightState) ?? nightLightState
          : toBoolean(nightLightState) === true
            ? "On"
            : "Off",

      statusLed:
        statusLedEnabled === true
          ? "Enabled"
          : statusLedEnabled === false
            ? "Disabled"
            : "Unknown",

      uptime: formatUptime(health.uptime_sec),
      lastHealthUpdate: fromUnixSeconds(health.last_update_time),
    },

    debug: {
      rawDataKeys: Object.keys(data).sort(),
      healthKeys: Object.keys(health).sort(),
      settingsKeys: Object.keys(settings).sort(),
    },
  };
}

function generateWarnings(serializedCameras: ReturnType<typeof serializeCamera>[]) {
  const warnings: DashboardWarning[] = [];

  for (const camera of serializedCameras) {
    const status = camera.status;

    if (status.connectionStatus !== "Online") {
      warnings.push({
        severity: "critical",
        cameraId: camera.id,
        cameraName: camera.name,
        metric: "connection",
        message: `${camera.name} is not reporting online status.`,
      });
    }

    for (const battery of status.batteries) {
      if (battery.percentage !== null && battery.percentage <= 20) {
        warnings.push({
          severity: "critical",
          cameraId: camera.id,
          cameraName: camera.name,
          metric: "battery",
          message: `${camera.name} Battery ${battery.slot} is low at ${battery.percentage}%.`,
        });
      } else if (battery.percentage !== null && battery.percentage <= 35) {
        warnings.push({
          severity: "warning",
          cameraId: camera.id,
          cameraName: camera.name,
          metric: "battery",
          message: `${camera.name} Battery ${battery.slot} is getting low at ${battery.percentage}%.`,
        });
      }
    }

    if (
      status.wifiQuality === "Poor" ||
      status.wifiQuality === "Very poor" ||
      status.wifiRiskLevel === "High"
    ) {
      warnings.push({
        severity: "warning",
        cameraId: camera.id,
        cameraName: camera.name,
        metric: "wifi",
        message: `${camera.name} Wi-Fi signal is ${status.wifiQuality} at ${status.wifiSignal} dBm.`,
      });
    }

    if (status.packetLoss !== null && status.packetLoss > 0) {
      warnings.push({
        severity: "warning",
        cameraId: camera.id,
        cameraName: camera.name,
        metric: "packet_loss",
        message: `${camera.name} packet loss is ${status.packetLoss}%.`,
      });
    }

    if (status.motionDetection !== "Enabled") {
      warnings.push({
        severity: "warning",
        cameraId: camera.id,
        cameraName: camera.name,
        metric: "motion_detection",
        message: `${camera.name} motion detection is disabled.`,
      });
    }

    if (status.motionAlerts !== "Enabled") {
      warnings.push({
        severity: "info",
        cameraId: camera.id,
        cameraName: camera.name,
        metric: "motion_alerts",
        message: `${camera.name} motion alerts are disabled.`,
      });
    }

    if (
      status.firmwareStatus !== "Up to Date" &&
      status.firmwareStatus !== "Unknown"
    ) {
      warnings.push({
        severity: "info",
        cameraId: camera.id,
        cameraName: camera.name,
        metric: "firmware",
        message: `${camera.name} firmware status is ${status.firmwareStatus}.`,
      });
    }
  }

  return warnings;
}

function generateChimeWarnings(
  serializedChimes: ReturnType<typeof serializeChime>[]
): DashboardWarning[] {
  const warnings: DashboardWarning[] = [];

  for (const chime of serializedChimes) {
    const status = chime.status;

    if (status.connectionStatus !== "Online") {
      warnings.push({
        severity: "critical",
        cameraId: chime.id,
        cameraName: chime.name,
        metric: "chime_connection",
        message: `${chime.name} chime is not reporting online status.`,
      });
    }

    if (
      status.wifiQuality === "Poor" ||
      status.wifiQuality === "Very poor"
    ) {
      warnings.push({
        severity: "warning",
        cameraId: chime.id,
        cameraName: chime.name,
        metric: "chime_wifi",
        message: `${chime.name} chime Wi-Fi signal is ${status.wifiQuality} at ${status.wifiSignal} dBm.`,
      });
    }

    if (status.doNotDisturb !== "Off") {
      warnings.push({
        severity: "info",
        cameraId: chime.id,
        cameraName: chime.name,
        metric: "chime_dnd",
        message: `${chime.name} chime has Do Not Disturb enabled.`,
      });
    }

    if (
      status.firmwareStatus !== "Up to Date" &&
      status.firmwareStatus !== "Unknown"
    ) {
      warnings.push({
        severity: "info",
        cameraId: chime.id,
        cameraName: chime.name,
        metric: "chime_firmware",
        message: `${chime.name} chime firmware status is ${status.firmwareStatus}.`,
      });
    }
  }

  return warnings;
}

function notificationToActivity(camera: any, notification: any): ActivityEvent {
  const action =
    notification?.android_config?.category ??
    notification?.data?.event?.kind ??
    notification?.data?.event ??
    notification?.event ??
    notification?.action ??
    "unknown";

  const dingId = notification?.data?.event?.ding?.id;

  return {
    id: dingId ? `${camera.id}-${dingId}` : `${camera.id}-${Date.now()}`,
    cameraId: camera.id,
    cameraName: camera.name,
    eventType: String(action),
    source: "ring_notification",
    receivedAt: new Date().toISOString(),
  };
}

function findCameraById(cameras: any[], cameraId: string) {
  return cameras.find((camera) => String(camera.id) === String(cameraId));
}

function getChimesFromLocations(locations: any[]): any[] {
  return locations.flatMap((location) =>
    Array.isArray(location.chimes) ? location.chimes : []
  );
}

function formatUptime(secondsValue: unknown): string {
  const seconds = toNumber(secondsValue);

  if (seconds === null) {
    return "Unknown";
  }

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

function safeFilename(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function getSnapshotFilePath(filename: string): string {
  const snapshotPath = path.resolve(SNAPSHOT_DIR, filename);
  const snapshotRoot = path.resolve(SNAPSHOT_DIR);

  if (!snapshotPath.startsWith(snapshotRoot + path.sep)) {
    throw new Error("Invalid snapshot filename");
  }

  return snapshotPath;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function cleanupSnapshots(activityHistory: ActivityEvent[]) {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    return;
  }

  const retentionMs = SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoffTime = Date.now() - retentionMs;

  const files = fs
    .readdirSync(SNAPSHOT_DIR)
    .filter((filename) => filename.toLowerCase().endsWith(".jpg"))
    .map((filename) => {
      const fullPath = getSnapshotFilePath(filename);
      const stats = fs.statSync(fullPath);

      return {
        filename,
        fullPath,
        mtimeMs: stats.mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const filesToDelete = new Set<string>();

  for (const file of files) {
    if (file.mtimeMs < cutoffTime) {
      filesToDelete.add(file.fullPath);
    }
  }

  for (const file of files.slice(MAX_SNAPSHOTS)) {
    filesToDelete.add(file.fullPath);
  }

  for (const filePath of filesToDelete) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      console.warn("Failed to delete old snapshot:", filePath, error);
    }
  }

  const deletedFilenames = new Set(
    [...filesToDelete].map((filePath) => path.basename(filePath))
  );

  if (deletedFilenames.size > 0) {
    const updatedHistory = activityHistory.map((event) => {
      if (
        event.snapshot?.filename &&
        deletedFilenames.has(event.snapshot.filename)
      ) {
        return {
          ...event,
          snapshot: {
            available: false,
            filename: event.snapshot.filename,
            capturedAt: event.snapshot.capturedAt,
            error: "Snapshot removed by retention policy",
          },
        };
      }

      return event;
    });

    saveActivityHistory(updatedHistory);
  }
}

async function captureSnapshotForActivity(
  camera: any,
  event: ActivityEvent
): Promise<ActivityEvent> {
  if (typeof camera.getSnapshot !== "function") {
    return {
      ...event,
      snapshot: {
        available: false,
        error: "Camera does not expose getSnapshot()",
      },
    };
  }

  try {
    const snapshotBuffer = await withTimeout(
      camera.getSnapshot(),
      SNAPSHOT_TIMEOUT_MS,
      "Snapshot capture timed out"
    );

    if (!Buffer.isBuffer(snapshotBuffer)) {
      return {
        ...event,
        snapshot: {
          available: false,
          error: "Camera did not return a snapshot buffer",
        },
      };
    }

    const timestamp = event.receivedAt.replace(/[:.]/g, "-");
    const cameraName = safeFilename(event.cameraName || "camera");
    const filename = `${cameraName}-${event.cameraId}-${timestamp}.jpg`;
    const snapshotPath = getSnapshotFilePath(filename);

    fs.writeFileSync(snapshotPath, snapshotBuffer);

    return {
      ...event,
      snapshot: {
        available: true,
        filename,
        capturedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    return {
      ...event,
      snapshot: {
        available: false,
        error: message,
      },
    };
  }
}

function serializeActivityEvent(event: ActivityEvent) {
  return {
    ...event,
    snapshotUrl:
      event.snapshot?.available && event.snapshot.filename
        ? `/api/activity/${encodeURIComponent(event.id)}/snapshot`
        : null,
  };
}

function listSnapshotGallery(activityHistory: ActivityEvent[]): SnapshotGalleryItem[] {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    return [];
  }

  const activityByFilename = new Map<string, ActivityEvent>();

  for (const event of activityHistory) {
    if (event.snapshot?.filename) {
      activityByFilename.set(event.snapshot.filename, event);
    }
  }

  return fs
    .readdirSync(SNAPSHOT_DIR)
    .filter((filename) => filename.toLowerCase().endsWith(".jpg"))
    .map((filename) => {
      const fullPath = getSnapshotFilePath(filename);
      const stats = fs.statSync(fullPath);
      const relatedActivity = activityByFilename.get(filename) ?? null;

      return {
        filename,
        url: `/api/snapshots/${encodeURIComponent(filename)}`,
        sizeBytes: stats.size,
        createdAt: stats.birthtime.toISOString(),
        relatedActivityId: relatedActivity?.id ?? null,
        cameraName: relatedActivity?.cameraName ?? null,
        eventType: relatedActivity?.eventType ?? null,
        source: relatedActivity?.source ?? null,
      };
    })
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
}

async function main() {
  let activityHistory = loadActivityHistory();
  cleanupSnapshots(activityHistory);
  activityHistory = loadActivityHistory();

  const ringApi = new RingApi({
    refreshToken: getRefreshToken(),
    debug: false,
    cameraStatusPollingSeconds: 30,
  });

  ringApi.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
    fs.writeFileSync(TOKEN_FILE, newRefreshToken);
    console.log("Saved updated Ring refresh token locally.");
  });

  const locations = await ringApi.getLocations();
  const cameras = await ringApi.getCameras();
  const chimes = getChimesFromLocations(locations as any[]);

  for (const location of locations as any[]) {
  console.log("Location:", location.name);

  if (location.chimes) {
    console.log(`Found ${location.chimes.length} chime(s)`);

    for (const chime of location.chimes) {
      console.log({
        id: chime.id,
        name: chime.name,
        model: chime.model,
        deviceType: chime.deviceType,
        dataKeys: Object.keys(chime.data ?? {}).sort(),
        data: chime.data,
      });
    }
  } else {
    console.log("No chimes property found on location");
  }
}

  console.log(`Found ${locations.length} Ring location(s)`);
  console.log(`Found ${cameras.length} Ring camera(s)`);
  console.log(`Found ${chimes.length} Ring chime(s)`);

  // ---- Shared payload builders ----
  // Used by both the REST endpoints and the live (SSE) stream so the two can
  // never drift out of sync.

  function buildHealthPayload() {
    return {
      ok: true,
      app: "ring-dashboard",
      timestamp: new Date().toISOString(),
      cameras: cameras.length,
      chimes: chimes.length,
      locations: locations.length,
      snapshotRetentionDays: SNAPSHOT_RETENTION_DAYS,
      maxSnapshots: MAX_SNAPSHOTS,
    };
  }

  function buildStatusPayload() {
    const serializedCameras = (cameras as any[]).map(serializeCamera);
    const serializedChimes = (chimes as any[]).map(serializeChime);

    const warnings = [
      ...generateWarnings(serializedCameras),
      ...generateChimeWarnings(serializedChimes),
    ];

    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      totalCameras: serializedCameras.length,
      totalChimes: serializedChimes.length,
      totalActivityEvents: activityHistory.length,
      totalSnapshots: listSnapshotGallery(activityHistory).length,
      warnings,
      cameras: serializedCameras.map((camera) => ({
        id: camera.id,
        name: camera.name,
        model: camera.model,
        deviceType: camera.deviceType,
        status: camera.status,
      })),
      chimes: serializedChimes.map((chime) => ({
        id: chime.id,
        name: chime.name,
        model: chime.model,
        deviceType: chime.deviceType,
        status: chime.status,
      })),
    };
  }

  function buildActivityPayload() {
    return {
      count: activityHistory.length,
      activity: activityHistory.map(serializeActivityEvent),
    };
  }

  function buildSnapshotsPayload() {
    const snapshots = listSnapshotGallery(activityHistory);
    return {
      count: snapshots.length,
      snapshots,
      retention: {
        snapshotRetentionDays: SNAPSHOT_RETENTION_DAYS,
        maxSnapshots: MAX_SNAPSHOTS,
      },
    };
  }

  function buildDashboardPayload() {
    return {
      health: buildHealthPayload(),
      status: buildStatusPayload(),
      activity: buildActivityPayload(),
      snapshots: buildSnapshotsPayload(),
    };
  }

  // ---- Live updates (Server-Sent Events) ----
  // One open connection per browser instead of every browser polling four
  // endpoints on a timer. The server pushes a fresh payload only when the
  // meaningful state changes (or immediately when new activity arrives).

  // A fingerprint of the parts that matter, excluding volatile timestamps, so
  // the periodic tick does not re-send identical state.
  function dashboardSignature(
    payload: ReturnType<typeof buildDashboardPayload>
  ): string {
    return JSON.stringify({
      warnings: payload.status.warnings,
      cameras: payload.status.cameras,
      chimes: payload.status.chimes,
      activity: payload.activity.activity.map((event) => event.id),
      snapshots: payload.snapshots.snapshots.map(
        (snapshot) => snapshot.filename
      ),
    });
  }

  const liveUpdates = createLiveUpdates({
    buildPayload: buildDashboardPayload,
    signature: dashboardSignature,
    eventName: "dashboard",
    tickMs: SSE_TICK_MS,
    heartbeatMs: SSE_HEARTBEAT_MS,
  });

  for (const chime of chimes as any[]) {
  console.log({
    id: chime.id,
    name: chime.name,
    model: chime.model,
    deviceType: chime.deviceType,
  });
  }

  for (const camera of cameras as any[]) {
    console.log({
      id: camera.id,
      name: camera.name,
      model: camera.model,
      deviceType: camera.deviceType,
      isDoorbot: camera.isDoorbot,
    });

    camera.onNewNotification?.subscribe(async (notification: any) => {
      const event = notificationToActivity(camera, notification);
      const eventWithSnapshot = await captureSnapshotForActivity(camera, event);

      activityHistory = addActivityEvent(activityHistory, eventWithSnapshot);
      cleanupSnapshots(activityHistory);
      activityHistory = loadActivityHistory();

      liveUpdates.broadcast(true);
      console.log("New Ring activity:", eventWithSnapshot);
    });
  }

  const app = express();

  app.use(express.json());

  // Local-only authentication. Registers the public login/logout/status
  // routes and the login page, then returns the gate middleware.
  const authConfig = await loadAuthConfig();
  const { requireAuth } = installAuth(app, authConfig, publicDir);

  if (authConfig.enabled) {
    console.log(`[auth] Authentication enabled for user "${authConfig.username}".`);
  }

  // Health check stays public so the Docker HEALTHCHECK can reach it without
  // a session. It only exposes device counts, not Ring data.
  app.get("/api/health", (_req, res) => {
    res.json(buildHealthPayload());
  });

  // Everything below this line requires a valid session (when auth is enabled).
  app.use(requireAuth);

  app.use(express.static(publicDir));

  // Live update stream. EventSource sends the session cookie automatically, so
  // this sits behind the same auth gate as the rest of the API.
  app.get("/api/events", liveUpdates.handler);

  app.get("/api/cameras", (_req, res) => {
    res.json({
      count: cameras.length,
      cameras: (cameras as any[]).map(serializeCamera),
    });
  });

  app.get("/api/chimes", (_req, res) => {
    const serializedChimes = (chimes as any[]).map(serializeChime);

    res.json({
      count: serializedChimes.length,
      chimes: serializedChimes,
    });
  });

  app.get("/api/devices", (_req, res) => {
    const serializedCameras = (cameras as any[]).map(serializeCamera);
    const serializedChimes = (chimes as any[]).map(serializeChime);

    res.json({
      count: serializedCameras.length + serializedChimes.length,
      cameras: serializedCameras,
      chimes: serializedChimes,
    });
  });

  app.get("/api/status", (_req, res) => {
    res.json(buildStatusPayload());
  });

  app.get("/api/warnings", (_req, res) => {
    const serializedCameras = (cameras as any[]).map(serializeCamera);

    res.json({
      count: generateWarnings(serializedCameras).length,
      warnings: generateWarnings(serializedCameras),
    });
  });

  app.get("/api/cameras/:cameraId/snapshot", async (req, res) => {
    const camera = findCameraById(cameras as any[], req.params.cameraId);

    if (!camera) {
      res.status(404).json({
        ok: false,
        error: `No camera found with id ${req.params.cameraId}`,
      });
      return;
    }

    if (typeof camera.getSnapshot !== "function") {
      res.status(501).json({
        ok: false,
        error: "This camera object does not expose getSnapshot()",
      });
      return;
    }

    try {
      const snapshotBuffer = await withTimeout(
        camera.getSnapshot(),
        SNAPSHOT_TIMEOUT_MS,
        "Snapshot request timed out"
      );

      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.send(snapshotBuffer);
    } catch (error) {
      console.error("Snapshot request failed:", error);

      res.status(500).json({
        ok: false,
        error: "Failed to fetch camera snapshot",
      });
    }
  });

  app.get("/api/snapshots", (_req, res) => {
    res.json(buildSnapshotsPayload());
  });

  app.get("/api/snapshots/:filename", (req, res) => {
    try {
      const snapshotPath = getSnapshotFilePath(req.params.filename);

      if (!fs.existsSync(snapshotPath)) {
        res.status(404).json({
          ok: false,
          error: "Snapshot file not found",
        });
        return;
      }

      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.sendFile(snapshotPath);
    } catch (error) {
      console.error("Snapshot gallery request failed:", error);

      res.status(500).json({
        ok: false,
        error: "Failed to read snapshot",
      });
    }
  });

  app.get("/api/activity", (_req, res) => {
    res.json(buildActivityPayload());
  });

  app.get("/api/activity/:activityId/snapshot", (req, res) => {
    const event = activityHistory.find(
      (activityEvent) => activityEvent.id === req.params.activityId
    );

    if (!event) {
      res.status(404).json({
        ok: false,
        error: "Activity event not found",
      });
      return;
    }

    if (!event.snapshot?.available || !event.snapshot.filename) {
      res.status(404).json({
        ok: false,
        error: "No snapshot is attached to this activity event",
      });
      return;
    }

    try {
      const snapshotPath = getSnapshotFilePath(event.snapshot.filename);

      if (!fs.existsSync(snapshotPath)) {
        res.status(404).json({
          ok: false,
          error: "Snapshot file not found",
        });
        return;
      }

      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.sendFile(snapshotPath);
    } catch (error) {
      console.error("Activity snapshot request failed:", error);

      res.status(500).json({
        ok: false,
        error: "Failed to read activity snapshot",
      });
    }
  });

  app.post("/api/activity/test", async (_req, res) => {
    const camera = (cameras as any[])[0];

    if (!camera) {
      res.status(404).json({
        ok: false,
        error: "No camera found to attach synthetic event to",
      });
      return;
    }

    const testEvent: ActivityEvent = {
      id: `synthetic-${camera.id}-${Date.now()}`,
      cameraId: camera.id,
      cameraName: camera.name,
      eventType: "Synthetic test activity",
      source: "synthetic_test",
      receivedAt: new Date().toISOString(),
    };

    const testEventWithSnapshot = await captureSnapshotForActivity(
      camera,
      testEvent
    );

    activityHistory = addActivityEvent(activityHistory, testEventWithSnapshot);
    cleanupSnapshots(activityHistory);
    activityHistory = loadActivityHistory();

    liveUpdates.broadcast(true);

    res.json({
      ok: true,
      event: serializeActivityEvent(testEventWithSnapshot),
    });
  });

  app.get("/api/debug/cameras", (_req, res) => {
    res.json({
      warning:
        "Debug view only. Do not expose this dashboard publicly without auth.",
      cameras: (cameras as any[]).map((camera) => {
        const data = asRecord(camera.data) ?? {};
        const health = asRecord(data.health) ?? {};

        return {
          id: camera.id,
          name: camera.name,
          model: camera.model,
          deviceType: camera.deviceType,
          topLevelDataKeys: Object.keys(data).sort(),
          healthKeys: Object.keys(health).sort(),
          health,
          selectedValues: {
            battery_life: data.battery_life ?? null,
            battery_life_2: data.battery_life_2 ?? null,
            battery_voltage: data.battery_voltage ?? null,
            battery_voltage_2: data.battery_voltage_2 ?? null,
            firmware_version: data.firmware_version ?? null,
            external_connection: data.external_connection ?? null,
            led_status: data.led_status ?? null,
            siren_status: data.siren_status ?? null,
            subscribed: data.subscribed ?? null,
            subscribed_motions: data.subscribed_motions ?? null,
            alerts: data.alerts ?? null,
            settings: data.settings ?? null,
            features: data.features ?? null,
          },
        };
      }),
    });
  });

  app.get("/api/debug/chimes", (_req, res) => {
    res.json({
      warning:
        "Debug view only. Do not expose this dashboard publicly without auth.",
      chimes: (chimes as any[]).map((chime) => {
        const data = asRecord(chime.data) ?? {};
        const health = asRecord(data.health) ?? {};
        const settings = asRecord(data.settings) ?? {};

        return {
          id: chime.id,
          name: chime.name,
          model: chime.model,
          deviceType: chime.deviceType,
          topLevelDataKeys: Object.keys(data).sort(),
          healthKeys: Object.keys(health).sort(),
          settingsKeys: Object.keys(settings).sort(),
          selectedValues: {
            connected: health.connected ?? null,
            firmware_version: health.firmware_version ?? null,
            firmware_version_status: health.firmware_version_status ?? null,
            rssi: health.rssi ?? null,
            rssi_category: health.rssi_category ?? null,
            wifi_name: health.wifi_name ?? null,
            network_connection_value: health.network_connection_value ?? null,
            current_bandwidth_mb: health.current_bandwidth_mb ?? null,
            volume: settings.volume ?? null,
            do_not_disturb: data.do_not_disturb ?? null,
            night_light_state: data.night_light_state ?? null,
            status_led_enable: settings.status_led_enable ?? null,
            uptime_sec: health.uptime_sec ?? null,
          },
        };
      }),
    });
  });

  app.listen(PORT, () => {
    console.log(`Ring dashboard running at http://localhost:${PORT}`);
  });

  // Start the periodic status tick (covers Ring health updates that arrive via
  // background polling) and the keep-alive heartbeat.
  liveUpdates.start();
}

main().catch((error) => {
  console.error("Ring dashboard failed:", error);
  process.exit(1);
});