import { pino, type Logger } from "pino";
import type { Config } from "./config.js";

export type { Logger };

/**
 * Structured JSON logs in production, human-readable in development.
 *
 * Every long-lived component takes a child logger, so a line can always be
 * traced back to the subsystem and, where relevant, the job or project it
 * belongs to.
 */
export function createLogger(config: Config): Logger {
  if (config.isProduction) {
    return pino({
      level: config.logLevel,
      base: { service: "control-plane" },
      redact: {
        paths: [
          "password",
          "*.password",
          "connectionString",
          "*.connectionString",
          "masterKey",
          "*.masterKey",
        ],
        censor: "[redacted]",
      },
    });
  }

  return pino({
    level: config.logLevel,
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
    },
  });
}
