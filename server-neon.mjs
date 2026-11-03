import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { neon } from '@neondatabase/serverless';

const root = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to your Neon Postgres connection string.');
const sql = neon(process.env.DATABASE_URL);
const initialData = { rooms: [], tenants: [], bills: [], payments: [], audit: [], settings: { owner: 'Rental Admin', currency: '₹' } };
await sql`CREATE TABLE IF NOT EXISTS admin (id SMALLINT PRIMARY KEY CHECK (id=1), salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
await sql`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`;
await sql`CREATE TABLE IF NOT EXISTS app_data (id SMALLINT PRIMARY KEY CHECK (id=1), document JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), version INTEGER NOT NULL DEFAULT 0)`;
await sql`INSERT INTO app_data(id,document) VALUES(1,${JSON.stringify(initialData)}::jsonb) ON CONFLICT(id) DO NOTHING`;

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const production = process.env.NODE_ENV === 'production';
const sessionDays = 7, maxBody = 18 * 1024 * 1024, attempts = new Map();

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", ...headers });
  res.end(JSON.stringify(data));
}
function cookie(value, maxAge = sessionDays * 86400) { return `roomwise_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${production ? '; Secure' : ''}`; }
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
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
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
  return !!d && typeof d === 'object' && keys.every(k => Array.isArray(d[k]) && d[k].every(x => x && typeof x === 'object' && !Array.isArray(x))) && d.rooms.length <= 100000 && d.tenants.length <= 100000 && d.bills.length <= 200000 && d.payments.length <= 500000 && d.audit.length <= 5000;
}
function xml(value) { return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;'); }
function crc32(b) { let c=0xffffffff; for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^(c&1?0xedb88320:0)}return(c^0xffffffff)>>>0; }
function makeXlsx(rows) {
  const col=n=>{let x='';for(n++;n;n=Math.floor((n-1)/26))x=String.fromCharCode(65+(n-1)%26)+x;return x};
  const sheet=rows.map((row,ri)=>`<row r="${ri+1}">${row.map((v,ci)=>{const ref=`${col(ci)}${ri+1}`;return typeof v==='number'&&Number.isFinite(v)?`<c r="${ref}"><v>${v}</v></c>`:`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`}).join('')}</row>`).join('');
  const files=[['[Content_Types].xml','<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],['_rels/.rels','<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],['xl/workbook.xml','<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Roomwise report" sheetId="1" r:id="rId1"/></sheets></workbook>'],['xl/_rels/workbook.xml.rels','<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],['xl/worksheets/sheet1.xml',`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${sheet}</sheetData><autoFilter ref="A1:O${rows.length}"/></worksheet>`]];
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
    if(req.method==='GET'&&url.pathname==='/healthz')return send(res,200,{ok:true});
    if(req.method==='GET'&&url.pathname==='/api/status'){const a=await sql`SELECT id FROM admin WHERE id=1`;return send(res,200,{configured:!!a.length,authenticated:!!(await sessionFor(req))})}
    if(req.method==='POST'&&['/api/setup','/api/login','/api/logout','/api/password'].includes(url.pathname)){
      if(!sameOrigin(req))return send(res,403,{error:'Request origin rejected.'});const input=await body(req);
      if(url.pathname==='/api/setup'){
        if(!validPassword(input.password))return send(res,400,{error:'Choose a password with at least 12 characters.'});const salt=randomBytes(16).toString('hex'),added=await sql`INSERT INTO admin(id,salt,password_hash) VALUES(1,${salt},${scryptSync(input.password,salt,64).toString('hex')}) ON CONFLICT(id) DO NOTHING RETURNING id`;if(!added.length)return send(res,409,{error:'Admin account is already configured.'});
      }else if(url.pathname==='/api/login'){
        const wait=blocked(req);if(wait)return send(res,429,{error:`Too many attempts. Try again in ${wait} seconds.`});const rows=await sql`SELECT salt,password_hash FROM admin WHERE id=1`;if(!rows.length||!matches(String(input.password||''),rows[0])){failed(req);return send(res,401,{error:'Password did not match.'})}attempts.delete(req.socket.remoteAddress||'unknown');
      }else if(url.pathname==='/api/logout'){
        const hash=await sessionFor(req);if(hash)await sql`DELETE FROM sessions WHERE token_hash=${hash}`;return send(res,200,{ok:true},{'Set-Cookie':cookie('',0)});
      }else if(url.pathname==='/api/password'){
        if(!await sessionFor(req))return send(res,401,{error:'Sign in to change the password.'});const rows=await sql`SELECT salt,password_hash FROM admin WHERE id=1`;if(!rows.length||!matches(String(input.currentPassword||''),rows[0]))return send(res,401,{error:'Current password did not match.'});if(!validPassword(input.newPassword))return send(res,400,{error:'Choose a new password with at least 12 characters.'});const salt=randomBytes(16).toString('hex');await sql`UPDATE admin SET salt=${salt},password_hash=${scryptSync(input.newPassword,salt,64).toString('hex')} WHERE id=1`;await sql`DELETE FROM sessions`;return send(res,200,{ok:true},{'Set-Cookie':cookie('',0)});
      }
      const token=randomBytes(32).toString('base64url'),hash=createHash('sha256').update(token).digest('hex'),expires=new Date(Date.now()+sessionDays*86400000);await sql`INSERT INTO sessions(token_hash,created_at,expires_at) VALUES(${hash},NOW(),${expires})`;await sql`DELETE FROM sessions WHERE expires_at<NOW()`;return send(res,200,{ok:true},{'Set-Cookie':cookie(token)});
    }
    if(url.pathname.startsWith('/api/')){
      if(!await sessionFor(req))return send(res,401,{error:'Sign in to continue.'});
      if(req.method==='GET'&&url.pathname==='/api/data'){const rows=await sql`SELECT document,updated_at,version FROM app_data WHERE id=1`;return send(res,200,{data:rows[0].document,updatedAt:rows[0].updated_at,version:rows[0].version})}
      if(req.method==='PUT'&&url.pathname==='/api/data'){
        if(!sameOrigin(req))return send(res,403,{error:'Request origin rejected.'});const input=await body(req);if(!validData(input))return send(res,400,{error:'The saved data format is invalid.'});const expected=Number(req.headers['if-match']);if(!Number.isInteger(expected))return send(res,400,{error:'Missing data version.'});
        const updated=await sql`UPDATE app_data SET document=${JSON.stringify(input)}::jsonb,updated_at=NOW(),version=version+1 WHERE id=1 AND version=${expected} RETURNING version`;
        if(!updated.length){const current=await sql`SELECT version FROM app_data WHERE id=1`;return send(res,409,{error:'These records changed in another open app. Reload before saving again.',version:current[0].version})}return send(res,200,{ok:true,version:updated[0].version});
      }
      if(req.method==='GET'&&url.pathname==='/api/export.xlsx'){
        const data=(await sql`SELECT document FROM app_data WHERE id=1`)[0].document,book=makeXlsx(exportRows(data));res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="roomwise-report.xlsx"','Content-Length':book.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(book);
      }
      return send(res,404,{error:'API route not found.'});
    }
    if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,{error:'Method not allowed.'});if(url.pathname!=='/'&&url.pathname!=='/index.html')return send(res,404,{error:'Not found.'});const html=await readFile(path.join(root,'index.html'));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});res.end(html);
  }catch(error){console.error(error);send(res,error.status||500,{error:error.status?error.message:'Server error.'})}
});
server.on('error',error=>{console.error(`Roomwise could not start: ${error.message}`);process.exitCode=1});
server.listen(port,host,()=>console.log(`Roomwise (Neon) listening at http://${host}:${port}`));
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>server.close(()=>process.exit(0)));
