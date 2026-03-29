import { Executor } from './executor';
import { OrderRequest, Fill, MarketData, SerializedExecutorState } from '../types';
import { logger } from '../utils/logger';

interface Position {
  yesShares: number;
  noShares: number;
  yesCost: number;
  noCost: number;
}

export class PaperExecutor implements Executor {
  private cash: number;
  private initialCash: number;
  private openOrders: OrderRequest[] = [];
  private fillCount = 0;
  private positions = new Map<string, Position>();
  private cycleCount = 0;

  constructor(initialCapital: number) {
    this.cash = initialCapital;
    this.initialCash = initialCapital;
  }

  async submitOrders(orders: OrderRequest[]): Promise<void> {
    for (const order of orders) {
      if (order.side === 'BUY') {
        const cost = order.price * order.size;
        if (cost > this.cash) continue;
      } else {
        const pos = this.positions.get(order.marketId);
        const shares = order.outcome === 'YES'
          ? (pos?.yesShares ?? 0)
          : (pos?.noShares ?? 0);
        if (order.size > shares) continue;
      }

      order.id = `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      order.timestamp = Date.now();
      this.openOrders.push(order);
    }
  }

  async cancelOrders(marketId?: string): Promise<void> {
    if (marketId) {
      this.openOrders = this.openOrders.filter((o) => o.marketId !== marketId);
    } else {
      this.openOrders = [];
    }
  }

  checkFills(marketData: Map<string, MarketData>): Fill[] {
    const newFills: Fill[] = [];
    const remaining: OrderRequest[] = [];

    for (const order of this.openOrders) {
      const data = marketData.get(order.marketId);
      if (!data) {
        remaining.push(order);
        continue;
      }

      const fillResult = this.evaluateFill(order, data);

      if (fillResult.filled) {
        const fill: Fill = {
          order,
          fillPrice: fillResult.price,
          fillSize: order.size,
          timestamp: Date.now(),
        };
        newFills.push(fill);
        this.fillCount++;
        this.applyFill(fill);
      } else {
        remaining.push(order);
      }
    }

    this.openOrders = remaining;
    return newFills;
  }

  /**
   * Realistic fill simulation for paper trading.
   *
   * A market maker's limit order gets filled when:
   *   1. GUARANTEED: The market price crosses through our level
   *   2. PROBABILISTIC: Our order improves the best bid/ask and
   *      a counterparty takes our liquidity
   *
   * We model (2) with a probability that increases when:
   *   - Our price is closer to the midpoint (more attractive)
   *   - The order has been resting longer (more time for someone to trade)
   */
  private evaluateFill(
    order: OrderRequest,
    data: MarketData,
  ): { filled: boolean; price: number } {
    const mid = data.midPrice;
    const bid = data.bid;
    const ask = data.ask;
    const spread = ask - bid;

    if (order.outcome === 'YES') {
      if (order.side === 'BUY') {
        /* ── BUY YES ── */

        /* Guaranteed fill: market ask dropped to or below our price */
        if (ask > 0 && ask <= order.price) {
          return { filled: true, price: ask };
        }

        /* Probabilistic fill: our bid is inside the spread */
        if (order.price > bid && order.price < ask && spread > 0) {
          const distanceToMid = Math.abs(order.price - mid);
          const halfSpread = spread / 2;

          /* Closer to mid = higher fill probability */
          const priceAttractiveness = Math.max(0, 1 - distanceToMid / halfSpread);

          /* Older orders are more likely to have been filled */
          const ageMs = Date.now() - (order.timestamp ?? Date.now());
          const ageFactor = Math.min(1, ageMs / 60_000); // ramps up over 1 min

          /* Base fill probability: ~15-40% per check depending on position */
          const fillProb = 0.15 + priceAttractiveness * 0.25 + ageFactor * 0.10;

          if (Math.random() < fillProb) {
            /* Fill at our limit price (realistic for resting limit orders) */
            return { filled: true, price: order.price };
          }
        }

        return { filled: false, price: 0 };

      } else {
        /* ── SELL YES ── */

        /* Guaranteed fill: market bid rose to or above our price */
        if (bid > 0 && bid >= order.price) {
          return { filled: true, price: bid };
        }

        /* Probabilistic fill: our ask is inside the spread */
        if (order.price < ask && order.price > bid && spread > 0) {
          const distanceToMid = Math.abs(order.price - mid);
          const halfSpread = spread / 2;
          const priceAttractiveness = Math.max(0, 1 - distanceToMid / halfSpread);
          const ageMs = Date.now() - (order.timestamp ?? Date.now());
          const ageFactor = Math.min(1, ageMs / 60_000);
          const fillProb = 0.15 + priceAttractiveness * 0.25 + ageFactor * 0.10;

          if (Math.random() < fillProb) {
            return { filled: true, price: order.price };
          }
        }

        return { filled: false, price: 0 };
      }

    } else {
      /* ── NO token: derive prices from YES book ── */
      const noBid = 1 - ask;
      const noAsk = 1 - bid;
      const noMid = 1 - mid;
      const noSpread = noAsk - noBid;

      if (order.side === 'BUY') {
        if (noAsk > 0 && noAsk <= order.price) {
          return { filled: true, price: noAsk };
        }

        if (order.price > noBid && order.price < noAsk && noSpread > 0) {
          const distanceToMid = Math.abs(order.price - noMid);
          const halfSpread = noSpread / 2;
          const priceAttractiveness = Math.max(0, 1 - distanceToMid / halfSpread);
          const ageMs = Date.now() - (order.timestamp ?? Date.now());
          const ageFactor = Math.min(1, ageMs / 60_000);
          const fillProb = 0.15 + priceAttractiveness * 0.25 + ageFactor * 0.10;

          if (Math.random() < fillProb) {
            return { filled: true, price: order.price };
          }
        }

        return { filled: false, price: 0 };

      } else {
        if (noBid > 0 && noBid >= order.price) {
          return { filled: true, price: noBid };
        }

        if (order.price < noAsk && order.price > noBid && noSpread > 0) {
          const distanceToMid = Math.abs(order.price - noMid);
          const halfSpread = noSpread / 2;
          const priceAttractiveness = Math.max(0, 1 - distanceToMid / halfSpread);
          const ageMs = Date.now() - (order.timestamp ?? Date.now());
          const ageFactor = Math.min(1, ageMs / 60_000);
          const fillProb = 0.15 + priceAttractiveness * 0.25 + ageFactor * 0.10;

          if (Math.random() < fillProb) {
            return { filled: true, price: order.price };
          }
        }

        return { filled: false, price: 0 };
      }
    }
  }

  getOpenOrderCount(): number {
    return this.openOrders.length;
  }

  printStatus(marketData: Map<string, MarketData>): void {
    this.cycleCount++;
    if (this.cycleCount % 4 !== 0) return;

    let unrealizedPnL = 0;
    const posData: any[] = [];

    for (const [marketId, pos] of this.positions.entries()) {
      const data = marketData.get(marketId);
      if (!data) continue;

      const yesMid = data.midPrice;
      const noMid = 1 - yesMid;

      if (pos.yesShares > 0) {
        const avgCost = pos.yesCost / pos.yesShares;
        const uPnL = (yesMid - avgCost) * pos.yesShares;
        unrealizedPnL += uPnL;
        posData.push({
          market: marketId.slice(0, 12) + '…',
          outcome: 'YES',
          shares: pos.yesShares,
          avgCost: avgCost.toFixed(3),
          current: yesMid.toFixed(3),
          uPnL: uPnL.toFixed(2),
        });
      }
      if (pos.noShares > 0) {
        const avgCost = pos.noCost / pos.noShares;
        const uPnL = (noMid - avgCost) * pos.noShares;
        unrealizedPnL += uPnL;
        posData.push({
          market: marketId.slice(0, 12) + '…',
          outcome: 'NO',
          shares: pos.noShares,
          avgCost: avgCost.toFixed(3),
          current: noMid.toFixed(3),
          uPnL: uPnL.toFixed(2),
        });
      }
    }

    const totalPnL = this.cash + unrealizedPnL - this.initialCash;

    console.log('\n' + '═'.repeat(60));
    console.log(' 📊 PAPER TRADING STATUS');
    console.log('═'.repeat(60));
    console.log(` 💰 Cash:          $${this.cash.toFixed(2)}`);
    console.log(` 📈 Unrealized:    $${unrealizedPnL.toFixed(2)}`);
    console.log(` 💵 Total P&L:     $${totalPnL.toFixed(2)} (${((totalPnL / this.initialCash) * 100).toFixed(2)}%)`);
    console.log(` 📋 Open Orders:   ${this.openOrders.length}`);
    console.log(` ✅ Total Fills:   ${this.fillCount}`);
    console.log(` 🔄 Cycles:        ${this.cycleCount}`);
    if (posData.length > 0) logger.table(posData, 'POSITIONS');
    console.log('═'.repeat(60) + '\n');
  }

  /* ━━━━━━ Persistence ━━━━━━ */

  serialize(): SerializedExecutorState {
    const positions: Record<string, any> = {};
    for (const [k, v] of this.positions.entries()) {
      if (v.yesShares > 0 || v.noShares > 0) {
        positions[k] = { ...v };
      }
    }
    return {
      cash: this.cash,
      initialCash: this.initialCash,
      positions,
      fillCount: this.fillCount,
      timestamp: Date.now(),
    };
  }

  restore(state: SerializedExecutorState): void {
    this.cash = state.cash;
    this.initialCash = state.initialCash;
    this.fillCount = state.fillCount;

    this.positions.clear();
    for (const [marketId, pos] of Object.entries(state.positions)) {
      const p = pos as any;
      this.positions.set(marketId, {
        yesShares: p.yesShares ?? 0,
        noShares: p.noShares ?? 0,
        yesCost: p.yesCost ?? 0,
        noCost: p.noCost ?? 0,
      });
    }

    logger.info(
      { cash: this.cash.toFixed(2), fillCount: this.fillCount, positions: this.positions.size },
      'Paper executor state restored',
    );
  }

  /* ── Internal ── */

  private applyFill(fill: Fill): void {
    const { order } = fill;
    const pos = this.getPosition(order.marketId);
    const value = fill.fillPrice * fill.fillSize;

    if (order.side === 'BUY') {
      this.cash -= value;
      if (order.outcome === 'YES') {
        pos.yesShares += fill.fillSize;
        pos.yesCost += value;
      } else {
        pos.noShares += fill.fillSize;
        pos.noCost += value;
      }
    } else {
      this.cash += value;
      if (order.outcome === 'YES') {
        const avgCost = pos.yesShares > 0 ? pos.yesCost / pos.yesShares : 0;
        pos.yesShares -= fill.fillSize;
        pos.yesCost -= avgCost * fill.fillSize;
      } else {
        const avgCost = pos.noShares > 0 ? pos.noCost / pos.noShares : 0;
        pos.noShares -= fill.fillSize;
        pos.noCost -= avgCost * fill.fillSize;
      }
    }

    logger.trade({
      executor: 'paper',
      side: order.side,
      outcome: order.outcome,
      price: fill.fillPrice,
      size: fill.fillSize,
      cash: Number(this.cash.toFixed(2)),
      marketId: order.marketId,
    });
  }

  private getPosition(marketId: string): Position {
    let pos = this.positions.get(marketId);
    if (!pos) {
      pos = { yesShares: 0, noShares: 0, yesCost: 0, noCost: 0 };
      this.positions.set(marketId, pos);
    }
    return pos;
  }
}