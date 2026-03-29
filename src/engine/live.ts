import { Executor } from './executor';
import { OrderRequest, Fill, MarketData, SerializedExecutorState } from '../types';
import { BotConfig } from '../config';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';

export class LiveExecutor implements Executor {
  private clobClient: any = null;
  private openOrderIds: string[] = [];
  private fillCount = 0;

  constructor(private config: BotConfig) {}

  async initialize(): Promise<void> {
    await withRetry(
      async () => {
        const { ClobClient } = await import('@polymarket/clob-client');
        const { Wallet } = await import('ethers');

        const wallet = new Wallet(this.config.privateKey);
        this.clobClient = new ClobClient(
          this.config.clobApiUrl,
          this.config.chainId,
          wallet,
          {
            key: this.config.apiKey,
            secret: this.config.apiSecret,
            passphrase: this.config.apiPassphrase,
          },
        );
        logger.info('Live executor initialised');
      },
      { maxRetries: 3, baseDelayMs: 2000, label: 'live_init' },
    );
  }

  async submitOrders(orders: OrderRequest[]): Promise<void> {
    if (!this.clobClient) throw new Error('Live executor not initialised');

    for (const order of orders) {
      try {
        const signedOrder = await this.clobClient.createOrder({
          tokenID: order.tokenId,
          price: order.price,
          size: order.size,
          side: order.side,
          feeRateBps: 0,
          nonce: 0,
          expiration: 0,
        });

        const resp: any = await withRetry(
          () => this.clobClient.postOrder(signedOrder, 'GTC'),
          { maxRetries: 2, baseDelayMs: 1000, label: 'postOrder' },
        );

        if (resp?.orderID) {
          order.id = resp.orderID;
          this.openOrderIds.push(resp.orderID);
          logger.info(
            {
              orderId: resp.orderID,
              side: order.side,
              outcome: order.outcome,
              price: order.price,
              size: order.size,
            },
            '🔴 LIVE ORDER PLACED',
          );
        }
      } catch (err: any) {
        logger.error(
          { marketId: order.marketId, error: err.message },
          'Failed to place live order',
        );
      }
    }
  }

  async cancelOrders(_marketId?: string): Promise<void> {
    if (!this.clobClient) return;
    try {
      await withRetry(
        () => this.clobClient.cancelAll(),
        { maxRetries: 3, baseDelayMs: 1000, label: 'cancelAll' },
      );
      this.openOrderIds = [];
      logger.info('Live: cancelled all open orders');
    } catch (err: any) {
      logger.error(err, 'Failed to cancel orders');
    }
  }

  checkFills(_marketData: Map<string, MarketData>): Fill[] {
    return [];
  }

  getOpenOrderCount(): number {
    return this.openOrderIds.length;
  }

  printStatus(_marketData: Map<string, MarketData>): void {
    logger.info(
      { openOrders: this.openOrderIds.length, fills: this.fillCount },
      '🔴 LIVE STATUS',
    );
  }

  serialize(): SerializedExecutorState {
    return {
      cash: 0,
      initialCash: 0,
      positions: {},
      fillCount: this.fillCount,
      timestamp: Date.now(),
    };
  }

  restore(state: SerializedExecutorState): void {
    this.fillCount = state.fillCount ?? 0;
    logger.info({ fillCount: this.fillCount }, 'Live executor state restored');
  }
}