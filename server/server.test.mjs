import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';import {createApp} from './server.mjs';
test('two accounts share cars and chat; authorization and optimistic concurrency are enforced',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'auto-partners-test-'));const databasePath=join(folder,'test.sqlite');const ownerPass=randomBytes(20).toString('hex'),partnerPass=randomBytes(20).toString('hex');
 let app=await createApp({databasePath,secure:false,ownerEmail:'owner@example.com',ownerPassword:ownerPass,ownerName:'Слава'});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));let url=`http://127.0.0.1:${app.server.address().port}`;
 const call=async(path,{cookie,body,origin,method}={})=>{const r=await fetch(url+path,{method:method||(body?'POST':'GET'),headers:{...(cookie?{cookie}:{}),...(body?{'Content-Type':'application/json'}:{}),...(origin?{origin}:{})},body:body?JSON.stringify(body):undefined});const p=await r.json();return {status:r.status,p,cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 try{
  assert.equal((await call('/api/workspace')).status,401);
  assert.equal((await call('/api/login',{body:{email:'owner@example.com',password:'wrong'}})).status,401);
  const owner=await call('/api/login',{body:{email:'owner@example.com',password:ownerPass}});assert.equal(owner.status,200);assert.ok(owner.cookie);
  assert.equal((await call('/api/users',{cookie:owner.cookie,body:{email:'partner@example.com',name:'Партнер',password:partnerPass}})).status,201);
  assert.equal((await call('/api/users',{cookie:owner.cookie,body:{email:'third@example.com',name:'Third',password:partnerPass}})).status,400);
  const partner=await call('/api/login',{body:{email:'partner@example.com',password:partnerPass}});assert.equal(partner.status,200);
  assert.equal((await call('/api/users',{cookie:partner.cookie})).status,403);
  const car={make:'Opel',model:'Astra',year:2012,engine:'1.6',gearbox:'Механіка',color:'Сірий',purchase:2000,expenses:400,minimum:2700,target:3000,actual:null,boughtAt:'2026-10-17',sellBy:'2026-12-15',status:'bought',notes:'Перевірити стан',url:''};
  assert.equal((await call('/api/cars',{cookie:owner.cookie,body:{car},origin:'https://evil.example'})).status,403);
  assert.equal((await call('/api/cars',{cookie:owner.cookie,body:{car:{...car,target:1000}}})).status,400);
  const created=await call('/api/cars',{cookie:owner.cookie,body:{car}});assert.equal(created.status,200);const id=created.p.car.id;
  const view=await call('/api/workspace',{cookie:partner.cookie});assert.equal(view.p.cars[0].id,id);
  const updated=await call('/api/cars',{cookie:partner.cookie,body:{id,version:1,car:{...car,target:3100}}});assert.equal(updated.status,200);assert.equal(updated.p.car.version,2);
  assert.equal((await call('/api/cars',{cookie:owner.cookie,body:{id,version:1,car:{...car,target:3200}}})).status,409);
  const msg=await call('/api/messages',{cookie:partner.cookie,body:{carId:id,body:'Готовий до продажу'}});assert.equal(msg.status,200);assert.equal(msg.p.message.authorName,'Партнер');
  assert.equal((await call('/api/messages',{cookie:owner.cookie,body:{body:'Зустрінемось завтра'}})).status,200);
  const shared=await call('/api/workspace',{cookie:owner.cookie});assert.equal(shared.p.messages.length,2);assert.equal(shared.p.cars[0].target,3100);
  const backup=await call('/api/backup',{cookie:owner.cookie});assert.equal(backup.p.cars.length,1);assert.equal(backup.p.messages.length,2);assert.equal('users' in backup.p,false);
  assert.equal((await call('/api/backup',{cookie:partner.cookie})).status,403);
  assert.equal((await call('/api/logout',{cookie:partner.cookie,body:{}})).status,200);assert.equal((await call('/api/workspace',{cookie:partner.cookie})).status,401);
  await app.close();
  app=await createApp({databasePath,secure:false});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${app.server.address().port}`;
  const persisted=await call('/api/workspace',{cookie:owner.cookie});assert.equal(persisted.status,200);assert.equal(persisted.p.cars.length,1);assert.equal(persisted.p.messages.length,2);
  const partnerUser=(await call('/api/users',{cookie:owner.cookie})).p.users.find(u=>u.role==='partner');
  const relog=await call('/api/login',{body:{email:'partner@example.com',password:partnerPass}});assert.equal(relog.status,200);
  assert.equal((await call('/api/users/password',{cookie:owner.cookie,body:{id:partnerUser.id,password:randomBytes(20).toString('hex')}})).status,200);
  assert.equal((await call('/api/session',{cookie:relog.cookie})).status,401);
  for(let i=0;i<10;i++)assert.equal((await call('/api/login',{body:{email:'bad@example.com',password:'wrong'}})).status,401);
  assert.equal((await call('/api/login',{body:{email:'bad@example.com',password:'wrong'}})).status,429);
 }finally{await app.close();await rm(folder,{recursive:true,force:true});}
});
