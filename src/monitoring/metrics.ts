/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Metrics Tracker — Basic operational metrics
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private startTime: number;
  private fillTimestamps: number[] = [];

  constructor() {
    this.startTime = Date.now();
  }

  /* ── Counters (monotonically increasing) ── */

  increment(name: string, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  getCounter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  /* ── Gauges (current value) ── */

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  getGauge(name: string): number {
    return this.gauges.get(name) ?? 0;
  }

  /* ── Derived metrics ── */

  recordFill(): void {
    this.increment('total_fills');
    this.fillTimestamps.push(Date.now());
    /* Keep only last hour of timestamps */
    const oneHourAgo = Date.now() - 3_600_000;
    this.fillTimestamps = this.fillTimestamps.filter((t) => t > oneHourAgo);
  }

  /** Fills per hour (rolling) */
  getFillRate(): number {
    const oneHourAgo = Date.now() - 3_600_000;
    return this.fillTimestamps.filter((t) => t > oneHourAgo).length;
  }

  /** Uptime in seconds */
  getUptimeSeconds(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  /** Formatted uptime */
  getUptimeFormatted(): string {
    const totalSec = this.getUptimeSeconds();
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    return `${hours}h ${mins}m ${secs}s`;
  }

  /** Return all metrics as a flat object (for state persistence) */
  serialize(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.counters) out[`counter_${k}`] = v;
    for (const [k, v] of this.gauges) out[`gauge_${k}`] = v;
    out.fill_rate_per_hour = this.getFillRate();
    out.uptime_seconds = this.getUptimeSeconds();
    return out;
  }

  /** Print a summary to console */
  printSummary(): void {
    console.log('\n┌─── 📊 METRICS ───────────────────────────┐');
    console.log(`│ Uptime:        ${this.getUptimeFormatted().padEnd(25)}│`);
    console.log(`│ Total Fills:   ${String(this.getCounter('total_fills')).padEnd(25)}│`);
    console.log(`│ Fills/Hour:    ${String(this.getFillRate()).padEnd(25)}│`);
    console.log(`│ Cycles:        ${String(this.getCounter('cycles')).padEnd(25)}│`);
    console.log(`│ Signals:       ${String(this.getCounter('total_signals')).padEnd(25)}│`);
    console.log(`│ Orders Sent:   ${String(this.getCounter('orders_sent')).padEnd(25)}│`);
    console.log(`│ API Errors:    ${String(this.getCounter('api_errors')).padEnd(25)}│`);
    console.log(`│ API Retries:   ${String(this.getCounter('api_retries')).padEnd(25)}│`);
    console.log(`│ State Saves:   ${String(this.getCounter('state_saves')).padEnd(25)}│`);
    console.log('└───────────────────────────────────────────┘');
  }
}