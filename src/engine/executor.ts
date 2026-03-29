import { OrderRequest, Fill, MarketData, SerializedExecutorState } from '../types';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Executor Interface — V1.1 with serialization
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export interface Executor {
  submitOrders(orders: OrderRequest[]): Promise<void>;
  cancelOrders(marketId?: string): Promise<void>;
  checkFills(marketData: Map<string, MarketData>): Fill[];
  getOpenOrderCount(): number;
  printStatus(marketData: Map<string, MarketData>): void;

  /* V1.1 */
  serialize(): SerializedExecutorState;
  restore(state: SerializedExecutorState): void;
}