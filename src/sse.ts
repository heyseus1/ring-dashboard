import type { Request, Response } from "express";

/**
 * A small, framework-light Server-Sent Events helper.
 *
 * It keeps the set of connected clients, formats SSE frames, pushes a fresh
 * payload on demand (or on a timer), and only re-sends when the payload's
 * signature actually changes. No external dependencies, no network calls of
 * its own.
 */
export type LiveUpdates<T> = {
  /** Express handler for the SSE endpoint (e.g. GET /api/events). */
  handler: (req: Request, res: Response) => void;
  /** Push to all clients. `force` ignores the change-detection check. */
  broadcast: (force?: boolean) => void;
  /** Start the periodic tick and heartbeat timers. */
  start: () => void;
  /** Stop the timers (used in tests / shutdown). */
  stop: () => void;
  /** Current number of connected clients. */
  clientCount: () => number;
};

export function createLiveUpdates<T>(options: {
  buildPayload: () => T;
  signature: (payload: T) => string;
  eventName?: string;
  tickMs?: number;
  heartbeatMs?: number;
}): LiveUpdates<T> {
  const eventName = options.eventName ?? "dashboard";
  const clients = new Set<Response>();
  let lastSignature = "";
  let tickTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;

  function frame(payload: T): string {
    return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  function broadcast(force = false) {
    const payload = options.buildPayload();
    const signature = options.signature(payload);

    if (!force && signature === lastSignature) {
      return;
    }

    lastSignature = signature;

    if (clients.size === 0) {
      return;
    }

    const data = frame(payload);

    for (const client of clients) {
      try {
        client.write(data);
      } catch {
        clients.delete(client);
      }
    }
  }

  function handler(req: Request, res: Response) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    req.socket.setTimeout(0);
    clients.add(res);

    // Push current state immediately so the client renders without a separate
    // initial fetch.
    try {
      res.write(frame(options.buildPayload()));
    } catch {
      clients.delete(res);
    }

    req.on("close", () => {
      clients.delete(res);
    });
  }

  function start() {
    if (options.tickMs && !tickTimer) {
      tickTimer = setInterval(() => broadcast(false), options.tickMs);
    }

    if (options.heartbeatMs && !heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        for (const client of clients) {
          try {
            client.write(": ping\n\n");
          } catch {
            clients.delete(client);
          }
        }
      }, options.heartbeatMs);
    }
  }

  function stop() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  }

  return {
    handler,
    broadcast,
    start,
    stop,
    clientCount: () => clients.size,
  };
}
