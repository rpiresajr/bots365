const pino = require("pino");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      levelFirst: true,
      translateTime: "yyyy-mm-dd HH:MM:ss",
      ignore: "pid,hostname",
    },
  },
});

module.exports = logger;
