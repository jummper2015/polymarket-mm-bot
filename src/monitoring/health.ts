import http from 'http';
import { Metrics } from './metrics';
import { logger } from '../utils/logger';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Health Check HTTP Server
   ─────────────────────────────────────────────────────
   GET /health → 200 + JSON status
   GET /metrics → 200 + JSON metrics
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export class HealthServer {
  private server: http.Server | null = null;
  private status: Record<string, any> = {
    status: 'starting',
    startedAt: new Date().toISOString(),
  };

  constructor(
    private port: number,
    private metrics: Metrics,
  ) {}

  start(): void {
    this.server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/health') {
        const body = JSON.stringify({
          ...this.status,
          uptime: this.metrics.getUptimeFormatted(),
          timestamp: new Date().toISOString(),
        });
        res.writeHead(200);
        res.end(body);
        return;
      }

      if (req.url === '/metrics') {
        const body = JSON.stringify(this.metrics.serialize(), null, 2);
        res.writeHead(200);
        res.end(body);
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    this.server.listen(this.port, () => {
      logger.info(`Health server listening on http://localhost:${this.port}/health`);
    });

    this.server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn(`Port ${this.port} in use — health server disabled`);
      } else {
        logger.error(err, 'Health server error');
      }
    });
  }

  updateStatus(update: Record<string, any>): void {
    this.status = { ...this.status, ...update };
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}