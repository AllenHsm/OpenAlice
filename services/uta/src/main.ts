/**
 * UTA service entry — co-located v1.
 *
 * Owns the trading domain (broker connections, git-like approval state,
 * snapshots, FX). Bind 127.0.0.1-only — Alice talks to UTA via
 * `OPENALICE_UTA_URL`, never exposed externally.
 *
 * Startup path is also the reload path: when broker config changes, Alice
 * touches `data/control/restart-uta.flag`, Guardian SIGTERMs this process
 * and respawns. There is no in-process hot-reload code path.
 */

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createAppLogger } from '@/core/app-logger.js'
import { logsPath } from '@/core/paths.js'
import { createRequestLog, type RequestLogVariables } from './http/request-log.js'
import { loadConfig, readUTAsConfig, purgeEphemeralUTAs, type UTAConfig } from '@/core/config.js'
import { parseDuration } from '@/core/duration.js'
import { createEventLog } from '@/core/event-log.js'
import { ToolCenter } from '@/core/tool-center.js'
import {
  UTAManager,
  createSnapshotService,
  createSnapshotScheduler,
} from './domain/trading/index.js'
import { FxService } from './domain/trading/fx-service.js'
import {
  getSDKExecutor,
  buildRouteMap,
  SDKCurrencyClient,
} from '@/domain/market-data/client/typebb/index.js'
import type { CurrencyClientLike } from '@/domain/market-data/client/types.js'
import { buildSDKCredentials } from '@/domain/market-data/credential-map.js'
import { startOrderSyncPoller } from './domain/trading/order-sync-poller.js'
import { buildKeylessDataUTAs } from './domain/trading/keyless-data-sources.js'
import { createTradingRoutes } from './http/routes-trading.js'
import { createSimulatorRoutes } from './http/routes-simulator.js'
import type { UTAEngineContext } from './types.js'

const UTA_PORT = Number(process.env['OPENALICE_UTA_PORT'] ?? 47333)
const CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000  // 6h

// Module-scope so both main() and the top-level fatal handler write to the
// same rotating uta.log sink. mirrorConsole (default) keeps `pnpm dev` output.
const log = createAppLogger({ file: logsPath('uta.log'), name: 'uta' })

async function main(): Promise<void> {
  const startedAt = new Date().toISOString()
  log.info('bootstrap', { startedAt })

  // Surface outbound-proxy config at startup so a user behind a proxy can
  // confirm UTA saw it — CCXT exchange instances are bridged onto it per
  // broker (see CcxtBroker.applyEnvProxy / issue #384). Credentials in the
  // URL (user:pass@) are redacted.
  const outboundProxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy
  if (outboundProxy) {
    log.info('outbound proxy detected — bridging into CCXT exchanges', {
      proxy: outboundProxy.replace(/\/\/[^@/]*@/, '//***@'),
    })
  }

  const config = await loadConfig()

  // ==================== Trading-only dependencies ====================
  // UTA needs eventLog (UTAManager journaling) + toolCenter (CCXT tool
  // registration). Other infra Alice has (agentCenter, connectorCenter,
  // listenerRegistry, ...) is not used by trading routes.

  const eventLog = await createEventLog()
  const toolCenter = new ToolCenter()
  const utaManager = new UTAManager({ eventLog, toolCenter })

  // ==================== Account init (with ephemeral purge) ====================

  const survivors = await purgeEphemeralUTAs(await readUTAsConfig())
  const userIds = new Set(survivors.map((u) => u.id))
  const dataUTAs: UTAConfig[] = buildKeylessDataUTAs(config.trading.keylessDataSources, userIds)
  if (dataUTAs.length > 0) {
    log.info('keyless data sources enabled', { sources: dataUTAs.map((u) => u.id) })
  }

  for (const accCfg of [...dataUTAs, ...survivors]) {
    if (accCfg.enabled === false) continue
    // One account's init must never abort the whole bootstrap (broker
    // construction is sync; the connection is async + health-tracked, so this
    // only guards genuinely-broken config — but a built-in data UTA throwing
    // would otherwise take the user's real UTAs down with it).
    try {
      await utaManager.initUTA(accCfg)
    } catch (err) {
      log.warn('failed to init UTA', { id: accCfg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  utaManager.registerCcxtToolsIfNeeded()

  // ==================== FX (single-asset-class slice of market-data) ====================
  // UTA needs only the currency client for USD conversion in
  // /api/trading/equity. The other market-data clients stay in Alice.

  const { providers } = config.marketData
  const executor = getSDKExecutor()
  const routeMap = buildRouteMap()
  const credentials = buildSDKCredentials(config.marketData.providerKeys)
  const currencyClient: CurrencyClientLike = new SDKCurrencyClient(executor, 'currency', providers.currency, credentials, routeMap)
  const fxService = new FxService(currencyClient, undefined, config.marketData.hub)
  utaManager.setFxService(fxService)

  // ==================== Snapshots ====================

  const snapshotService = createSnapshotService({ utaManager, eventLog })
  utaManager.setSnapshotHooks({
    onPostPush: (id) => { snapshotService.takeSnapshot(id, 'post-push') },
    onPostReject: (id) => { snapshotService.takeSnapshot(id, 'post-reject') },
  })

  const snapshotScheduler = createSnapshotScheduler({ snapshotService, config: config.snapshot })
  await snapshotScheduler.start()
  if (config.snapshot.enabled) {
    log.info('snapshot scheduler started', { every: config.snapshot.every })
  }

  // ==================== Order-sync poller ====================
  // Fast lane (10s): fill/cancel detection for known pending orders —
  // broker calls only when something is actually pending. Slow lane
  // (config.trading.observeExternalOrdersEvery, default 15m): list open
  // orders to catch ones placed outside Alice.

  const observeRaw = config.trading.observeExternalOrdersEvery
  const observeIntervalMs = observeRaw === 'off' ? 0 : parseDuration(observeRaw)
  if (observeIntervalMs === null) {
    log.warn('trading.json observeExternalOrdersEvery is not a duration (e.g. "15m") — falling back to 15m', { value: observeRaw })
  }
  startOrderSyncPoller(() => utaManager.resolve(), { observeIntervalMs: observeIntervalMs ?? 15 * 60_000 })
  log.info('order-sync poller started', {
    pendingLaneMs: 10_000,
    externalObservation: observeRaw === 'off' ? 'off' : observeRaw,
  })

  // ==================== Catalog refresh ====================
  // Brokers that cache catalog (Alpaca / CCXT / Mock) need periodic refresh.
  // No-op for brokers that query server-side. Lifted from src/main.ts:460-470.

  const catalogRefreshTimer = setInterval(() => {
    for (const uta of utaManager.resolve()) {
      uta.refreshCatalog().catch((err) => {
        log.warn('catalog-refresh failed', { id: uta.id, error: err instanceof Error ? err.message : String(err) })
      })
    }
  }, CATALOG_REFRESH_MS)
  catalogRefreshTimer.unref?.()

  // ==================== HTTP app ====================

  const app = new Hono<{ Variables: RequestLogVariables }>()

  // Access log — mounted first so every request (health, trading, 404s) gets a
  // correlation id and one structured `http` event. Reads Alice's x-request-id
  // when present so a single id threads Alice→UTA.
  app.use('*', createRequestLog(log))

  // Health probe — used by Guardian readiness gate and Alice BFF supervisor.
  app.get('/__uta/health', (c) => c.json({
    ok: true,
    startedAt,
    utas: utaManager.listUTAs().length,
  }))

  // Trading routes — UTA-side handlers, narrowly typed via UTAEngineContext.
  // Only utaManager / fxService / snapshotService are exposed because that's
  // all the route layer reads. See services/uta/src/types.ts and ANG-65 for
  // history (this used to be cast through Alice's EngineContext).
  const tradingCtx: UTAEngineContext = {
    utaManager,
    fxService,
    snapshotService,
  }
  app.route('/api/trading', createTradingRoutes(tradingCtx))
  // Simulator endpoints — MockBroker-only god-view operations the
  // /dev/simulator UI tab drives. Lives next to the trading routes
  // because both need direct access to UTA's in-process MockBroker
  // instances. Alice BFF proxies `/api/simulator/*` to here.
  app.route('/api/simulator', createSimulatorRoutes(tradingCtx))

  // ==================== Bind + shutdown ====================

  const server = serve({
    fetch: app.fetch,
    port: UTA_PORT,
    hostname: '127.0.0.1',
  })
  log.info('listening', { url: `http://127.0.0.1:${UTA_PORT}` })

  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    log.info('shutdown', { signal })
    clearInterval(catalogRefreshTimer)
    snapshotScheduler.stop()
    server.close()
    await utaManager.closeAll().catch(() => { /* swallow during shutdown */ })
    await eventLog.close().catch(() => { /* swallow during shutdown */ })
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}

main().catch((err) => {
  log.error('fatal', { error: err instanceof Error ? err : String(err) })
  process.exit(1)
})
