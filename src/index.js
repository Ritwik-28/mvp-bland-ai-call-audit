/***************************************************************************
 *  Crio AI Audit Agent – Batch CLI  +  Re-usable auditOneCall()
 ***************************************************************************/

import 'dotenv/config';
import { logger }                   from './utils/logger.js';
import * as driveCache              from './utils/driveCache.js';
import { pendingRows, markSuccess } from './sheets.js';
import { fetchTranscript }          from './bland.js';
import { auditWithGemini }          from './gemini.js';

/* ── Environment + initial Drive index ─────────────────────────────── */
const {
  GOOGLE_SHEETS_ID:     SHEET_ID,
  DRIVE_ROOT_FOLDER_ID: DRIVE_ROOT,
  AUDIT_SHEET_NAME   = 'Crio_AI_Audit_Log',
  PROMPT_PARENT_DIR  = 'Prompt/General',
  KNOWLEDGE_BASE_ROOT = 'Knowledge_Base'
} = process.env;

if (!SHEET_ID || !DRIVE_ROOT) {
  logger.error('GOOGLE_SHEETS_ID and DRIVE_ROOT_FOLDER_ID must be set');
  process.exit(1);
}
await driveCache.init(DRIVE_ROOT);
logger.info(`Drive cache ready – ${driveCache.listPaths(KNOWLEDGE_BASE_ROOT).length} KB files indexed.`);

/* ── Export: audit a single call (used by server.js) ───────────────── */
export async function auditOneCall(callId, promptFileName) {
  const promptPath = `${PROMPT_PARENT_DIR}/${promptFileName}`;
  if (!driveCache.listPaths().includes(promptPath)) {
    throw new Error(`Prompt file “${promptPath}” not found in Drive`);
  }
  const shapeTxt    = await driveCache.getText('SHAPE_Policy/SHAPE_Policy_2025_Sheet_Link.txt');
  const transcripts = await fetchTranscript(callId);

  /* Always grab fresh KB paths → uses cache rebuilt by server */
  const kbPaths = driveCache.listPaths(KNOWLEDGE_BASE_ROOT);

  return auditWithGemini({
    transcript:     transcripts,
    promptFilePath: promptPath,
    shapePolicyTxt: shapeTxt,
    kbPaths
  });
}

/* ── Batch sweep when run via `npm start` ──────────────────────────── */
if (process.argv[1].endsWith('index.js')) {
  const rows = await pendingRows(SHEET_ID, AUDIT_SHEET_NAME);
  logger.info(`Batch run – ${rows.length} rows pending audit`);

  for (const row of rows) {
    const [, , callId, , , promptFile] = row.data;
    logger.info(`\n— Auditing Call ${callId} (row ${row.index}) —`);
    try {
      const result = await auditOneCall(callId, promptFile);
      await markSuccess(
        SHEET_ID, AUDIT_SHEET_NAME, row.index,
        [
          JSON.stringify(result.hallucinations          ?? []),
          JSON.stringify(result.prompt_gaps             ?? []),
          JSON.stringify(result.knowledge_base_gaps     ?? []),
          JSON.stringify(result.shape_policy_violations ?? []),
          JSON.stringify(result.action_items            ?? []),
          JSON.stringify(result)
        ]
      );
      logger.info(`✅  Row ${row.index} marked Successful`);
    } catch (e) {
      logger.error(`❌  Call ${callId} failed: ${e.message}`);
    }
  }
  logger.info('🏁  Batch audit finished.');
}