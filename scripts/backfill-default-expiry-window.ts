/**
 * One-off backfill script for ds_daos.default_expiry_window.
 *
 * Reads defaultExpiryWindow() from each DAOShip contract where the indexed
 * value is 0 (or NULL) and writes the on-chain value back to the DB.
 *
 * Safe to run against a live indexer: the WHERE guard prevents clobbering
 * values already written by handleGovernanceConfigSet.
 *
 * Run with: npx tsx scripts/backfill-default-expiry-window.ts
 */

import 'dotenv/config';
import { Interface } from 'quais';
import { config } from '../src/config.js';
import { logger } from '../src/utils/logger.js';
import { BlockchainService } from '../src/services/blockchain.js';
import { DatabaseService } from '../src/services/database.js';

const CONCURRENCY = 5;

const daoShipIface = new Interface([
  'function defaultExpiryWindow() view returns (uint32)',
]);

async function main(): Promise<void> {
  const blockchain = new BlockchainService();
  const db = new DatabaseService();

  // Fetch all DAOs where default_expiry_window is 0 or null
  const { data: daos, error } = await (db as any).client
    .from('ds_daos')
    .select('id')
    .or('default_expiry_window.eq.0,default_expiry_window.is.null');

  if (error) throw new Error(`Failed to fetch DAOs: ${error.message}`);
  if (!daos || daos.length === 0) {
    logger.info('No DAOs with default_expiry_window = 0 — nothing to backfill');
    return;
  }

  logger.info({ count: daos.length }, 'DAOs to backfill');

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  // Process in batches of CONCURRENCY
  for (let i = 0; i < daos.length; i += CONCURRENCY) {
    const batch = daos.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (dao: { id: string }) => {
        try {
          const value = await blockchain.callContract(
            dao.id,
            daoShipIface,
            'defaultExpiryWindow',
          );
          const expiryWindow = Number(value);

          if (expiryWindow === 0) {
            logger.debug({ dao: dao.id }, 'Contract returns 0 (fallback mode) — no update needed');
            skipped++;
            return;
          }

          // Guarded update: only write if the current DB value is still 0
          const { error: updateErr } = await (db as any).client
            .from('ds_daos')
            .update({ default_expiry_window: expiryWindow, updated_at: new Date().toISOString() })
            .eq('id', dao.id)
            .or('default_expiry_window.eq.0,default_expiry_window.is.null');

          if (updateErr) {
            logger.warn({ dao: dao.id, error: updateErr.message }, 'Failed to update DAO');
            failed++;
          } else {
            logger.info({ dao: dao.id, defaultExpiryWindow: expiryWindow }, 'Backfilled default_expiry_window');
            updated++;
          }
        } catch (err) {
          logger.warn({ dao: dao.id, error: (err as Error).message }, 'Failed to read contract');
          failed++;
        }
      }),
    );

    // Log rejected promises (shouldn't happen since we catch inside, but safety net)
    for (const r of results) {
      if (r.status === 'rejected') {
        logger.error({ error: r.reason }, 'Unexpected rejection in backfill batch');
        failed++;
      }
    }
  }

  logger.info({ updated, skipped, failed, total: daos.length }, 'Backfill complete');
}

main().catch((err) => {
  logger.error({ err }, 'Backfill script failed');
  process.exit(1);
});
