import { pino, type Logger } from "pino";
import type { RouterConfig } from "./config.js";

export type { Logger };

export function createLogger(config: RouterConfig): Logger {
  if (config.isProduction) {
    return pino({
      level: config.logLevel,
      base: { service: "router" },
      redact: { paths: ["password", "*.password"], censor: "[redacted]" },
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
