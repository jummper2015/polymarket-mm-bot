import { loadConfig } from './config';
import { Engine } from './engine/engine';
import { logger } from './utils/logger';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Entry Point — V1.1
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

async function main() {
  let engine: Engine | null = null;

  try {
    const config = loadConfig();

    /* Configure logger with file output */
    logger.configure({
      level: (process.env.LOG_LEVEL as any) || 'INFO',
      dir: config.logDir,
      maxFiles: config.logMaxFiles,
    });

    engine = new Engine(config);

    /* Graceful shutdown */
    let shutdownCalled = false;
    const shutdown = (signal: string) => {
      if (shutdownCalled) {
        logger.warn('Force exit');
        process.exit(1);
      }
      shutdownCalled = true;
      logger.info(`\n${signal} received — shutting down gracefully...`);
      engine?.stop();
      /* Engine.start() loop will exit, save state, and clean up */
      setTimeout(() => {
        logger.warn('Shutdown timeout — forcing exit');
        process.exit(0);
      }, 10_000);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('uncaughtException', (err) => {
      logger.error(err, 'Uncaught exception');
      engine?.stop();
      setTimeout(() => process.exit(1), 5000);
    });

    process.on('unhandledRejection', (reason: any) => {
      logger.error(reason, 'Unhandled promise rejection');
    });

    await engine.start();
  } catch (err: any) {
    logger.error(err, 'Fatal error');
    process.exit(1);
  }
}

main();