import { google } from 'googleapis';
import fs from 'fs';
import { logger } from './utils/logger.js';

const keyFile = process.env.GOOGLE_SERVICE_KEY_PATH;
if(!keyFile || !fs.existsSync(keyFile)){
  logger.error('Service account key missing');
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  keyFile,
  scopes:['https://www.googleapis.com/auth/drive.readonly','https://www.googleapis.com/auth/spreadsheets']
});
export const drive = google.drive({version:'v3',auth});
export const sheets = google.sheets({version:'v4',auth});
