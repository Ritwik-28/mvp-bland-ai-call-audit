import winston from 'winston';
const { combine, timestamp, printf, colorize } = winston.format;
const logfmt = printf(({level,message,timestamp})=>`${timestamp} [${level}]: ${message}`);
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(colorize(), timestamp(), logfmt),
  transports:[new winston.transports.Console()]
});
