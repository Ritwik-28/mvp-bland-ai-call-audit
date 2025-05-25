/**********************************************************************
 *  Gemini helper – Function-Tool flow (verbose diagnostics)
 *********************************************************************/

import axios from 'axios';
import fs    from 'fs';
import * as driveCache from './utils/driveCache.js';
import { logger }  from './utils/logger.js';

/* ── Runtime constants ─────────────────────────────────────────────── */

const MODEL    = 'gemini-2.0-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const KEY      = process.env.GEMINI_API_KEY;

const MAX_TRANSCRIPT_CHARS = 15_000;   // ≈4-5 k tokens

const BASE_PROMPT = JSON.parse(
  fs.readFileSync('./config/Audit_Agent_Prompt.json', 'utf8')
);

/* ── Gemini tool declaration ───────────────────────────────────────── */

const tools = [{
  function_declarations: [{
    name: 'get_drive_txt',
    description: 'Return the raw text of a .txt file stored in Google Drive',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Drive path, e.g. Knowledge_Base/.../file.txt' }
      },
      required: ['path']
    }
  }]
}];

/* ── Tool executor ────────────────────────────────────────────────── */
async function execTool(name, argsObj) {
  if (name !== 'get_drive_txt')
    throw new Error(`Unknown tool requested: ${name}`);

  const { path } = argsObj;
  const text = await driveCache.getText(path);
  logger.debug(`🪵 fetched ${path} (${text.length} chars)`);
  return { text };
}

/* ── Main helper ──────────────────────────────────────────────────── */
export async function auditWithGemini({
  transcript,
  promptFilePath,
  shapePolicyTxt,
  kbPaths
}) {
  /* 1. Transcript flatten + preview */
  const transcriptStr = Array.isArray(transcript)
    ? transcript.map(t => `[${t.user}] ${t.text}`).join('\n').slice(0, MAX_TRANSCRIPT_CHARS)
    : String(transcript).slice(0, MAX_TRANSCRIPT_CHARS);

  logger.debug(`🪵 transcript length: ${transcriptStr.length} chars`);

  logger.debug(`🪵 KB paths count   : ${kbPaths.length}`);
  logger.debug(`🪵 Prompt path      : ${promptFilePath}`);

  /* 2. Build dynamic prompt */
  const prompt = structuredClone(BASE_PROMPT);
  prompt.instructions.context.date = new Date().toISOString();

  const userPayload = {
    transcript:           transcriptStr,
    knowledge_base_files: kbPaths,
    prompt_file_path:     promptFilePath,
    shape_policy:         shapePolicyTxt,
    audit_prompt:         prompt
  };

  /* 3. Conversation scaffold */
  const systemInstruction = {
    role: 'system',
    parts: [{
      text: 'Return ONLY valid JSON matching output_format. '
          + 'No markdown fences or extra commentary. '
          + 'Call get_drive_txt() whenever you need a file.'
    }]
  };

  let messages = [
    { role: 'user', parts: [{ text: JSON.stringify(userPayload) }] }
  ];

  /* 4. Loop */
  while (true) {
    const body = { system_instruction: systemInstruction, contents: messages, tools };

    logger.debug(`🪵 request size     : ${(JSON.stringify(body).length / 1024).toFixed(1)} KB`);

    let data;
    try {
      ({ data } = await axios.post(
        `${ENDPOINT}?key=${KEY}`,
        body,
        { headers: { 'Content-Type':'application/json' }, timeout: 180_000 }
      ));
    } catch (err) {
      if (err.response?.data) {
        logger.error('Gemini error:\n' + JSON.stringify(err.response.data, null, 2));
      }
      throw err;
    }

    const part = data.candidates[0].content.parts[0];

    /* 4-A handle tool calls */
    if (part.functionCall) {
      const { name, arguments: argStr } = part.functionCall;
      logger.debug(`🪵 Gemini requested ${name} ${argStr}`);
      const result = await execTool(name, JSON.parse(argStr));

      messages.push({
        role: 'tool',
        toolName: name,
        parts: [{ text: JSON.stringify(result) }]
      });
      continue;
    }

    /* 4-B final answer */
    const raw = part.text.trim().replace(/^```json[\r\n]*|```$/g, '');
    logger.debug('🪵 raw response preview:\n' + raw.slice(0, 300) + '…');

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const blk = raw.match(/{[\s\S]*}/);
      if (!blk) throw new Error('Gemini returned no JSON');
      parsed = JSON.parse(blk[0]);
    }

    logger.debug(
      `🪵 summary: hallucinations ${parsed.hallucinations?.length ?? 0}, `
    + `prompt gaps ${parsed.prompt_gaps?.length ?? 0}, `
    + `KB gaps ${parsed.knowledge_base_gaps?.length ?? 0}, `
    + `policy violations ${parsed.shape_policy_violations?.length ?? 0}`
    );

    return parsed;
  }
}