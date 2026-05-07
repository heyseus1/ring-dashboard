import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { RingApi } from "ring-client-api";

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || ".";
const TOKEN_FILE = path.join(DATA_DIR, ".ring-refresh-token");
const ACTIVITY_FILE = path.join(DATA_DIR, ".ring-activity-history.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MAX_ACTIVITY_EVENTS = 100;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");

type ActivitySource =
  | "ring_notification"
  | "ring_history"
  | "synthetic_test"
  | "legacy_local";

type ActivityEvent = {
  id: string;
  cameraId: number | string;
  cameraName: string;
  eventType: string;
  source: ActivitySource;
  receivedAt: string;
};

type BatteryEntry = {
  slot: number;
  percentage: number | null;
  voltage: number | null;
  present: boolean | null;
  category: string | null;
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

async function main() {
  let activityHistory = loadActivityHistory();

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

  console.log(`Found ${locations.length} Ring location(s)`);
  console.log(`Found ${cameras.length} Ring camera(s)`);

  for (const camera of cameras as any[]) {
    console.log({
      id: camera.id,
      name: camera.name,
      model: camera.model,
      deviceType: camera.deviceType,
      isDoorbot: camera.isDoorbot,
    });

    camera.onNewNotification?.subscribe((notification: any) => {
      const event = notificationToActivity(camera, notification);
      activityHistory = addActivityEvent(activityHistory, event);

      console.log("New Ring activity:", event);
    });
  }

  const app = express();

  app.use(express.json());
  app.use(express.static(publicDir));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      app: "ring-dashboard",
      timestamp: new Date().toISOString(),
      cameras: cameras.length,
      locations: locations.length,
    });
  });

  app.get("/api/cameras", (_req, res) => {
    res.json({
      count: cameras.length,
      cameras: (cameras as any[]).map(serializeCamera),
    });
  });

  app.get("/api/status", (_req, res) => {
    const serializedCameras = (cameras as any[]).map(serializeCamera);

    res.json({
      ok: true,
      updatedAt: new Date().toISOString(),
      totalCameras: serializedCameras.length,
      totalActivityEvents: activityHistory.length,
      cameras: serializedCameras.map((camera) => ({
        id: camera.id,
        name: camera.name,
        model: camera.model,
        deviceType: camera.deviceType,
        status: camera.status,
      })),
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
      const snapshotBuffer = await camera.getSnapshot();

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

  app.get("/api/activity", (_req, res) => {
    res.json({
      count: activityHistory.length,
      activity: activityHistory,
    });
  });

  app.post("/api/activity/test", (_req, res) => {
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

    activityHistory = addActivityEvent(activityHistory, testEvent);

    res.json({
      ok: true,
      event: testEvent,
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

  app.listen(PORT, () => {
    console.log(`Ring dashboard running at http://localhost:${PORT}`);
  });
}

main().catch((error) => {
  console.error("Ring dashboard failed:", error);
  process.exit(1);
});