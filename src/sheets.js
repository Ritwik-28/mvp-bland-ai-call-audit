/********************************************************************
 *  Google-Sheets helpers
 *  ---------------------------------------------------------------
 *  • pendingRows()   – rows whose “Audit Status” ≠ "Successful"
 *  • markSuccess()   – writes cols G…M and sets status
 *  • upsertRow()     – insert or update a single row by call-id
 ********************************************************************/

import { sheets } from './auth.js';
import { logger } from './utils/logger.js';

const STATUS_COL_INDEX = 6;             // Column G (0-based)

/* helper: 0-based index → Excel column letter(s) */
function colLetter(idx) {
  let s = '', n = idx;
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n  = Math.floor(n / 26) - 1;
  }
  return s;
}

/* ------------------------------------------------------------------ */
export async function pendingRows(sheetId, tab) {
  const range = `${tab}!A1:Z`;
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  const rows = data.values || [];
  const out  = [];

  for (let r = 1; r < rows.length; r++) {
    if (rows[r][STATUS_COL_INDEX] !== 'Successful') {
      out.push({ index: r + 1, data: rows[r] });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
export async function markSuccess(sheetId, tab, rowIdx, auditCols) {
  /* G = "Successful" + 6 audit columns (H–M) */
  const start = STATUS_COL_INDEX;
  const end   = STATUS_COL_INDEX + auditCols.length;
  const range = `${tab}!${colLetter(start)}${rowIdx}:${colLetter(end)}${rowIdx}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'RAW',
    resource: { values: [['Successful', ...auditCols]] }
  });
  logger.debug(`🪵 Sheet row ${rowIdx} updated (${range})`);
}

/* ------------------------------------------------------------------ */
/**
 * Insert a new sheet row if the call-id isn’t present, or update the
 * existing row’s audit columns if it is.
 * @param {string} sheetId
 * @param {string} tab
 * @param {string} callId
 * @param {object} meta  (date,email,duration,booking)
 * @param {string[]} auditCols  (G…M data)
 */
export async function upsertRow(sheetId, tab, callId, meta, auditCols) {
  const range = `${tab}!A1:Z`;
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  const rows = data.values || [];

  const idx = rows.findIndex((r, i) => i > 0 && r[2] === callId);

  if (idx === -1) {
    /* append new row */
    const newRow = [
      meta.callDate     || '',
      meta.leadEmail    || '',
      callId,
      meta.callDuration || '',
      meta.bookingStatus|| '',
      'Successful',
      ...auditCols
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${tab}!A:Z`,
      valueInputOption: 'RAW',
      resource: { values: [newRow] }
    });
    logger.debug(`🪵 Appended new sheet row for call ${callId}`);
  } else {
    /* update existing */
    const rowNum = idx + 1;
    const start  = STATUS_COL_INDEX;
    const end    = start + auditCols.length;
    const target = `${tab}!${colLetter(start)}${rowNum}:${colLetter(end)}${rowNum}`;

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: target,
      valueInputOption: 'RAW',
      resource: { values: [['Successful', ...auditCols]] }
    });
    logger.debug(`🪵 Updated sheet row ${rowNum} for call ${callId}`);
  }
}