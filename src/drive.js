import { drive } from './auth.js';
import { logger } from './utils/logger.js';

export async function fetchTxtRecursive(folderId, prefix=''){
  const out = {};
  const q = `'${folderId}' in parents and trashed = false`;
  const res = await drive.files.list({q, fields:'files(id,name,mimeType)'});
  for(const f of res.data.files){
    const rel = prefix?`${prefix}/${f.name}`:f.name;
    if(f.mimeType==='application/vnd.google-apps.folder'){
      Object.assign(out, await fetchTxtRecursive(f.id, rel));
    }else if(f.name.endsWith('.txt')){
      const txt = await drive.files.get({fileId:f.id,alt:'media'},{responseType:'text'});
      out[rel]=txt.data;
      logger.debug(`Fetched ${rel}`);
    }
  }
  return out;
}
