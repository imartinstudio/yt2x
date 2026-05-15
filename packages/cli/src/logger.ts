import pino, { type LoggerOptions } from "pino";

const isTTY = process.stdout.isTTY;

const loggerOptions: LoggerOptions = {
  level: process.env.YT2X_LOG_LEVEL ?? "info",
};

if (isTTY) {
  loggerOptions.transport = {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss",
      ignore: "pid,hostname",
    },
  };
}

export const logger = pino(loggerOptions);

export type Logger = typeof logger;
