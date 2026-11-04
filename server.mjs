import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { deflateRawSync } from 'node:zlib';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'roomwise.sqlite');
const db = new DatabaseSync(dbPath);
try { chmodSync(dataDir, 0o700); chmodSync(dbPath, 0o600); } catch {}
db.exec(`PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL CHECK(collection IN ('rooms','tenants','bills','payments','audit')), record_id TEXT NOT NULL, position INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(collection,record_id)) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS records_order ON records(collection,position);
  CREATE TABLE IF NOT EXISTS app_settings (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);`);
if (!db.prepare('PRAGMA table_info(metadata)').all().some(column => column.name === 'version')) db.exec('ALTER TABLE metadata ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
db.prepare('INSERT OR IGNORE INTO app_settings(id,document) VALUES(1,?)')
  .run(JSON.stringify({ owner: 'Rental Admin', currency: '₹' }));
db.prepare('INSERT OR IGNORE INTO metadata(id,updated_at) VALUES(1,?)').run(new Date().toISOString());
function readDocument() {
  const data = { rooms: [], tenants: [], bills: [], payments: [], audit: [], settings: JSON.parse(db.prepare('SELECT document FROM app_settings WHERE id=1').get().document) };
  for (const row of db.prepare('SELECT collection,document FROM records ORDER BY collection,position').all()) data[row.collection].push(JSON.parse(row.document));
  return data;
}
function xmlEscape(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeXlsx(rows) {
  const col = n => { let out = ''; for (n++; n; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out; return out; };
  const sheetRows = rows.map((row, ri) => `<row r="${ri + 1}">${row.map((value, ci) => {
    const ref = `${col(ci)}${ri + 1}`;
    return typeof value === 'number' && Number.isFinite(value) ? `<c r="${ref}" s="${ri===0?1:2}"><v>${value}</v></c>` : `<c r="${ref}" s="${ri===0?1:0}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/styles.xml','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF6D3CC7"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><bottom style="thin"><color rgb="FFDAD2EC"/></bottom><left/><right/><top/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Roomwise report" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="16"/><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:O${rows.length}"/></worksheet>`]
  ];
  const local = [], central = []; let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = Buffer.from(name), raw = Buffer.from(content), packed = deflateRawSync(raw), crc = crc32(raw);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50,0); header.writeUInt16LE(20,4); header.writeUInt16LE(8,8); header.writeUInt32LE(crc,14); header.writeUInt32LE(packed.length,18); header.writeUInt32LE(raw.length,22); header.writeUInt16LE(nameBytes.length,26);
    const localPart = Buffer.concat([header,nameBytes,packed]); local.push(localPart);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50,0); dir.writeUInt16LE(20,4); dir.writeUInt16LE(20,6); dir.writeUInt16LE(8,10); dir.writeUInt32LE(crc,16); dir.writeUInt32LE(packed.length,20); dir.writeUInt32LE(raw.length,24); dir.writeUInt16LE(nameBytes.length,28); dir.writeUInt32LE(offset,42);
    central.push(Buffer.concat([dir,nameBytes])); offset += localPart.length;
  }
  const centralBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10); end.writeUInt32LE(centralBytes.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,centralBytes,end]);
}

let port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_DAYS = 7;
const MAX_BODY = 18 * 1024 * 1024;
const attempts = new Map();

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; worker-src 'self' blob: https://cdn.jsdelivr.net; connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", ...headers });
  res.end(JSON.stringify(data));
}
function cookie(name, value, maxAge = SESSION_DAYS * 86400) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isProduction ? '; Secure' : ''}`;
}
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split(/=(.*)/s).slice(0, 2)).filter(x => x[0]));
}
function sessionFor(req) {
  const raw = parseCookies(req).roomwise_session;
  if (!raw) return null;
  const hash = createHash('sha256').update(raw).digest('hex');
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token_hash=?').get(hash);
  if (!row || row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);
    return null;
  }
  return hash;
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON request'), { status: 400 }); }
}
function passwordValid(password) { return typeof password === 'string' && password.length >= 12 && password.length <= 256; }
function passwordMatches(password, row) {
  if (!passwordValid(password)) return false;
  const candidate = scryptSync(password, row.salt, 64);
  const expected = Buffer.from(row.password_hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
function throttle(req) {
  const now = Date.now(), key = req.socket.remoteAddress || 'unknown';
  const record = attempts.get(key);
  if (!record) return 0;
  if (record.until > now) return Math.ceil((record.until - now) / 1000);
  if (record.until) { record.count = 0; record.until = 0; attempts.set(key, record); }
  return 0;
}
function recordFailure(req) {
  const now = Date.now(), key = req.socket.remoteAddress || 'unknown';
  const record = attempts.get(key) || { count: 0, until: 0 };
  record.count++;
  if (record.count >= 5) record.until = now + 15 * 60 * 1000;
  attempts.set(key, record);
}
function validateDocument(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.rooms) || !Array.isArray(d.tenants) || !Array.isArray(d.bills) || !Array.isArray(d.payments) || !Array.isArray(d.audit)) return false;
  if (d.rooms.length > 100000 || d.tenants.length > 100000 || d.bills.length > 200000 || d.payments.length > 500000 || d.audit.length > 5000) return false;
  if (!['rooms','tenants','bills','payments','audit'].every(key => d[key].every(item => item && typeof item === 'object' && !Array.isArray(item)))) return false;
  const roomNames=d.rooms.map(r=>String(r.name||'').trim().toLocaleLowerCase());if(roomNames.some((name,i)=>!name||roomNames.indexOf(name)!==i))return false;
  return true;
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const configured = !!db.prepare('SELECT id FROM admin WHERE id=1').get();
      return send(res, 200, { configured, authenticated: !!sessionFor(req) });
    }
    if (req.method === 'POST' && ['/api/setup', '/api/login', '/api/logout', '/api/password'].includes(url.pathname)) {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Request origin rejected.' });
      const input = await body(req);
      if (url.pathname === '/api/setup') {
        if (db.prepare('SELECT id FROM admin WHERE id=1').get()) return send(res, 409, { error: 'Admin account is already configured.' });
        if (!passwordValid(input.password)) return send(res, 400, { error: 'Choose a password with at least 12 characters.' });
        const salt = randomBytes(16).toString('hex');
        db.prepare('INSERT INTO admin(id,salt,password_hash,created_at) VALUES(1,?,?,?)').run(salt, scryptSync(input.password, salt, 64).toString('hex'), new Date().toISOString());
      } else if (url.pathname === '/api/login') {
        const wait = throttle(req);
        if (wait) return send(res, 429, { error: `Too many attempts. Try again in ${wait} seconds.` });
        const admin = db.prepare('SELECT salt,password_hash FROM admin WHERE id=1').get();
        if (!admin || !passwordMatches(String(input.password || ''), admin)) { recordFailure(req); return send(res, 401, { error: 'Password did not match.' }); }
        attempts.delete(req.socket.remoteAddress || 'unknown');
      } else if (url.pathname === '/api/logout') {
        const hash = sessionFor(req);
        if (hash) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);
        return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('roomwise_session', '', 0) });
      } else if (url.pathname === '/api/password') {
        if (!sessionFor(req)) return send(res, 401, { error: 'Sign in to change the password.' });
        const admin = db.prepare('SELECT salt,password_hash FROM admin WHERE id=1').get();
        if (!admin || !passwordMatches(String(input.currentPassword || ''), admin)) return send(res, 401, { error: 'Current password did not match.' });
        if (!passwordValid(input.newPassword)) return send(res, 400, { error: 'Choose a new password with at least 12 characters.' });
        const salt = randomBytes(16).toString('hex');
        db.prepare('UPDATE admin SET salt=?,password_hash=? WHERE id=1').run(salt, scryptSync(input.newPassword, salt, 64).toString('hex'));
        db.prepare('DELETE FROM sessions').run();
        return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('roomwise_session', '', 0) });
      }
      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const expires = Date.now() + SESSION_DAYS * 86400 * 1000;
      db.prepare('INSERT INTO sessions(token_hash,created_at,expires_at) VALUES(?,?,?)').run(tokenHash, Date.now(), expires);
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('roomwise_session', token) });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!sessionFor(req)) return send(res, 401, { error: 'Sign in to continue.' });
      if (req.method === 'GET' && url.pathname === '/api/export.xlsx') {
        const data = readDocument(), tenants = new Map(data.tenants.map(t => [t.id, t])), rooms = new Map(data.rooms.map(r => [r.id, r]));
        const headers = ['Period','Tenant','Room','Previous reading','Current reading','Units','Rate (₹/unit)','Rent (₹)','Electricity (₹)','Prior balance (₹)','Adjustment (₹)','Total (₹)','Paid (₹)','Balance (₹)','Status'];
        const rows = [headers];
        for (const b of data.bills) {
          const paid = (b.allocations || []).reduce((sum, a) => sum + Number(a.amount || 0), 0);
          const balance = b.rolledInto ? 0 : Math.max(0, Number(b.total || 0) - paid);
          const status = b.rolledInto ? 'Carried forward' : paid >= b.total ? 'Paid' : paid > 0 ? 'Part paid' : 'Unpaid';
          const [year, month] = b.period.split('-');
          const period = new Date(Number(year), Number(month) - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
          rows.push([period, tenants.get(b.tenantId)?.name || 'Former tenant', rooms.get(b.roomId)?.name || '', b.prev, b.curr, b.units, b.rate, b.rent, b.electricity, b.priorBalance, b.adjustment, b.total, paid, balance, status]);
        }
        const workbook = makeXlsx(rows);
        res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="roomwise-report.xlsx"', 'Content-Length': workbook.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(workbook);
      }
      if (req.method === 'GET' && url.pathname === '/api/data') {
        const row = db.prepare('SELECT updated_at,version FROM metadata WHERE id=1').get();
        return send(res, 200, { data: readDocument(), updatedAt: row.updated_at, version: row.version });
      }
      if (req.method === 'POST' && url.pathname === '/api/changes') {
        if (!sameOrigin(req)) return send(res, 403, { error: 'Request origin rejected.' });
        const patch=await body(req), keys=['rooms','tenants','bills','payments','audit'];
        if(!patch||!patch.changes||!patch.deleted||keys.some(k=>!Array.isArray(patch.changes[k]||[])||!Array.isArray(patch.deleted[k]||[]))||Object.values(patch.changes).flat().some(x=>!x||typeof x!=='object'||Array.isArray(x)))return send(res,400,{error:'The record changes are invalid.'});
        db.exec('BEGIN IMMEDIATE');try{
          const doc=readDocument();for(const k of keys){const ids=new Set((patch.deleted[k]||[]).map(String));doc[k]=doc[k].filter(x=>!ids.has(String(x.id)));for(const item of patch.changes[k]||[]){if(k==='bills'){delete item.photo;delete item.photoCapturedAt}const i=doc[k].findIndex(x=>String(x.id)===String(item.id));if(i<0)doc[k].push(item);else doc[k][i]=item}}
          if(patch.changes.settings&&typeof patch.changes.settings==='object')doc.settings=patch.changes.settings;
          if(!validateDocument(doc))throw Object.assign(new Error('Room names must be unique, and the saved records must be valid.'),{status:400});
          const del=db.prepare('DELETE FROM records WHERE collection=? AND record_id=?');for(const k of keys)for(const id of patch.deleted[k]||[])del.run(k,String(id));
          const upsert=db.prepare('INSERT INTO records(collection,record_id,position,document) VALUES(?,?,?,?) ON CONFLICT(collection,record_id) DO UPDATE SET document=excluded.document');
          for(const k of keys)for(const item of patch.changes[k]||[]){const existing=db.prepare('SELECT position FROM records WHERE collection=? AND record_id=?').get(k,String(item.id));let position=existing?.position;if(position===undefined){const aggregate=db.prepare('SELECT '+(k==='audit'?'COALESCE(MIN(position),0)-1':'COALESCE(MAX(position),-1)+1')+' AS p FROM records WHERE collection=?').get(k);position=aggregate.p}upsert.run(k,String(item.id),position,JSON.stringify(item))}
          if(patch.changes.settings)db.prepare('UPDATE app_settings SET document=? WHERE id=1').run(JSON.stringify(doc.settings));
          db.prepare('UPDATE metadata SET updated_at=?,version=version+1 WHERE id=1').run(new Date().toISOString());db.exec('COMMIT');
        }catch(error){db.exec('ROLLBACK');return send(res,error.status||500,{error:error.message||'Could not save record changes.'})}
        return send(res,200,{ok:true,version:db.prepare('SELECT version FROM metadata WHERE id=1').get().version});
      }
      if (req.method === 'PUT' && url.pathname === '/api/data') {
        if (!sameOrigin(req)) return send(res, 403, { error: 'Request origin rejected.' });
        const input = await body(req);
        if (!validateDocument(input)) return send(res, 400, { error: 'The saved data format is invalid.' });
        for (const bill of input.bills) { delete bill.photo; delete bill.photoCapturedAt; }
        const updatedAt = new Date().toISOString();
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = db.prepare('SELECT version FROM metadata WHERE id=1').get().version;
          const expected = Number(req.headers['if-match']);
          if (!Number.isInteger(expected) || expected !== current) {
            db.exec('ROLLBACK');
            return send(res, 409, { error: 'These records changed in another open app. Reload before saving again.', version: current });
          }
          db.prepare('DELETE FROM records').run();
          const insert = db.prepare('INSERT INTO records(collection,record_id,position,document) VALUES(?,?,?,?)');
          for (const collection of ['rooms','tenants','bills','payments','audit']) {
            input[collection].forEach((item, position) => insert.run(collection, String(item.id || `${collection}-${position}`), position, JSON.stringify(item)));
          }
          db.prepare('UPDATE app_settings SET document=? WHERE id=1').run(JSON.stringify(input.settings || { owner: 'Rental Admin', currency: '₹' }));
          db.prepare('UPDATE metadata SET updated_at=?,version=version+1 WHERE id=1').run(updatedAt);
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        return send(res, 200, { ok: true, updatedAt, version: db.prepare('SELECT version FROM metadata WHERE id=1').get().version });
      }
      return send(res, 404, { error: 'API route not found.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
    if (url.pathname !== '/' && url.pathname !== '/index.html') return send(res, 404, { error: 'Not found.' });
    const html = await readFile(path.join(root, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; worker-src 'self' blob: https://cdn.jsdelivr.net; connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    res.end(html);
  } catch (error) {
    console.error(error);
    send(res, error.status || 500, { error: error.status ? error.message : 'Server error.' });
  }
});
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && !process.env.PORT && port < 65535) {
    const previousPort = port;
    port++;
    console.warn(`Port ${previousPort} is already in use; trying ${port}.`);
    server.listen(port, host);
    return;
  }
  console.error(`Roomwise could not start: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`Roomwise listening at http://${host}:${port}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(() => { db.close(); process.exit(0); }); });
