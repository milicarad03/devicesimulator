const path = require('path');
const winston = require('winston');

function createSimulatorLogger(environment, baseDirectory) {
  const errorLogFile =
    environment.SIMULATOR_ERROR_LOG_FILE ||
    path.join(baseDirectory, 'error.log');

  return winston.createLogger({
    level: environment.LOG_LEVEL || 'info',
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          winston.format.printf(({ timestamp, level, message }) =>
            `[Sim] - ${timestamp}   ${level}: [DeviceSimulator] ${message}`,
          ),
        ),
      }),
      new winston.transports.File({
        filename: errorLogFile,
        level: 'error',
        options: { flags: 'a' },
        handleExceptions: true,
        format: winston.format.combine(
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          winston.format.printf(({ timestamp, level, message }) =>
            `[${timestamp}] [${level.toUpperCase()}] ${message}`,
          ),
        ),
      }),
    ],
  });
}

module.exports = { createSimulatorLogger };
