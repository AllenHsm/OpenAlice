/**
 * UTA-side runtime context.
 *
 * Separate from Alice's `EngineContext` (`@/core/types.js`) by design —
 * Alice holds the HTTP SDK adapter `UTAManagerSDK` (`resolve()` returns
 * Promise), while UTA holds the in-process `UTAManager` (`resolve()` is
 * synchronous). Sharing the type name caused tsc errors to flow into
 * the wrong process: see ANG-65 for the original four findings.
 *
 * Only three fields are exposed because that's all the UTA HTTP route
 * handlers actually read (verified by grep). If a new route needs
 * anything else off ctx, add it here — not via casting back to Alice's
 * `EngineContext`.
 */

import type { UTAManager } from './domain/trading/uta-manager.js'
import type { FxService } from './domain/trading/fx-service.js'
import type { SnapshotService } from './domain/trading/snapshot/index.js'

/**
 * In-UTA policy hooks the venue-write gate consults. Both read live state
 * (env / config on disk) per call so operator toggles take effect without a
 * UTA restart — the same hot-read discipline as Alice's tool layer.
 */
export interface UTAServicePolicy {
  /** Product-level trading capability mode. */
  mode(): Promise<'lite' | 'readonly' | 'pro'>
  /** Whether AI/agent-initiated pushes may execute against the venue. */
  allowAiTrading(): Promise<boolean>
}

export interface UTAEngineContext {
  utaManager: UTAManager
  fxService: FxService
  /**
   * REQUIRED — a forgotten wiring must fail at COMPILE time, never fail-open
   * at runtime on the live-order path. The real impl lives in
   * `services/uta/src/main.ts`; specs pass a permissive stub.
   */
  policy: UTAServicePolicy
  /**
   * Optional because tests stub it out — when running for real it is
   * always set (see `services/uta/src/main.ts`). Routes that depend on
   * snapshots guard with `if (!ctx.snapshotService) ...` and return
   * gracefully.
   */
  snapshotService?: SnapshotService
}
