import { BotConfig } from '../config';
import { PolymarketAPI } from '../api/polymarket';
import { MarketMakingStrategy } from '../strategy/market_making';
import { Executor } from './executor';
import { PaperExecutor } from './paper';
import { LiveExecutor } from './live';
import { StateStore } from '../persistence/state_store';
import { Metrics } from '../monitoring/metrics';
import { HealthServer } from '../monitoring/health';
import { MarketInfo, MarketData, StrategyContext, BotState } from '../types';
import { logger } from '../utils/logger';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Engine — V1.1 with persistence, metrics, health
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export class Engine {
  private api: PolymarketAPI;
  private strategy: MarketMakingStrategy;
  private executor: Executor;
  private stateStore: StateStore;
  private metrics: Metrics;
  private health: HealthServer;
  private marketInfos: MarketInfo[] = [];
  private currentData = new Map<string, MarketData>();
  private running = false;
  private marketRefreshInterval = 5 * 60 * 1000;
  private lastMarketRefresh = 0;
    /** Only cancel orders older than maxAge, keep fresh ones */
  private async cancelStaleOrders(maxAgeMs: number): Promise<void> {
    /* In paper mode we can be selective; in live mode cancel all for safety */
    if (this.config.mode === 'live') {
      await this.executor.cancelOrders();
      return;
    }

    /* For paper: the executor handles it — we just cancel all for now
       but orders get a chance to fill first since checkFills runs before this */
    await this.executor.cancelOrders();
  }
  private lastStateSave = 0;

  constructor(private config: BotConfig) {
    this.api = new PolymarketAPI(config);
    this.strategy = new MarketMakingStrategy();
    this.stateStore = new StateStore(config.stateDir);
    this.metrics = new Metrics();
    this.health = new HealthServer(config.healthPort, this.metrics);

    if (config.mode === 'live') {
      this.executor = new LiveExecutor(config);
    } else {
      this.executor = new PaperExecutor(config.initialCapital);
    }
  }

  async start(): Promise<void> {
    logger.info(`\n${'━'.repeat(55)}`);
    logger.info(`  Polymarket MM Bot v1.1 — ${this.config.mode.toUpperCase()} MODE`);
    logger.info(`  Capital: $${this.config.initialCapital}`);
    logger.info(`  Max Markets: ${this.config.maxMarkets}`);
    logger.info(`  Poll Interval: ${this.config.pollIntervalMs}ms`);
    logger.info(`  State Dir: ${this.config.stateDir}`);
    logger.info(`  Health: http://localhost:${this.config.healthPort}/health`);
    logger.info(`${'━'.repeat(55)}\n`);

    /* Start health server */
    this.health.start();
    this.health.updateStatus({ status: 'initialising', mode: this.config.mode });

    /* Initialise live executor if needed */
    if (this.config.mode === 'live' && this.executor instanceof LiveExecutor) {
      await (this.executor as LiveExecutor).initialize();
    }

    /* Initialise strategy */
    const context: StrategyContext = {
      wallet: {
        walletId: this.config.mode === 'live' ? 'live_wallet' : 'paper_wallet',
        capitalAllocated: this.config.initialCapital,
      },
      config: this.config.strategyParams,
    };
    this.strategy.initialize(context);

    /* V1.1: Restore state if available */
    this.restoreState();

    /* Discover markets */
    await this.refreshMarkets();

    /* Main loop */
    this.running = true;
    this.health.updateStatus({ status: 'running' });
    logger.info('Engine started — entering main loop\n');

    while (this.running) {
      try {
        await this.tick();
      } catch (err: any) {
        logger.error(err, 'Engine tick error');
        this.metrics.increment('tick_errors');
      }

      await this.sleep(this.config.pollIntervalMs);
    }

    /* Final state save on shutdown */
    this.saveState();
    this.health.updateStatus({ status: 'stopped' });
    this.health.stop();
    logger.close();
    logger.info('Engine stopped — state saved');
  }

  stop(): void {
    this.running = false;
  }

  /* ━━━━━━ Main Tick ━━━━━━ */

  private async tick(): Promise<void> {
    this.metrics.increment('cycles');

    /* 1. Refresh market list periodically */
    if (Date.now() - this.lastMarketRefresh > this.marketRefreshInterval) {
      await this.refreshMarkets();
    }

    /* 2. Update market data */
    await this.updateMarketData();

    /* 3. Check fills */
    const fills = this.executor.checkFills(this.currentData);
    for (const fill of fills) {
      this.strategy.notifyFill(fill.order);
      this.metrics.recordFill();
    }

    /* 4. Strategy cycle */
        if (this.strategy.canRun()) {
      /* Cancel stale orders that are older than 2 cycles */
      const staleMs = this.config.pollIntervalMs * 2;
      await this.cancelStaleOrders(staleMs);

      const signals = this.strategy.generateSignals();
      this.metrics.increment('total_signals', signals.length);

      const orders = this.strategy.sizePositions(signals);

      if (orders.length > 0) {
        await this.executor.submitOrders(orders);
        this.metrics.increment('orders_sent', orders.length);
      }

      this.strategy.managePositions();
      const exits = this.strategy.getPendingExits();
      if (exits.length > 0) {
        await this.executor.submitOrders(exits);
        this.metrics.increment('exit_orders', exits.length);
      }

      this.strategy.markRun();
    }

    /* 5. Update health */
    this.health.updateStatus({
      openOrders: this.executor.getOpenOrderCount(),
      trackedMarkets: this.currentData.size,
      totalFills: this.metrics.getCounter('total_fills'),
      fillRatePerHour: this.metrics.getFillRate(),
      realizedPnL: this.strategy.getTotalRealizedPnL(),
    });

    /* 6. Print status */
    this.executor.printStatus(this.currentData);

    /* 7. Print metrics periodically */
    if (this.metrics.getCounter('cycles') % 20 === 0) {
      this.metrics.printSummary();
    }

    /* 8. Save state periodically */
    if (Date.now() - this.lastStateSave > this.config.stateSaveIntervalMs) {
      this.saveState();
    }
  }

  /* ━━━━━━ State Persistence ━━━━━━ */

  private saveState(): void {
    try {
      const state: BotState = {
        version: '1.1.0',
        mode: this.config.mode,
        strategy: this.strategy.serialize(),
        executor: this.executor.serialize(),
        metrics: this.metrics.serialize(),
        savedAt: '',
      };
      this.stateStore.save(state);
      this.lastStateSave = Date.now();
      this.metrics.increment('state_saves');
    } catch (err: any) {
      logger.error(err, 'Failed to save state');
    }
  }

  private restoreState(): void {
    if (!this.stateStore.exists()) {
      logger.info('No saved state found — starting fresh');
      return;
    }

    const state = this.stateStore.load();
    if (!state) {
      logger.warn('Could not load saved state — starting fresh');
      return;
    }

    /* Validate mode matches */
    if (state.mode !== this.config.mode) {
      logger.warn(
        { savedMode: state.mode, currentMode: this.config.mode },
        'Mode mismatch — starting fresh (use --clean to remove old state)',
      );
      return;
    }

    try {
      this.strategy.restore(state.strategy);
      this.executor.restore(state.executor);

      logger.info(
        { savedAt: state.savedAt, version: state.version },
        '✅ State restored successfully — resuming from last save',
      );
    } catch (err: any) {
      logger.error(err, 'State restore failed — starting fresh');
    }
  }

  /* ━━━━━━ Market Discovery ━━━━━━ */

   private async refreshMarkets(): Promise<void> {
    try {
      /* Clear dead token cache so resolved markets get re-evaluated */
      this.api.clearDeadTokens();

      const markets = await this.api.fetchMarkets(200);
      if (markets.length === 0) {
        logger.warn('No markets fetched — retrying next cycle');
        this.metrics.increment('api_errors');
        return;
      }

      this.marketInfos = markets.slice(0, this.config.maxMarkets * 3);
      this.lastMarketRefresh = Date.now();
      this.metrics.setGauge('candidate_markets', this.marketInfos.length);
      logger.info(`Tracking ${this.marketInfos.length} candidate markets`);
    } catch (err: any) {
      logger.error(err, 'Market refresh failed');
      this.metrics.increment('api_errors');
    }
  }

  /* ━━━━━━ Market Data Updates ━━━━━━ */

    private async updateMarketData(): Promise<void> {
    let updated = 0;
    let errors = 0;
    let skipped = 0;

    for (const market of this.marketInfos) {
      try {
        const data = await this.api.buildMarketData(market);
        if (!data) { skipped++; continue; }

        this.currentData.set(market.marketId, data);
        this.strategy.onMarketUpdate(data);
        updated++;

        await this.sleep(100);
      } catch (err: any) {
        errors++;
        this.metrics.increment('api_errors');
      }
    }

    this.metrics.setGauge('markets_updated', updated);
    this.metrics.setGauge('markets_skipped', skipped);
    this.metrics.setGauge('dead_tokens', this.api.getDeadTokenCount());

    if (errors > 0) {
      this.metrics.increment('market_update_errors', errors);
    }

    logger.debug(
      { updated, skipped, errors, deadTokens: this.api.getDeadTokenCount() },
      'Market data update complete',
    );
  }

  /* ━━━━━━ Util ━━━━━━ */

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}