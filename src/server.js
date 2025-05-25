/********************************************************************
 *  Express REST API for Crio Audit Agent  (queue + 24 h cache refresh)
 *  ==================================================================
 *  • POST /api/audit/call/:id   – enqueue audit for one call
 *  • POST /api/audit/sheet      – enqueue sheet sweep (only 1 at a time)
 *  • GET  /api/health           – liveness probe
 *
 *  The API responds immediately (202 Accepted).  Heavy work runs in a
 *  background FIFO queue processed by a single async worker.
 *  A 24-hour timer refreshes the Google-Drive cache when the system is idle.
 ********************************************************************/

import 'dotenv/config';
import express   from 'express';
import helmet    from 'helmet';
import rateLimit from 'express-rate-limit';

import { auditOneCall }                        from './index.js';
import { upsertRow, pendingRows, markSuccess } from './sheets.js';
import * as driveCache                         from './utils/driveCache.js';
import { logger }                              from './utils/logger.js';

/* ── Configuration via .env ───────────────────────────────────────── */
const PORT       = process.env.PORT || 3000;
const SHEET_ID   = process.env.GOOGLE_SHEETS_ID;
const TAB        = process.env.AUDIT_SHEET_NAME   || 'Crio_AI_Audit_Log';
const API_KEY    = process.env.AUDIT_API_KEY;                 // optional
const DRIVE_ROOT = process.env.DRIVE_ROOT_FOLDER_ID;
const REFRESH_MS = 24 * 60 * 60 * 1000;                       // 24 h

/* ── Express app + hardening ──────────────────────────────────────── */
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(helmet());
app.use(rateLimit({ windowMs: 60_000, max: 30 }));

/* optional simple API-key auth */
if (API_KEY) {
  app.use((req, _res, next) => {
    if (req.get('x-api-key') !== API_KEY) return next('route'); // 401 below
    next();
  });
  app.use((_req, res, next) => res.sendStatus(401));            // failsafe
}

/* ── In-memory queue + worker state ──────────────────────────────── */
const queue         = [];    // array of jobs { type, … }
let   working       = false; // worker busy flag
let   runningSweep  = false; // true when a sweep job is active

/* enqueue ⇒ kick worker if idle */
function kickWorker() { if (!working) setImmediate(worker); }

/* ── Worker loop (one job at a time) ─────────────────────────────── */
async function worker() {
  if (working || !queue.length) return;
  working = true;
  const job = queue.shift();

  logger.debug(`🪵 job start (${job.type}) – queue len ${queue.length}`);

  try {
    if (job.type === 'single') await handleSingle(job);
    if (job.type === 'sweep')  { runningSweep = true; await handleSweep(); runningSweep = false; }
    logger.info(`🎯 job finished (${job.type})`);
  } catch (err) {
    logger.error(`job failed: ${err.message}`);
  } finally {
    working = false;
    kickWorker();                // next job
  }
}

/* ── Job handlers ────────────────────────────────────────────────── */
async function handleSingle(job) {
  const result = await auditOneCall(job.callId, job.promptFile);
  await upsertRow(
    SHEET_ID, TAB, job.callId, job.meta,
    [
      JSON.stringify(result.hallucinations          ?? []),
      JSON.stringify(result.prompt_gaps             ?? []),
      JSON.stringify(result.knowledge_base_gaps     ?? []),
      JSON.stringify(result.shape_policy_violations ?? []),
      JSON.stringify(result.action_items            ?? []),
      JSON.stringify(result)
    ]
  );
}

async function handleSweep() {
  const rows = await pendingRows(SHEET_ID, TAB);
  logger.info(`🪵 sheet sweep: ${rows.length} pending rows`);

  for (const row of rows) {
    const [, , callId, , , promptFile] = row.data;
    try {
      const result = await auditOneCall(callId, promptFile);
      await markSuccess(
        SHEET_ID, TAB, row.index,
        [
          JSON.stringify(result.hallucinations          ?? []),
          JSON.stringify(result.prompt_gaps             ?? []),
          JSON.stringify(result.knowledge_base_gaps     ?? []),
          JSON.stringify(result.shape_policy_violations ?? []),
          JSON.stringify(result.action_items            ?? []),
          JSON.stringify(result)
        ]
      );
    } catch (e) {
      logger.error(`row ${row.index} failed: ${e.message}`);
    }
  }
}

/* ── 24-hour Drive-cache refresh (idle-only) ─────────────────────── */
async function refreshCache() {
  if (working || queue.length) {
    logger.debug('🪵 cache refresh deferred – audits in progress');
    return setTimeout(refreshCache, 5 * 60_000);    // retry in 5 min
  }
  logger.info('🔄 Rebuilding Drive cache…');
  await driveCache.init(DRIVE_ROOT);                // rebuild index
  logger.info('🔄 Drive cache rebuilt');
  setTimeout(refreshCache, REFRESH_MS);             // next cycle
}
setTimeout(refreshCache, REFRESH_MS);               // first schedule

/* ── Routes ───────────────────────────────────────────────────────── */

app.post('/api/audit/call/:id', (req, res) => {
  const { id: callId } = req.params;
  const { promptFile, callDate, leadEmail, callDuration, bookingStatus } = req.body;
  if (!promptFile) return res.status(400).json({ error: 'promptFile required' });

  queue.push({
    type: 'single',
    callId,
    promptFile,
    meta: { callDate, leadEmail, callDuration, bookingStatus }
  });

  kickWorker();
  res.status(202).json({ queued: true, callId });
});

app.post('/api/audit/sheet', (_req, res) => {
  const sweepPending = runningSweep || queue.some(j => j.type === 'sweep');
  if (sweepPending) {
    return res.status(200).json({ queued: false, message: 'Sheet sweep already in progress' });
  }
  queue.push({ type: 'sweep' });
  kickWorker();
  res.status(202).json({ queued: true });
});

app.get('/api/health', (_req, res) => res.send('OK'));

/* ── Server start ─────────────────────────────────────────────────── */
app.listen(PORT, () => logger.info(`Audit API listening on :${PORT}`));