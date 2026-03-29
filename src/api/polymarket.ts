import axios, { AxiosInstance } from 'axios';
import { BotConfig } from '../config';
import { MarketInfo, MarketData, OrderBook, OrderBookLevel } from '../types';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';
import { RateLimiter } from '../utils/rate_limiter';

export class PolymarketAPI {
  private gamma: AxiosInstance;
  private clob: AxiosInstance;
  private rateLimiter: RateLimiter;
  private retryConfig: { maxRetries: number; baseDelayMs: number };

  /** Track token IDs that return 404 so we stop wasting requests */
  private deadTokens = new Set<string>();

  constructor(private config: BotConfig) {
    this.gamma = axios.create({
      baseURL: config.gammaApiUrl,
      timeout: 15_000,
    });
    this.clob = axios.create({
      baseURL: config.clobApiUrl,
      timeout: 15_000,
    });
    this.rateLimiter = new RateLimiter(
      config.apiRateLimitPerSecond,
      config.apiRateLimitPerSecond,
    );
    this.retryConfig = {
      maxRetries: config.apiMaxRetries,
      baseDelayMs: config.apiRetryBaseMs,
    };
  }

  /* ── Market Discovery ── */

  async fetchMarkets(limit = 100): Promise<MarketInfo[]> {
    return withRetry(
      async () => {
        await this.rateLimiter.acquire();
        const resp = await this.gamma.get('/markets', {
          params: {
            limit,
            active: true,
            closed: false,
            order: 'volume24hr',
            ascending: false,
          },
        });

        const raw: any[] = resp.data;
        const markets: MarketInfo[] = [];

        for (const m of raw) {
          try {
            const tokenIds = this.parseJsonField(m.clobTokenIds);
            if (!tokenIds || tokenIds.length < 2) continue;

            markets.push({
              marketId: m.conditionId ?? m.id,
              conditionId: m.conditionId ?? m.id,
              question: m.question ?? '',
              slug: m.slug ?? '',
              yesTokenId: tokenIds[0],
              noTokenId: tokenIds[1],
              active: m.active ?? true,
              endDate: m.endDate ?? '',
            });
          } catch {
            continue;
          }
        }

        logger.info(`Fetched ${markets.length} active markets`);
        return markets;
      },
      {
        ...this.retryConfig,
        label: 'fetchMarkets',
        isNonRetryable: (e) => e?.response?.status === 400,
      },
    );
  }

  /* ── Order Book ── */

  async fetchOrderBook(tokenId: string): Promise<OrderBook | null> {
    /* Skip tokens that we already know are dead */
    if (this.deadTokens.has(tokenId)) {
      return null;
    }

    try {
      await this.rateLimiter.acquire();
      return await withRetry(
        async () => {
          const resp = await this.clob.get('/book', {
            params: { token_id: tokenId },
          });
          return {
            bids: this.parseLevels(resp.data.bids),
            asks: this.parseLevels(resp.data.asks),
          };
        },
        {
          ...this.retryConfig,
          maxRetries: 2,
          label: `book:${tokenId.slice(0, 8)}`,
          /* Don't retry 404 or 400 — they won't resolve themselves */
          isNonRetryable: (e) => {
            const status = e?.response?.status;
            return status === 404 || status === 400;
          },
        },
      );
    } catch (err: any) {
      const status = err?.response?.status;

      if (status === 404) {
        /* Mark this token as dead so we never request it again */
        this.deadTokens.add(tokenId);
        logger.debug(
          { tokenId: tokenId.slice(0, 12) },
          'Token not found on CLOB — marked as dead, will skip in future',
        );
      }

      return null;
    }
  }

  /* ── Build MarketData ── */

  async buildMarketData(market: MarketInfo): Promise<MarketData | null> {
    /* Skip if we already know this market's tokens are dead */
    if (this.deadTokens.has(market.yesTokenId)) {
      return null;
    }

    const book = await this.fetchOrderBook(market.yesTokenId);
    if (!book) return null;

    const bestBid = book.bids.length > 0 ? book.bids[0].price : 0;
    const bestAsk = book.asks.length > 0 ? book.asks[0].price : 1;

    /* Skip markets with empty books */
    if (bestBid === 0 && bestAsk === 1) {
      return null;
    }

    const mid = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;

    const bidLiquidity = book.bids.reduce((s, l) => s + l.price * l.size, 0);
    const askLiquidity = book.asks.reduce((s, l) => s + l.price * l.size, 0);
    const totalLiquidity = bidLiquidity + askLiquidity;

    let volume24h = 0;
    try {
      await this.rateLimiter.acquire();
      const resp = await this.gamma.get(`/markets/${market.conditionId}`);
      volume24h = parseFloat(resp.data.volume24hr ?? resp.data.volume ?? '0');
    } catch {
      volume24h = totalLiquidity * 10;
    }

    return {
      marketId: market.marketId,
      question: market.question,
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
      outcomePrices: [mid, 1 - mid],
      bid: bestBid,
      ask: bestAsk,
      midPrice: mid,
      spread,
      volume24h,
      liquidity: totalLiquidity,
      timestamp: Date.now(),
    };
  }

  /** Clear dead tokens cache (called on market refresh) */
  clearDeadTokens(): void {
    if (this.deadTokens.size > 0) {
      logger.debug(`Cleared ${this.deadTokens.size} dead tokens from cache`);
      this.deadTokens.clear();
    }
  }

  /** How many tokens are currently blacklisted */
  getDeadTokenCount(): number {
    return this.deadTokens.size;
  }

  /* ── Helpers ── */

  private parseJsonField(raw: any): string[] | null {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch {
        return raw.split(',').map((s: string) => s.trim());
      }
    }
    return null;
  }

  private parseLevels(raw: any[]): OrderBookLevel[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((l) => ({
        price: parseFloat(l.price),
        size: parseFloat(l.size),
      }))
      .filter((l) => !isNaN(l.price) && !isNaN(l.size))
      .sort((a, b) => b.price - a.price);
  }
}