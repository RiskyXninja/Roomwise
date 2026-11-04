import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import pg from 'pg';

const root = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to your Neon Postgres connection string.');
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
function sql(strings, ...values) {
  const text = strings.reduce((out, part, i) => out + part + (i < values.length ? `$${i + 1}` : ''), '');
  return pool.query(text, values).then(result => result.rows);
}
const migrationId = '001_initial';
await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
const applied = await pool.query('SELECT id FROM schema_migrations WHERE id=$1', [migrationId]);
if (!applied.rowCount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(await readFile(path.join(root, 'migrations', `${migrationId}.sql`), 'utf8'));
    await client.query('INSERT INTO schema_migrations(id) VALUES($1)', [migrationId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
const initialData = { rooms: [], tenants: [], bills: [], payments: [], audit: [], settings: { owner: 'Rental Admin', currency: '₹' } };
await pool.query('INSERT INTO app_data(id,document) VALUES(1,$1::jsonb) ON CONFLICT(id) DO NOTHING', [JSON.stringify(initialData)]);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const production = process.env.NODE_ENV === 'production';
const capacitorOrigins = new Set((process.env.CAPACITOR_ORIGINS || 'https://localhost').split(',').map(value => value.trim()).filter(Boolean));
const sessionDays = 7, maxBody = 18 * 1024 * 1024, attempts = new Map();

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; worker-src 'self' blob: https://cdn.jsdelivr.net; connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", ...headers });
  res.end(JSON.stringify(data));
}
function cookie(value, maxAge = sessionDays * 86400, crossSite = false) { return `roomwise_session=${value}; Path=/; HttpOnly; SameSite=${crossSite ? 'None' : 'Strict'}; Max-Age=${maxAge}${production ? '; Secure' : ''}`; }
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split(/=(.*)/s).slice(0, 2)).filter(x => x[0])); }
async function sessionFor(req) {
  const token = cookies(req).roomwise_session;
  if (!token) return null;
  const hash = createHash('sha256').update(token).digest('hex');
  const rows = await sql`SELECT expires_at FROM sessions WHERE token_hash=${hash}`;
  if (!rows.length || new Date(rows[0].expires_at).getTime() < Date.now()) { await sql`DELETE FROM sessions WHERE token_hash=${hash}`; return null; }
  return hash;
}
function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try { const origin = new URL(req.headers.origin); return origin.host === req.headers.host || capacitorOrigins.has(origin.origin); } catch { return false; }
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > maxBody) throw Object.assign(new Error('Request too large'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Invalid JSON request'), { status: 400 }); }
}
function validPassword(p) { return typeof p === 'string' && p.length >= 12 && p.length <= 256; }
function matches(p, row) { if (!validPassword(p)) return false; const candidate = scryptSync(p, row.salt, 64), expected = Buffer.from(row.password_hash, 'hex'); return candidate.length === expected.length && timingSafeEqual(candidate, expected); }
function blocked(req) { const a = attempts.get(req.socket.remoteAddress || 'unknown'); if (!a) return 0; if (a.until > Date.now()) return Math.ceil((a.until - Date.now()) / 1000); if (a.until) { a.count = 0; a.until = 0; } return 0; }
function failed(req) { const key = req.socket.remoteAddress || 'unknown', a = attempts.get(key) || { count: 0, until: 0 }; a.count++; if (a.count >= 5) a.until = Date.now() + 15 * 60 * 1000; attempts.set(key, a); }
function validData(d) {
  const keys = ['rooms','tenants','bills','payments','audit'];
  if(!(!!d && typeof d === 'object' && keys.every(k => Array.isArray(d[k]) && d[k].every(x => x && typeof x === 'object' && !Array.isArray(x))) && d.rooms.length <= 100000 && d.tenants.length <= 100000 && d.bills.length <= 200000 && d.payments.length <= 500000 && d.audit.length <= 5000))return false;const names=d.rooms.map(r=>String(r.name||'').trim().toLocaleLowerCase());return !names.some((n,i)=>!n||names.indexOf(n)!==i);
}
function xml(value) { return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;'); }
function crc32(b) { let c=0xffffffff; for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^(c&1?0xedb88320:0)}return(c^0xffffffff)>>>0; }
function makeXlsx(rows) {
  const col=n=>{let x='';for(n++;n;n=Math.floor((n-1)/26))x=String.fromCharCode(65+(n-1)%26)+x;return x};
  const sheet=rows.map((row,ri)=>`<row r="${ri+1}">${row.map((v,ci)=>{const ref=`${col(ci)}${ri+1}`;return typeof v==='number'&&Number.isFinite(v)?`<c r="${ref}" s="${ri===0?1:2}"><v>${v}</v></c>`:`<c r="${ref}" s="${ri===0?1:0}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`}).join('')}</row>`).join('');
  const files=[['[Content_Types].xml','<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],['_rels/.rels','<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],['xl/styles.xml','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF6D3CC7"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><bottom style="thin"><color rgb="FFDAD2EC"/></bottom><left/><right/><top/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],['xl/workbook.xml','<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Roomwise report" sheetId="1" r:id="rId1"/></sheets></workbook>'],['xl/_rels/workbook.xml.rels','<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],['xl/worksheets/sheet1.xml',`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${sheet}</sheetData><autoFilter ref="A1:O${rows.length}"/></worksheet>`]];
  const local=[],central=[];let offset=0;
  for(const [name,content] of files){const n=Buffer.from(name),raw=Buffer.from(content),zip=deflateRawSync(raw),crc=crc32(raw),h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(8,8);h.writeUInt32LE(crc,14);h.writeUInt32LE(zip.length,18);h.writeUInt32LE(raw.length,22);h.writeUInt16LE(n.length,26);const part=Buffer.concat([h,n,zip]);local.push(part);const d=Buffer.alloc(46);d.writeUInt32LE(0x02014b50,0);d.writeUInt16LE(20,4);d.writeUInt16LE(20,6);d.writeUInt16LE(8,10);d.writeUInt32LE(crc,16);d.writeUInt32LE(zip.length,20);d.writeUInt32LE(raw.length,24);d.writeUInt16LE(n.length,28);d.writeUInt32LE(offset,42);central.push(Buffer.concat([d,n]));offset+=part.length}
  const dir=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,dir,end]);
}
function exportRows(d) {
  const tenants=new Map(d.tenants.map(t=>[t.id,t])),rooms=new Map(d.rooms.map(r=>[r.id,r]));
  const rows=[['Period','Tenant','Room','Previous reading','Current reading','Units','Rate (₹/unit)','Rent (₹)','Electricity (₹)','Prior balance (₹)','Adjustment (₹)','Total (₹)','Paid (₹)','Balance (₹)','Status']];
  for(const b of d.bills){const paid=(b.allocations||[]).reduce((s,a)=>s+Number(a.amount||0),0),balance=b.rolledInto?0:Math.max(0,Number(b.total||0)-paid),status=b.rolledInto?'Carried forward':paid>=b.total?'Paid':paid>0?'Part paid':'Unpaid',[y,m]=b.period.split('-'),period=new Date(+y,+m-1,1).toLocaleDateString('en-IN',{month:'long',year:'numeric'});rows.push([period,tenants.get(b.tenantId)?.name||'Former tenant',rooms.get(b.roomId)?.name||'',b.prev,b.curr,b.units,b.rate,b.rent,b.electricity,b.priorBalance,b.adjustment,b.total,paid,balance,status])}
  return rows;
}

const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    const requestOrigin=req.headers.origin||'',capacitorRequest=capacitorOrigins.has(requestOrigin);
    if(capacitorRequest){res.setHeader('Access-Control-Allow-Origin',requestOrigin);res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Access-Control-Allow-Methods','GET, POST, PUT, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, If-Match');res.setHeader('Vary','Origin')}
    if(req.method==='OPTIONS'){if(!capacitorRequest)return send(res,403,{error:'Request origin rejected.'});res.writeHead(204);return res.end()}
    if(req.method==='GET'&&url.pathname==='/healthz')return send(res,200,{ok:true});
    if(req.method==='GET'&&url.pathname==='/api/status'){const a=await sql`SELECT id FROM admin WHERE id=1`;return send(res,200,{configured:!!a.length,authenticated:!!(await sessionFor(req))})}
    if(req.method==='POST'&&['/api/setup','/api/login','/api/logout','/api/password'].includes(url.pathname)){
      if(!sameOrigin(req))return send(res,403,{error:'Request origin rejected.'});const input=await body(req);
      if(url.pathname==='/api/setup'){
        if(!validPassword(input.password))return send(res,400,{error:'Choose a password with at least 12 characters.'});const salt=randomBytes(16).toString('hex'),added=await sql`INSERT INTO admin(id,salt,password_hash) VALUES(1,${salt},${scryptSync(input.password,salt,64).toString('hex')}) ON CONFLICT(id) DO NOTHING RETURNING id`;if(!added.length)return send(res,409,{error:'Admin account is already configured.'});
      }else if(url.pathname==='/api/login'){
        const wait=blocked(req);if(wait)return send(res,429,{error:`Too many attempts. Try again in ${wait} seconds.`});const rows=await sql`SELECT salt,password_hash FROM admin WHERE id=1`;if(!rows.length||!matches(String(input.password||''),rows[0])){failed(req);return send(res,401,{error:'Password did not match.'})}attempts.delete(req.socket.remoteAddress||'unknown');
      }else if(url.pathname==='/api/logout'){
        const hash=await sessionFor(req);if(hash)await sql`DELETE FROM sessions WHERE token_hash=${hash}`;return send(res,200,{ok:true},{'Set-Cookie':cookie('',0,capacitorRequest)});
      }else if(url.pathname==='/api/password'){
        if(!await sessionFor(req))return send(res,401,{error:'Sign in to change the password.'});const rows=await sql`SELECT salt,password_hash FROM admin WHERE id=1`;if(!rows.length||!matches(String(input.currentPassword||''),rows[0]))return send(res,401,{error:'Current password did not match.'});if(!validPassword(input.newPassword))return send(res,400,{error:'Choose a new password with at least 12 characters.'});const salt=randomBytes(16).toString('hex');await sql`UPDATE admin SET salt=${salt},password_hash=${scryptSync(input.newPassword,salt,64).toString('hex')} WHERE id=1`;await sql`DELETE FROM sessions`;return send(res,200,{ok:true},{'Set-Cookie':cookie('',0,capacitorRequest)});
      }
      const token=randomBytes(32).toString('base64url'),hash=createHash('sha256').update(token).digest('hex'),expires=new Date(Date.now()+sessionDays*86400000);await sql`INSERT INTO sessions(token_hash,created_at,expires_at) VALUES(${hash},NOW(),${expires})`;await sql`DELETE FROM sessions WHERE expires_at<NOW()`;return send(res,200,{ok:true},{'Set-Cookie':cookie(token,sessionDays*86400,capacitorRequest)});
    }
    if(url.pathname.startsWith('/api/')){
      if(!await sessionFor(req))return send(res,401,{error:'Sign in to continue.'});
      if(req.method==='GET'&&url.pathname==='/api/data'){const rows=await sql`SELECT document,updated_at,version FROM app_data WHERE id=1`;return send(res,200,{data:rows[0].document,updatedAt:rows[0].updated_at,version:rows[0].version})}
      if(req.method==='POST'&&url.pathname==='/api/changes'){
        if(!sameOrigin(req))return send(res,403,{error:'Request origin rejected.'});const patch=await body(req),keys=['rooms','tenants','bills','payments','audit'];
        if(!patch||!patch.changes||!patch.deleted||keys.some(k=>!Array.isArray(patch.changes[k]||[])||!Array.isArray(patch.deleted[k]||[]))||Object.values(patch.changes).flat().some(x=>!x||typeof x!=='object'||Array.isArray(x)))return send(res,400,{error:'The record changes are invalid.'});
        const client=await pool.connect();let version;try{await client.query('BEGIN');const selected=await client.query('SELECT document FROM app_data WHERE id=1 FOR UPDATE');const doc=selected.rows[0].document;for(const k of keys){const gone=new Set((patch.deleted[k]||[]).map(String));doc[k]=doc[k].filter(x=>!gone.has(String(x.id)));for(const item of patch.changes[k]||[]){if(k==='bills'){delete item.photo;delete item.photoCapturedAt}const i=doc[k].findIndex(x=>String(x.id)===String(item.id));if(i<0)doc[k].push(item);else doc[k][i]=item}}if(patch.changes.settings&&typeof patch.changes.settings==='object')doc.settings=patch.changes.settings;if(!validData(doc))throw Object.assign(new Error('Room names must be unique, and the saved records must be valid.'),{status:400});const updated=await client.query('UPDATE app_data SET document=$1::jsonb,updated_at=NOW(),version=version+1 WHERE id=1 RETURNING version',[JSON.stringify(doc)]);version=updated.rows[0].version;await client.query('COMMIT')}catch(error){await client.query('ROLLBACK');return send(res,error.status||500,{error:error.message||'Could not save record changes.'})}finally{client.release()}return send(res,200,{ok:true,version});
      }
      if(req.method==='PUT'&&url.pathname==='/api/data'){
        if(!sameOrigin(req))return send(res,403,{error:'Request origin rejected.'});const input=await body(req);if(!validData(input))return send(res,400,{error:'The saved data format is invalid.'});for(const bill of input.bills){delete bill.photo;delete bill.photoCapturedAt}const expected=Number(req.headers['if-match']);if(!Number.isInteger(expected))return send(res,400,{error:'Missing data version.'});
        const updated=await sql`UPDATE app_data SET document=${JSON.stringify(input)}::jsonb,updated_at=NOW(),version=version+1 WHERE id=1 AND version=${expected} RETURNING version`;
        if(!updated.length){const current=await sql`SELECT version FROM app_data WHERE id=1`;return send(res,409,{error:'These records changed in another open app. Reload before saving again.',version:current[0].version})}return send(res,200,{ok:true,version:updated[0].version});
      }
      if(req.method==='GET'&&url.pathname==='/api/export.xlsx'){
        const data=(await sql`SELECT document FROM app_data WHERE id=1`)[0].document,book=makeXlsx(exportRows(data));res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="roomwise-report.xlsx"','Content-Length':book.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(book);
      }
      return send(res,404,{error:'API route not found.'});
    }
    if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,{error:'Method not allowed.'});if(url.pathname!=='/'&&url.pathname!=='/index.html')return send(res,404,{error:'Not found.'});const html=await readFile(path.join(root,'index.html'));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; worker-src 'self' blob: https://cdn.jsdelivr.net; connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});res.end(html);
  }catch(error){console.error(error);send(res,error.status||500,{error:error.status?error.message:'Server error.'})}
});
server.on('error',error=>{console.error(`Roomwise could not start: ${error.message}`);process.exitCode=1});
server.listen(port,host,()=>console.log(`Roomwise (Neon) listening at http://${host}:${port}`));
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>server.close(async()=>{await pool.end();process.exit(0)}));
