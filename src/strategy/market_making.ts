import { BaseStrategy } from './base';
import {
  Signal, OrderRequest, MarketData, StrategyContext,
  SerializedStrategyState, SerializedInventory,
} from '../types';
import { logger } from '../utils/logger';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Market Making Strategy — V1.1
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

interface Inventory {
  yesShares: number;
  noShares: number;
  yesCost: number;
  noCost: number;
  realizedPnL: number;
}

interface PriceSnapshot {
  price: number;
  timestamp: number;
}

export class MarketMakingStrategy extends BaseStrategy {
  readonly name = 'market_making';

  private inventory = new Map<string, Inventory>();
  private priceHistory = new Map<string, PriceSnapshot[]>();

  private minVolume = 1_500;
  private minLiquidity = 300;
  private minSpread = 0.004;
  private maxInventoryPerMarket = 60;
  private maxTotalMarkets = 12;
  private inventorySkewFactor = 0.4;
  private volSpreadMultiplier = 2.0;
  private priceHistoryWindow = 60;

  protected override cooldownMs = 30_000;

  override initialize(context: StrategyContext): void {
    super.initialize(context);
    const cfg = context.config;
    if (cfg.minVolume) this.minVolume = cfg.minVolume;
    if (cfg.minLiquidity) this.minLiquidity = cfg.minLiquidity;
    if (cfg.minSpread) this.minSpread = cfg.minSpread;
    if (cfg.maxInventoryPerMarket) this.maxInventoryPerMarket = cfg.maxInventoryPerMarket;
    if (cfg.maxTotalMarkets) this.maxTotalMarkets = cfg.maxTotalMarkets;
    if (cfg.inventorySkewFactor) this.inventorySkewFactor = cfg.inventorySkewFactor;
    if (cfg.volSpreadMultiplier) this.volSpreadMultiplier = cfg.volSpreadMultiplier;
    logger.info({ strategy: this.name }, 'Strategy initialised');
  }

  override onMarketUpdate(data: MarketData): void {
    super.onMarketUpdate(data);
    const hist = this.priceHistory.get(data.marketId) ?? [];
    hist.push({ price: data.midPrice, timestamp: data.timestamp });
    if (hist.length > this.priceHistoryWindow) hist.shift();
    this.priceHistory.set(data.marketId, hist);
  }

  /* ━━━━━━ Signal Generation ━━━━━━ */

  generateSignals(): Signal[] {
    const signals: Signal[] = [];
    let quotedMarkets = 0;

    const sorted = [...this.markets.entries()]
      .filter(([, m]) => m.volume24h >= this.minVolume && m.liquidity >= this.minLiquidity)
      .sort(([, a], [, b]) => (b.ask - b.bid) - (a.ask - a.bid));

    for (const [, market] of sorted) {
      if (quotedMarkets >= this.maxTotalMarkets) break;

      const spread = market.ask - market.bid;
      if (spread < this.minSpread) continue;

      const yesPrice = market.outcomePrices[0];
      if (yesPrice < 0.05 || yesPrice > 0.95) continue;
      if (this.hasRecentSpike(market.marketId)) continue;

      const vol = this.computeVolatility(market.marketId);
      const dynamicMinSpread = Math.max(this.minSpread, vol * this.volSpreadMultiplier);
      if (spread < dynamicMinSpread) continue;

      const inv = this.getInventory(market.marketId);
      const netInventory = inv.yesShares - inv.noShares;
      const halfSpread = spread / 2;

      const normalizedSkew =
        (netInventory / this.maxInventoryPerMarket) *
        halfSpread *
        this.inventorySkewFactor;

      const confidence = Math.min(0.6, 0.3 + spread * 5);

      const yesBuyEdge = halfSpread * 0.6 - normalizedSkew;
      const yesSellEdge = halfSpread * 0.6 + normalizedSkew;

      if (inv.yesShares < this.maxInventoryPerMarket && yesBuyEdge > 0.001) {
        signals.push({ marketId: market.marketId, outcome: 'YES', side: 'BUY', confidence, edge: yesBuyEdge });
      }
      if (inv.yesShares > 0 && yesSellEdge > 0.001) {
        signals.push({ marketId: market.marketId, outcome: 'YES', side: 'SELL', confidence, edge: yesSellEdge });
      }

      const noBuyEdge = halfSpread * 0.6 + normalizedSkew;
      const noSellEdge = halfSpread * 0.6 - normalizedSkew;

      if (inv.noShares < this.maxInventoryPerMarket && noBuyEdge > 0.001) {
        signals.push({ marketId: market.marketId, outcome: 'NO', side: 'BUY', confidence, edge: noBuyEdge });
      }
      if (inv.noShares > 0 && noSellEdge > 0.001) {
        signals.push({ marketId: market.marketId, outcome: 'NO', side: 'SELL', confidence, edge: noSellEdge });
      }

      quotedMarkets++;
    }

    return signals;
  }

  /* ━━━━━━ Pricing & Sizing ━━━━━━ */

  override sizePositions(signals: Signal[]): OrderRequest[] {
    const orders = super.sizePositions(signals);
    const capital = this.context?.wallet.capitalAllocated ?? 0;
    if (capital <= 0) return [];

    return orders.map((order) => {
      const market = this.markets.get(order.marketId);
      if (!market) return order;

      const inv = this.getInventory(order.marketId);
      const netInventory = inv.yesShares - inv.noShares;
      const halfSpread = (market.ask - market.bid) / 2;

      const skew =
        (netInventory / this.maxInventoryPerMarket) *
        halfSpread *
        this.inventorySkewFactor;

      const offset = Math.max(0.001, (market.ask - market.bid) * 0.3);
      let price: number;

      if (order.outcome === 'YES') {
        price = order.side === 'BUY'
          ? market.bid + offset - skew
          : market.ask - offset - skew;
      } else {
        const noBid = 1 - market.ask;
        const noAsk = 1 - market.bid;
        price = order.side === 'BUY'
          ? noBid + offset + skew
          : noAsk - offset + skew;
      }

      price = Number(Math.max(0.01, Math.min(0.99, price)).toFixed(2));

      const relevantShares = order.outcome === 'YES' ? inv.yesShares : inv.noShares;
      const inventoryPenalty = Math.max(0.3, 1 - relevantShares / this.maxInventoryPerMarket);
      const baseSize = Math.max(1, Math.floor((capital * 0.01) / price));
      const adjustedSize = Math.max(1, Math.floor(baseSize * inventoryPenalty));

      return {
        ...order,
        price,
        size: adjustedSize,
        tokenId: order.outcome === 'YES' ? (market.yesTokenId ?? '') : (market.noTokenId ?? ''),
      };
    });
  }

  /* ━━━━━━ Fill Tracking ━━━━━━ */

  override notifyFill(order: OrderRequest): void {
    if (order.strategy !== this.name) return;
    const inv = this.getInventory(order.marketId);
    const fillValue = order.price * order.size;

    if (order.side === 'BUY') {
      if (order.outcome === 'YES') {
        inv.yesShares += order.size;
        inv.yesCost += fillValue;
      } else {
        inv.noShares += order.size;
        inv.noCost += fillValue;
      }
    } else {
      if (order.outcome === 'YES') {
        const sellSize = Math.min(order.size, inv.yesShares);
        if (sellSize <= 0) return;
        const avgCost = inv.yesShares > 0 ? inv.yesCost / inv.yesShares : 0;
        inv.realizedPnL += (order.price - avgCost) * sellSize;
        inv.yesShares -= sellSize;
        inv.yesCost -= avgCost * sellSize;
      } else {
        const sellSize = Math.min(order.size, inv.noShares);
        if (sellSize <= 0) return;
        const avgCost = inv.noShares > 0 ? inv.noCost / inv.noShares : 0;
        inv.realizedPnL += (order.price - avgCost) * sellSize;
        inv.noShares -= sellSize;
        inv.noCost -= avgCost * sellSize;
      }
    }

    this.inventory.set(order.marketId, inv);

    logger.trade({
      strategy: this.name,
      marketId: order.marketId,
      side: order.side,
      outcome: order.outcome,
      price: order.price,
      size: order.size,
      yesShares: inv.yesShares,
      noShares: inv.noShares,
      realizedPnL: Number(inv.realizedPnL.toFixed(4)),
    });
  }

  /* ━━━━━━ Position Management ━━━━━━ */

  managePositions(): void {
    const walletId = this.context?.wallet.walletId ?? 'default';
    for (const [marketId, inv] of this.inventory.entries()) {
      const market = this.markets.get(marketId);
      if (!market) continue;
      if (inv.yesShares > 0) this.evaluateExit(walletId, marketId, inv, 'YES', market);
      if (inv.noShares > 0) this.evaluateExit(walletId, marketId, inv, 'NO', market);
    }
  }

  /* ━━━━━━ V1.1: Serialization ━━━━━━ */

  serialize(): SerializedStrategyState {
    const inventory: SerializedInventory[] = [];
    for (const [marketId, inv] of this.inventory.entries()) {
      if (inv.yesShares > 0 || inv.noShares > 0 || inv.realizedPnL !== 0) {
        inventory.push({ marketId, ...inv });
      }
    }

    const priceHistoryObj: Record<string, PriceSnapshot[]> = {};
    for (const [marketId, hist] of this.priceHistory.entries()) {
      if (hist.length > 0) {
        priceHistoryObj[marketId] = hist;
      }
    }

    return {
      name: this.name,
      inventory,
      priceHistory: priceHistoryObj,
      timestamp: Date.now(),
    };
  }

  restore(state: SerializedStrategyState): void {
    if (state.name !== this.name) {
      logger.warn({ expected: this.name, got: state.name }, 'Strategy name mismatch — skipping restore');
      return;
    }

    /* Restore inventory */
    this.inventory.clear();
    for (const item of state.inventory) {
      this.inventory.set(item.marketId, {
        yesShares: item.yesShares,
        noShares: item.noShares,
        yesCost: item.yesCost,
        noCost: item.noCost,
        realizedPnL: item.realizedPnL,
      });
    }

    /* Restore price history */
    this.priceHistory.clear();
    for (const [marketId, hist] of Object.entries(state.priceHistory)) {
      if (Array.isArray(hist)) {
        this.priceHistory.set(marketId, hist);
      }
    }

    const invCount = this.inventory.size;
    const totalShares = [...this.inventory.values()].reduce(
      (s, i) => s + i.yesShares + i.noShares, 0,
    );
    logger.info(
      { markets: invCount, totalShares, savedAt: new Date(state.timestamp).toISOString() },
      'Strategy state restored',
    );
  }

  getInventorySnapshot(): Map<string, Inventory> {
    return new Map(this.inventory);
  }

  getTotalRealizedPnL(): number {
    let total = 0;
    for (const inv of this.inventory.values()) total += inv.realizedPnL;
    return total;
  }

  /* ━━━━━━ Private Helpers ━━━━━━ */

  private getInventory(marketId: string): Inventory {
    let inv = this.inventory.get(marketId);
    if (!inv) {
      inv = { yesShares: 0, noShares: 0, yesCost: 0, noCost: 0, realizedPnL: 0 };
      this.inventory.set(marketId, inv);
    }
    return inv;
  }

  private evaluateExit(
    walletId: string,
    marketId: string,
    inv: Inventory,
    outcome: 'YES' | 'NO',
    market: MarketData,
  ): void {
    const shares = outcome === 'YES' ? inv.yesShares : inv.noShares;
    if (shares <= 0) return;

    const spread = market.ask - market.bid;
    const yesPrice = market.outcomePrices[0];
    const currentPrice = outcome === 'YES' ? yesPrice : 1 - yesPrice;
    const currentBid = outcome === 'YES' ? market.bid : 1 - market.ask;
    const cost = outcome === 'YES' ? inv.yesCost : inv.noCost;
    const avgCost = shares > 0 ? cost / shares : 0;

    let exitReason: string | undefined;
    let exitSize = 0;

    if (spread < this.minSpread * 0.5) {
      exitReason = 'SPREAD_COLLAPSED'; exitSize = shares;
    }
    if (!exitReason && (yesPrice > 0.95 || yesPrice < 0.05)) {
      exitReason = 'NEAR_RESOLUTION'; exitSize = shares;
    }
    if (!exitReason && shares > this.maxInventoryPerMarket) {
      exitReason = 'INVENTORY_OVERFLOW'; exitSize = shares - this.maxInventoryPerMarket;
    }
    if (!exitReason && avgCost > 0 && currentPrice < avgCost * 0.97) {
      exitReason = 'ADVERSE_MOVE'; exitSize = Math.max(1, Math.floor(shares / 2));
    }

    if (!exitReason || exitSize <= 0) return;

    const exitPrice = Number(Math.max(0.02, currentBid - 0.001).toFixed(2));

    logger.warn(
      { marketId, outcome, reason: exitReason, exitSize, shares, avgCost: avgCost.toFixed(4) },
      `MM EXIT: ${exitReason}`,
    );

    this.pendingExits.push({
      walletId,
      marketId,
      tokenId: outcome === 'YES' ? market.yesTokenId : market.noTokenId,
      outcome,
      side: 'SELL',
      price: exitPrice,
      size: exitSize,
      strategy: this.name,
      timestamp: Date.now(),
    });

    if (outcome === 'YES') {
      inv.yesShares -= exitSize;
      inv.yesCost -= avgCost * exitSize;
    } else {
      inv.noShares -= exitSize;
      inv.noCost -= avgCost * exitSize;
    }
  }

  private computeVolatility(marketId: string): number {
    const hist = this.priceHistory.get(marketId) ?? [];
    if (hist.length < 5) return 0.01;
    const prices = hist.map((h) => h.price);
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i] - prices[i - 1]) / Math.max(0.001, prices[i - 1]));
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
  }

  private hasRecentSpike(marketId: string): boolean {
    const hist = this.priceHistory.get(marketId) ?? [];
    if (hist.length < 5) return false;
    const recent = hist.slice(-5);
    const oldest = recent[0].price;
    const newest = recent[recent.length - 1].price;
    const change = Math.abs(newest - oldest) / Math.max(0.001, oldest);
    return change > 0.03;
  }
}