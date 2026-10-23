import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {blankCar,profit} from '../src/model.ts';
import {expenseInput,expenseTotal} from '../src/expenses.ts';
const owner='00000000-0000-4000-8000-000000000001',partner='00000000-0000-4000-8000-000000000002',outsider='00000000-0000-4000-8000-000000000003';
const sid=id=>id.replace('4000','4001');
test('expense ledger: both members add, only owner deletes, actual totals and backup survive reload',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create table auth.sessions(id uuid primary key,user_id uuid,created_at timestamptz default now());create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function auth.jwt() returns jsonb language sql stable as $$select jsonb_build_object('session_id',current_setting('request.jwt.claim.session_id',true))$$;`);
 for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
 for(const id of [owner,partner,outsider]){await db.query('insert into auth.users values($1)',[id]);await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[sid(id),id]);}
 await db.query("insert into public.ap_members(id,email,name,role) values($1,'owner@example.com','Слава','owner'),($2,'partner@example.com','Партнер','partner')",[owner,partner]);
 async function as(id,sql,params=[]){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.session_id',$2,false)",[id||'',id?sid(id):'']);await db.exec('set role '+(id?'authenticated':'anon'));return db.query(sql,params)}
 async function rpc(id,fn,args=[]){return (await as(id,`select public.${fn}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args)).rows[0].value}
 const car={...blankCar,make:'Audi',model:'A1',photos:['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'],purchase:2000,expenses:400,minimum:2700,target:3000};
 const c=(await rpc(owner,'ap_save_car',[car])).car;
 await assert.rejects(rpc(partner,'ap_save_car',[{...car,photos:[]},c.id,1]),/лише власник/);
 const e={id:'00000000-0000-4000-8000-000000000010',carId:c.id,amount:120.55,date:'2026-10-23',note:'Масло'};
 await assert.rejects(rpc(outsider,'ap_expense_list'),/Немає доступу/);
 await assert.rejects(rpc(null,'ap_expense_list'),/permission denied/);
 await assert.rejects(rpc(owner,'ap_save_expense',[e]),/двох згод/);
 await rpc(owner,'ap_approve_car',[c.id,1]);await rpc(partner,'ap_approve_car',[c.id,1]);
 await rpc(partner,'ap_save_expense',[e]);await rpc(partner,'ap_save_expense',[e]);
 const e2={...e,id:'00000000-0000-4000-8000-000000000011',amount:280.05,note:'Ремонт'};await rpc(owner,'ap_save_expense',[e2]);
 const list=(await rpc(owner,'ap_expense_list')).entries;assert.equal(list.length,2);assert.equal(expenseTotal(list),400.6);assert.equal(list.find(x=>x.id===e.id).authorName,'Партнер');
 let live=(await rpc(partner,'ap_workspace')).cars[0];assert.equal(live.actualExpenses,400.6);assert.equal(live.expenseCount,2);assert.equal(profit(live),599.4);
 await assert.rejects(rpc(owner,'ap_save_expense',[{...e,amount:1}]),/іншими даними/);
 for(const bad of [{...e,id:'bad'},{...e,amount:-1},{...e,date:'2026-02-30'},{...e,note:' '}])await assert.rejects(rpc(owner,'ap_save_expense',[bad]));
 await assert.rejects(as(partner,'delete from public.ap_expense_entries where id=$1',[e.id]),/permission denied/);
 await assert.rejects(as(partner,'update public.ap_expense_entries set amount=1 where id=$1',[e.id]),/permission denied/);
 await assert.rejects(rpc(partner,'ap_delete_expense',[e.id,1]),/лише власник/);
 await assert.rejects(rpc(owner,'ap_delete_expense',[e.id,0]),/вже змінено/);
 await rpc(owner,'ap_delete_expense',[e.id,1]);
 assert.equal((await rpc(partner,'ap_expense_list')).entries.length,1);
 assert.equal((await as(partner,'select * from public.ap_expense_entries where id=$1',[e.id])).rows.length,0);
 live=(await rpc(owner,'ap_workspace')).cars[0];assert.equal(live.actualExpenses,280.05);assert.equal(profit(live),600); // approved budget is larger, never added twice
 const sold=(await rpc(owner,'ap_save_car',[{...car,status:'sold',actual:3000},c.id,1])).car;assert.equal(profit(sold,sold.actual),719.95); // sold uses actual ledger, not planned 400
 const backup=await rpc(owner,'ap_backup');assert.equal(backup.expenses.length,2);assert.ok(backup.expenses.find(x=>x.id===e.id).deletedAt);assert.equal(backup.expenses.find(x=>x.id===e.id).deletedBy,owner);
 await rpc(owner,'ap_delete_car',[c.id,2]);assert.equal((await rpc(partner,'ap_expense_list')).entries.length,0);assert.equal((await rpc(owner,'ap_backup')).expenses.length,2);
 await db.exec('reset role');const dump=await db.dumpDataDir();const restored=new PGlite({loadDataDir:dump});assert.equal((await restored.query('select count(*)::int n from public.ap_expense_entries')).rows[0].n,2);await restored.close();
 }finally{await db.close()}
});
test('expense amount precision and forecast calculations never count budget plus actual twice',()=>{
 const c={...blankCar,purchase:2000,expenses:400,target:3000};
 assert.equal(profit({...c,actualExpenses:150}),600);assert.equal(profit({...c,actualExpenses:500}),500);assert.equal(profit({...c,actualExpenses:150,status:'sold'}),850);
 assert.equal(expenseTotal([{amount:0.1},{amount:0.2}]),0.3);assert.equal(expenseInput.safeParse({id:owner,carId:partner,amount:0.001,date:'2026-10-23',note:'Tiny'}).success,false);
});
