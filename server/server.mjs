import {fundingInput} from '../src/funding.ts';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID,scrypt as scryptCallback,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {mkdirSync,existsSync,createReadStream,statSync} from 'node:fs';
import {dirname,join,resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {carInput} from '../src/model.ts';
const scrypt=promisify(scryptCallback),root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const hashToken=t=>createHash('sha256').update(t).digest('hex');
const safeUser=u=>({id:u.id,name:u.name,email:u.email,role:u.role});
export async function passwordHash(password){const salt=randomBytes(16).toString('hex');const key=await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});return `scrypt$${salt}$${key.toString('hex')}`;}
export async function passwordMatches(password,stored){const [,salt,hash]=stored.split('$');const key=await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});const expected=Buffer.from(hash,'hex');return key.length===expected.length&&timingSafeEqual(key,expected);}
const fail=(status,message)=>Object.assign(new Error(message),{status});
const emailValid=s=>typeof s==='string'&&s.length<255&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
export async function createApp({databasePath=process.env.DATABASE_PATH||join(root,'data/app.sqlite'),publicUrl=process.env.PUBLIC_URL||'',secure=process.env.NODE_ENV==='production',ownerEmail=process.env.OWNER_EMAIL,ownerName=process.env.OWNER_NAME||'Слава',ownerPassword=process.env.OWNER_PASSWORD}={}){
 if(databasePath!==':memory:')mkdirSync(dirname(databasePath),{recursive:true});
 const db=new DatabaseSync(databasePath);db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;');
 db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','partner')),created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,window_start INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS cars(id TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 1,payload TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id));
 CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,car_id TEXT REFERENCES cars(id),body TEXT NOT NULL,author_id TEXT NOT NULL REFERENCES users(id),author_name TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS funding_entries(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('funding','repayment')),amount REAL NOT NULL CHECK(amount>0),date TEXT NOT NULL,note TEXT NOT NULL,author_id TEXT NOT NULL REFERENCES users(id),author_name TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS messages_car_date ON messages(car_id,created_at);`);
 if(!db.prepare('SELECT id FROM users LIMIT 1').get()){
  if(!emailValid(ownerEmail)||!ownerPassword||ownerPassword.length<12||ownerPassword.length>128||ownerPassword.startsWith('replace-with-')){db.close();throw Error('Перший запуск: встанови OWNER_EMAIL та унікальний OWNER_PASSWORD (12–128 символів).');}
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(randomUUID(),ownerEmail.toLowerCase().trim(),ownerName,await passwordHash(ownerPassword),'owner',new Date().toISOString());
 }
 const dummyHash=await passwordHash(randomBytes(32).toString('hex'));
 const sessionFrom=req=>{const token=String(req.headers.cookie||'').match(/(?:^|;\s*)auto_session=([a-f0-9]{64})(?:;|$)/)?.[1];if(!token)return null;return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(hashToken(token),Date.now())||null;};
 const cookie=(token,age)=>`auto_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secure?'; Secure':''}`;
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
 const body=async req=>{if(!String(req.headers['content-type']||'').startsWith('application/json'))throw fail(415,'Потрібен JSON-запит.');let text='';for await(const chunk of req){text+=chunk.toString();if(Buffer.byteLength(text)>1100000)throw fail(413,'Завеликий запит.');}try{return JSON.parse(text)}catch{throw fail(400,'Некоректний JSON.')}};
 const asCar=r=>({...JSON.parse(r.payload),id:r.id,version:r.version,createdAt:r.created_at,updatedAt:r.updated_at,updatedBy:r.updated_by,createdBy:r.created_by});
 const asMessage=r=>({id:r.id,carId:r.car_id,body:r.body,authorId:r.author_id,authorName:r.author_name,createdAt:r.created_at});
 const asFunding=e=>({id:e.id,kind:e.kind,amount:e.amount,date:e.date,note:e.note,authorName:e.author_name,createdAt:e.created_at});
 const handler=async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try{
   const url=new URL(req.url||'/','http://localhost');const path=url.pathname;const user=sessionFrom(req);
   if(path==='/api/health'&&req.method==='GET')return json(res,200,{ok:true});
   if(req.method!=='GET'&&req.method!=='HEAD'){
    const expected=publicUrl?new URL(publicUrl).origin:`http://${req.headers.host}`;
    if(req.headers.origin&&req.headers.origin!==expected)throw fail(403,'Недозволене джерело запиту.');
   }
   if(path==='/api/session'&&req.method==='GET')return user?json(res,200,{user:safeUser(user)}):json(res,401,{error:'Потрібен вхід.'});
   if(path==='/api/login'&&req.method==='POST'){
    const p=await body(req);if(!emailValid(p?.email)||typeof p.password!=='string'||p.password.length>128)throw fail(400,'Перевір email і пароль.');
    const email=p.email.toLowerCase().trim();const now=Date.now();const key=hashToken(email);const limit=db.prepare('SELECT * FROM login_attempts WHERE key=?').get(key);
    if(limit&&now-limit.window_start<10*60*1000&&limit.count>=10)throw fail(429,'Забагато спроб. Спробуй через 10 хвилин.');
    db.prepare('INSERT INTO login_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN excluded.window_start-login_attempts.window_start>600000 THEN 1 ELSE login_attempts.count+1 END,window_start=CASE WHEN excluded.window_start-login_attempts.window_start>600000 THEN excluded.window_start ELSE login_attempts.window_start END').run(key,now);
    const found=db.prepare('SELECT * FROM users WHERE email=?').get(email);const matches=await passwordMatches(p.password,found?.password_hash||dummyHash);
    if(!found||!matches)throw fail(401,'Неправильний email або пароль.');
    db.prepare('DELETE FROM login_attempts WHERE key=?').run(key);db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now);
    const token=randomBytes(32).toString('hex');db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hashToken(token),found.id,now+7*86400000);
    res.setHeader('Set-Cookie',cookie(token,7*86400));return json(res,200,{user:safeUser(found)});
   }
   if(path.startsWith('/api/')){
    if(!user)throw fail(401,'Сесія завершилася. Увійди знову.');
    if(path==='/api/logout'&&req.method==='POST'){const token=String(req.headers.cookie||'').match(/auto_session=([a-f0-9]{64})/)?.[1];if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));res.setHeader('Set-Cookie',cookie('',0));return json(res,200,{ok:true});}
    if(path==='/api/workspace'&&req.method==='GET'){return json(res,200,{cars:db.prepare('SELECT * FROM cars ORDER BY created_at DESC').all().map(asCar),messages:db.prepare('SELECT * FROM (SELECT * FROM messages ORDER BY created_at DESC LIMIT 1000) ORDER BY created_at').all().map(asMessage),user:safeUser(user)});}
    if(path==='/api/cars'&&req.method==='POST'){
     const p=await body(req);const parsed=carInput.safeParse(p?.car);if(!parsed.success)throw fail(400,parsed.error.issues[0]?.message||'Перевір поля.');const now=new Date().toISOString();let id=p.id;
     if(id){if(typeof id!=='string'||!Number.isInteger(p.version))throw fail(400,'Некоректна версія.');const result=db.prepare('UPDATE cars SET payload=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND version=?').run(JSON.stringify(parsed.data),now,user.name,id,p.version);if(!result.changes)throw fail(409,'Партнер уже оновив автомобіль. Закрий форму й відкрий її знову.');}
     else{id=randomUUID();db.prepare('INSERT INTO cars VALUES(?,1,?,?,?,?,?)').run(id,JSON.stringify(parsed.data),now,now,user.name,user.id);}
     return json(res,200,{car:asCar(db.prepare('SELECT * FROM cars WHERE id=?').get(id))});
    }
    if(path==='/api/messages'&&req.method==='POST'){
     const p=await body(req);if(typeof p?.body!=='string'||!p.body.trim()||p.body.length>5000)throw fail(400,'Повідомлення має містити 1–5000 символів.');if(p.carId!=null&&typeof p.carId!=='string')throw fail(400,'Некоректний автомобіль.');const carId=p.carId||null;
     if(carId&&!db.prepare('SELECT id FROM cars WHERE id=?').get(carId))throw fail(404,'Автомобіль не знайдено.');const id=randomUUID();db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(id,carId,p.body.trim(),user.id,user.name,new Date().toISOString());return json(res,200,{message:asMessage(db.prepare('SELECT * FROM messages WHERE id=?').get(id))});
    }
    if(path==='/api/users'&&req.method==='GET'){if(user.role!=='owner')throw fail(403,'Керувати доступом може власник.');return json(res,200,{users:db.prepare('SELECT * FROM users ORDER BY created_at').all().map(safeUser)});}
    if(path==='/api/users'&&req.method==='POST'){
     if(user.role!=='owner')throw fail(403,'Керувати доступом може власник.');const p=await body(req);
     if(!emailValid(p?.email)||typeof p.name!=='string'||!p.name.trim()||p.name.length>80||typeof p.password!=='string'||p.password.length<12||p.password.length>128)throw fail(400,'Вкажи ім’я, email і пароль із 12–128 символів.');
     if(db.prepare('SELECT COUNT(*) n FROM users').get().n>=2)throw fail(400,'У просторі вже є два користувачі.');const id=randomUUID();try{db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id,p.email.toLowerCase().trim(),p.name.trim(),await passwordHash(p.password),'partner',new Date().toISOString());}catch{throw fail(400,'Цей email уже використовується.');}return json(res,201,{user:safeUser(db.prepare('SELECT * FROM users WHERE id=?').get(id))});
    }
    if(path==='/api/users/password'&&req.method==='POST'){
     if(user.role!=='owner')throw fail(403,'Керувати доступом може власник.');const p=await body(req);if(typeof p?.id!=='string'||typeof p.password!=='string'||p.password.length<12||p.password.length>128)throw fail(400,'Пароль має містити 12–128 символів.');
     const result=db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await passwordHash(p.password),p.id);if(!result.changes)throw fail(404,'Користувача не знайдено.');db.prepare('DELETE FROM sessions WHERE user_id=?').run(p.id);return json(res,200,{ok:true});
    }
    if(path==='/api/funding'&&req.method==='GET')return json(res,200,{entries:db.prepare('SELECT * FROM funding_entries ORDER BY date DESC,created_at DESC,id').all().map(asFunding)});
    if(path==='/api/funding'&&req.method==='POST'){
     if(user.role!=='owner')throw fail(403,'Операції фінансування вносить лише власник.');const p=await body(req);const parsed=fundingInput.safeParse(p?.entry);if(!parsed.success)throw fail(400,'Перевір тип операції, суму, дату й примітку.');const e=parsed.data;
     db.prepare('INSERT INTO funding_entries VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(e.id,e.kind,e.amount,e.date,e.note,user.id,user.name,new Date().toISOString());const row=db.prepare('SELECT * FROM funding_entries WHERE id=?').get(e.id);
     if(row.kind!==e.kind||row.amount!==e.amount||row.date!==e.date||row.note!==e.note||row.author_id!==user.id)throw fail(409,'Ця операція вже існує з іншими даними.');return json(res,200,{entry:asFunding(row)});
    }
    if(path==='/api/backup'&&req.method==='GET'){
     if(user.role!=='owner')throw fail(403,'Експорт доступний власнику.');res.setHeader('Content-Disposition','attachment; filename="auto-partners-backup.json"');return json(res,200,{funding:db.prepare('SELECT * FROM funding_entries ORDER BY date,created_at,id').all().map(asFunding),version:1,createdAt:new Date().toISOString(),cars:db.prepare('SELECT * FROM cars').all().map(asCar),messages:db.prepare('SELECT * FROM messages').all().map(asMessage)});
    }
    throw fail(404,'Не знайдено.');
   }
   if(!['GET','HEAD'].includes(req.method))throw fail(405,'Метод не підтримується.');
   const dist=join(root,'dist');const local=resolve(dist,'.'+decodeURIComponent(path));if(local!==dist&&!local.startsWith(dist+'/'))throw fail(404,'Не знайдено.');
   const isFile=existsSync(local)&&statSync(local).isFile();const file=isFile?local:join(dist,'index.html');if(!existsSync(file))throw fail(503,'Виконай npm run build.');
   if(!isFile&&extname(path))throw fail(404,'Не знайдено.');const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json','.webmanifest':'application/manifest+json'};
   res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':extname(file)==='.html'?'no-cache':'public, max-age=3600'});if(req.method==='HEAD')res.end();else createReadStream(file).pipe(res);
  }catch(e){if(!e.status)console.error('Request failed',e);json(res,e.status||500,{error:e.status?e.message:'Не вдалося виконати запит.'});}
 };
 const server=http.createServer((req,res)=>{handler(req,res).catch(e=>{console.error(e);if(!res.headersSent)json(res,500,{error:'Помилка сервера.'});else res.end();});});
 return {server,db,close:()=>new Promise((resolve,reject)=>server.close(error=>{db.close();error?reject(error):resolve();}))};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.env.NODE_ENV==='production'&&!process.env.PUBLIC_URL)throw Error('Для production встанови PUBLIC_URL=https://адреса-застосунку.');
 const app=await createApp();app.server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log(`АвтоПартнери працює на порту ${process.env.PORT||3000}`));
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().then(()=>process.exit(0)));
}
