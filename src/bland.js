/********************************************************************
 *  Bland-AI helper
 *  ---------------------------------------------------------------
 *  • fetchTranscript(callId) → returns the full `transcripts` array
 *  • Adds debug log with item count for quick sanity checks
 ********************************************************************/

import axios   from 'axios';
import { logger } from './utils/logger.js';

const BASE = 'https://api.bland.ai/v1';

/**
 * Fetch the full call payload and return the `transcripts` array.
 * @param {string} callId
 * @returns {Promise<Array<{user:string,text:string}>>}
 */
export async function fetchTranscript(callId) {
  const url = `${BASE}/calls/${callId}`;
  const { data } = await axios.get(url, {
    headers: { Authorization: `Bearer ${process.env.BLAND_API_KEY}` }
  });

  if (!data.transcripts || !Array.isArray(data.transcripts)) {
    throw new Error(`No “transcripts” array for call ${callId}`);
  }
  logger.debug(`🪵 Bland transcripts items: ${data.transcripts.length}`);
  return data.transcripts;                   // full array
}