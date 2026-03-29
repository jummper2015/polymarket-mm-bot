import {
  MarketData, Signal, OrderRequest, StrategyContext,
  SerializedStrategyState,
} from '../types';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Base Strategy — V1.1 with serialization
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export abstract class BaseStrategy {
  abstract readonly name: string;

  protected markets = new Map<string, MarketData>();
  protected context: StrategyContext | null = null;
  protected pendingExits: OrderRequest[] = [];
  protected cooldownMs = 30_000;
  private lastRunTs = 0;

  initialize(context: StrategyContext): void {
    this.context = context;
  }

  onMarketUpdate(data: MarketData): void {
    this.markets.set(data.marketId, data);
  }

  canRun(): boolean {
    return Date.now() - this.lastRunTs >= this.cooldownMs;
  }

  markRun(): void {
    this.lastRunTs = Date.now();
  }

  sizePositions(signals: Signal[]): OrderRequest[] {
    const walletId = this.context?.wallet.walletId ?? 'default';
    return signals.map((s) => {
      const market = this.markets.get(s.marketId);
      return {
        walletId,
        marketId: s.marketId,
        tokenId: s.outcome === 'YES'
          ? (market?.yesTokenId ?? '')
          : (market?.noTokenId ?? ''),
        outcome: s.outcome,
        side: s.side,
        price: 0,
        size: 0,
        strategy: this.name,
        timestamp: Date.now(),
      };
    });
  }

  abstract generateSignals(): Signal[];
  abstract managePositions(): void;

  notifyFill(_order: OrderRequest): void {}

  getPendingExits(): OrderRequest[] {
    const exits = [...this.pendingExits];
    this.pendingExits = [];
    return exits;
  }

  /* V1.1: Serialization */
  abstract serialize(): SerializedStrategyState;
  abstract restore(state: SerializedStrategyState): void;
}