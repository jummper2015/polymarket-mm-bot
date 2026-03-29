/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Shared types — V1.1
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export interface MarketInfo {
  marketId: string;
  conditionId: string;
  question: string;
  slug: string;
  yesTokenId: string;
  noTokenId: string;
  active: boolean;
  endDate: string;
}

export interface MarketData {
  marketId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  outcomePrices: number[];
  bid: number;
  ask: number;
  midPrice: number;
  spread: number;
  volume24h: number;
  liquidity: number;
  timestamp: number;
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface Signal {
  marketId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  confidence: number;
  edge: number;
}

export interface OrderRequest {
  id?: string;
  walletId: string;
  marketId: string;
  tokenId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  strategy: string;
  timestamp?: number;
}

export interface Fill {
  order: OrderRequest;
  fillPrice: number;
  fillSize: number;
  timestamp: number;
}

export interface WalletInfo {
  walletId: string;
  capitalAllocated: number;
}

export interface StrategyContext {
  wallet: WalletInfo;
  config: Record<string, any>;
}

/* ── V1.1: Serializable state interfaces ── */

export interface SerializedInventory {
  marketId: string;
  yesShares: number;
  noShares: number;
  yesCost: number;
  noCost: number;
  realizedPnL: number;
}

export interface SerializedStrategyState {
  name: string;
  inventory: SerializedInventory[];
  priceHistory: Record<string, { price: number; timestamp: number }[]>;
  timestamp: number;
}

export interface SerializedExecutorState {
  cash: number;
  initialCash: number;
  positions: Record<string, {
    yesShares: number;
    noShares: number;
    yesCost: number;
    noCost: number;
  }>;
  fillCount: number;
  timestamp: number;
}

export interface BotState {
  version: string;
  mode: string;
  strategy: SerializedStrategyState;
  executor: SerializedExecutorState;
  metrics: Record<string, number>;
  savedAt: string;
}