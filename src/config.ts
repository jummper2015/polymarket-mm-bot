import dotenv from 'dotenv';
dotenv.config();

export interface BotConfig {
  mode: 'paper' | 'live';

  clobApiUrl: string;
  gammaApiUrl: string;

  privateKey: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  chainId: number;

  initialCapital: number;
  maxMarkets: number;
  pollIntervalMs: number;

  strategyParams: Record<string, number>;

  /* V1.1 */
  stateDir: string;
  stateSaveIntervalMs: number;
  healthPort: number;
  logDir: string;
  logMaxFiles: number;
  apiRateLimitPerSecond: number;
  apiMaxRetries: number;
  apiRetryBaseMs: number;
}

function env(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? Number(v) : fallback;
}

export function loadConfig(): BotConfig {
  const mode = env('MODE', 'paper') as 'paper' | 'live';

  if (mode === 'live') {
    const required = ['PRIVATE_KEY', 'API_KEY', 'API_SECRET', 'API_PASSPHRASE'];
    for (const key of required) {
      if (!process.env[key]) {
        throw new Error(`Missing required env var for live mode: ${key}`);
      }
    }
  }

  return {
    mode,
    clobApiUrl: env('CLOB_API_URL', 'https://clob.polymarket.com'),
    gammaApiUrl: env('GAMMA_API_URL', 'https://gamma-api.polymarket.com'),
    privateKey: env('PRIVATE_KEY'),
    apiKey: env('API_KEY'),
    apiSecret: env('API_SECRET'),
    apiPassphrase: env('API_PASSPHRASE'),
    chainId: envNum('CHAIN_ID', 137),
    initialCapital: envNum('INITIAL_CAPITAL', 500),
    maxMarkets: envNum('MAX_MARKETS', 8),
    pollIntervalMs: envNum('POLL_INTERVAL_MS', 15000),
    strategyParams: {
      minVolume: envNum('MIN_VOLUME', 1500),
      minLiquidity: envNum('MIN_LIQUIDITY', 300),
      minSpread: envNum('MIN_SPREAD', 0.004),
      maxInventoryPerMarket: envNum('MAX_INVENTORY_PER_MARKET', 60),
      maxTotalMarkets: envNum('MAX_MARKETS', 8),
      inventorySkewFactor: envNum('INVENTORY_SKEW_FACTOR', 0.4),
      volSpreadMultiplier: envNum('VOL_SPREAD_MULTIPLIER', 2.0),
    },
    stateDir: env('STATE_DIR', './data'),
    stateSaveIntervalMs: envNum('STATE_SAVE_INTERVAL_MS', 30_000),
    healthPort: envNum('HEALTH_PORT', 3100),
    logDir: env('LOG_DIR', './logs'),
    logMaxFiles: envNum('LOG_MAX_FILES', 14),
    apiRateLimitPerSecond: envNum('API_RATE_LIMIT_PER_SECOND', 10),
    apiMaxRetries: envNum('API_MAX_RETRIES', 5),
    apiRetryBaseMs: envNum('API_RETRY_BASE_MS', 1000),
  };
}