import pino from 'pino';
import { config } from '../config.js';
import path from 'path';

function buildTransport(): pino.TransportSingleOptions | pino.TransportMultiOptions | undefined {
  if (process.env.NODE_ENV === 'production') {
    const targets: pino.TransportTargetOptions[] = [
      // JSON to stdout (for log aggregation)
      { target: 'pino/file', options: { destination: 1 }, level: config.logLevel },
    ];

    // Optional rotating file logs
    const logDir = process.env.LOG_DIR;
    if (logDir) {
      targets.push({
        target: 'pino/file',
        options: { destination: path.join(logDir, 'indexer.log') },
        level: config.logLevel,
      });
      targets.push({
        target: 'pino/file',
        options: { destination: path.join(logDir, 'error.log') },
        level: 'error',
      });
    }

    return targets.length > 1 ? { targets } : undefined;
  }

  // Development: pretty-printed output
  return { target: 'pino-pretty', options: { colorize: true } };
}

export const logger = pino({
  level: config.logLevel,
  transport: buildTransport(),
  redact: {
    paths: [
      'rpcUrl',
      'supabaseServiceRoleKey',
      '*.rpcUrl',
      '*.supabaseServiceRoleKey',
      '*.authorization',
      '*.apiKey',
      '*.*.rpcUrl',
      '*.*.supabaseServiceRoleKey',
      '*.*.authorization',
      '*.*.apiKey',
    ],
    censor: '[REDACTED]',
  },
});
