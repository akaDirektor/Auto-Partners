import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {blankCar,profit} from '../src/model.ts';
import {createHandler} from '../supabase/functions/account-admin/handler.ts';
const owner='00000000-0000-4000-8000-000000000001',partner='00000000-0000-4000-8000-000000000002',outsider='00000000-0000-4000-8000-000000000003';
const sid=u=>u.replace('4000','4001');
test('cloud database: two accounts, RLS, optimistic edits, validation, chat, backup and revoked sessions',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema auth;create table auth.users(id uuid primary key);create table auth.sessions(id uuid primary key,user_id uuid,created_at timestamptz default now());
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql stable as $$select jsonb_build_object('session_id',current_setting('request.jwt.claim.session_id',true))$$;`);
 await db.exec(await readFile(new URL('../supabase/migrations/202610210001_workspace.sql',import.meta.url),'utf8'));
 for(const u of [owner,partner,outsider]){
  await db.query('insert into auth.users values($1)',[u]);await db.query("insert into auth.sessions(id,user_id,created_at) values($1,$2,now()-interval '1 minute')",[sid(u),u]);
 }
 await db.query("insert into public.ap_members(id,email,name,role) values($1,'owner@example.com','Слава','owner'),($2,'partner@example.com','Партнер','partner')",[owner,partner]);
 const as=async(u,sql,params=[])=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session_id',$2,false)",[u||'',u?sid(u):'']);await db.exec('set role '+(u?'authenticated':'anon'));return db.query(sql,params)};
 const rpc=async(u,name,args=[],placeholders=args.map((_,i)=>'$'+(i+1)).join(','))=>(await as(u,`select public.${name}(${placeholders}) as value`,args)).rows[0].value;
 await assert.rejects(rpc(null,'ap_workspace'),/permission denied/);
 await assert.rejects(rpc(outsider,'ap_workspace'),/Немає доступу/);
 assert.equal((await rpc(owner,'ap_session')).user.role,'owner');
 assert.equal((await rpc(partner,'ap_session')).user.role,'partner');
 assert.deepEqual((await as(outsider,'select * from public.ap_cars')).rows,[]);
 await assert.rejects(rpc(partner,'ap_users'),/власник/);
 assert.equal((await as(partner,'select * from public.ap_members')).rows.length,1);
 const car={...blankCar,make:'Opel',model:'Astra',year:2012,engine:'1.6',gearbox:'Механіка',color:'Сірий',purchase:2000,expenses:400,minimum:2700,target:3000};
 const created=(await rpc(owner,'ap_save_car',[car])).car;assert.equal(created.version,1);
 assert.equal((await rpc(partner,'ap_workspace')).cars[0].id,created.id);
 const updated=(await rpc(partner,'ap_save_car',[{...car,target:3100},created.id,1])).car;
 assert.equal(updated.version,2);assert.equal(updated.updatedBy,'Партнер');
 await assert.rejects(rpc(owner,'ap_save_car',[car,created.id,1]),/Партнер уже оновив/);
 await assert.rejects(as(owner,'update public.ap_cars set version=99'),/permission denied/);
 await assert.rejects(rpc(owner,'ap_save_car',[{...car,target:2600}]),/Цільова ціна/);
 await assert.rejects(rpc(owner,'ap_save_car',[{...car,status:'sold'}]),/фактичну ціну/);
 for(const bad of [{...car,purchase:-1},{...car,boughtAt:'2026-02-30'},{...car,year:2012.5},{...car,model:''},{...car,url:'javascript:alert(1)'},{...car,expenses:'400'}])await assert.rejects(rpc(owner,'ap_save_car',[bad]));
 const sold=(await rpc(owner,'ap_save_car',[{...car,status:'sold',actual:3200},created.id,2])).car;
 assert.equal(profit(sold,sold.actual),800);assert.equal(profit(sold,sold.minimum),300);assert.equal(profit(sold),600);
 const msg=(await rpc(partner,'ap_send_message',['Готовий до продажу',created.id])).message;
 assert.equal(msg.authorName,'Партнер');assert.equal(msg.authorId,partner);assert.ok(msg.createdAt);
 await rpc(owner,'ap_send_message',['Загальний чат']);
 assert.equal((await rpc(partner,'ap_workspace')).messages.length,2);
 await assert.rejects(rpc(owner,'ap_send_message',[' ']),/Повідомлення/);
 await assert.rejects(rpc(partner,'ap_backup'),/власнику/);
 const backup=await rpc(owner,'ap_backup');assert.equal(backup.messages.length,2);assert.equal(backup.cars[0].actual,3200);assert.equal('users' in backup,false);
 await db.exec('reset role');
 await db.query("insert into public.ap_messages(body,author_id,author_name) select 'archive '||g,$1,'Слава' from generate_series(1,1001) g",[owner]);
 assert.equal((await rpc(owner,'ap_workspace')).messages.length,1000);assert.equal((await rpc(owner,'ap_backup')).messages.length,1003);
 await assert.rejects(rpc(owner,'ap_revoke_user',[partner]),/permission denied/);
 await db.exec('reset role;set role service_role');await db.query('select public.ap_revoke_user($1)',[partner]);
 await assert.rejects(rpc(partner,'ap_workspace'),/Сесія завершена/);
 assert.deepEqual((await as(partner,'select * from public.ap_cars')).rows,[]);
 // Refresh preserves the old session ID, so it cannot recover access after reset.
 await assert.rejects(rpc(partner,'ap_session'),/Сесія завершена/);
 await db.exec('reset role');await db.query('update auth.sessions set created_at=clock_timestamp()+interval \'1 second\' where id=$1',[sid(partner)]);
 assert.equal((await rpc(partner,'ap_session')).user.id,partner);
 // A persisted PostgreSQL snapshot retains the shared records.
 await db.exec('reset role');const dump=await db.dumpDataDir();const restored=new PGlite({loadDataDir:dump});
 assert.equal((await restored.query('select count(*)::int n from public.ap_cars')).rows[0].n,1);await restored.close();
 }finally{await db.close()}
});

test('account admin rejects anonymous/partner requests and rolls back a raced partner creation',async()=>{
 let calls=[];let role='owner';let insertFails=false;let sessionError=null;
 const admin={from:()=>({select:()=>({then:resolve=>resolve({data:[],error:null}),eq:()=>({maybeSingle:async()=>({data:{id:partner},error:null})})}),insert:async()=>({error:insertFails?{code:'23505'}:null})}),auth:{admin:{createUser:async()=>{calls.push('create');return {data:{user:{id:partner}}}},deleteUser:async id=>{calls.push(['rollback',id]);return {}},updateUserById:async()=>{calls.push('password');return {}}}},rpc:async()=>{calls.push('revoke');return {}}};
 const handler=createHandler({allowedOrigins:['https://akadirektor.github.io'],userClient:()=>({auth:{getUser:async()=>({data:{user:{id:owner}}})},rpc:async()=>({data:{user:{id:owner,role}},error:sessionError})}),adminClient:()=>admin});
 const req=(body,headers={Authorization:'Bearer test-token'})=>new Request('https://example.test',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await handler(req({},{}))).status,401);
 role='partner';assert.equal((await handler(req({}))).status,403);assert.equal(calls.length,0);
 role='owner';sessionError={code:'PT401'};assert.equal((await handler(req({}))).status,401);sessionError=null;
 assert.equal((await handler(req({action:'create',password:'short'}))).status,400);
 const password=randomBytes(24).toString('hex');const body={action:'create',email:'partner@example.com',name:'Партнер',password};
 assert.equal((await handler(req(body))).status,201);
 insertFails=true;assert.equal((await handler(req(body))).status,409);assert.deepEqual(calls.at(-1),['rollback',partner]);
 assert.equal((await handler(req({action:'password',id:partner,password}))).status,200);assert.deepEqual(calls.slice(-2),['password','revoke']);
 assert.equal((await handler(req(body,{Authorization:'Bearer test',Origin:'https://evil.example'}))).status,403);
});
