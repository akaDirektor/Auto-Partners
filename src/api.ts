import {createClient} from '@supabase/supabase-js';

// These are public connection parameters. Authorization is enforced by Postgres RLS/RPC.
export const cloudEnabled=import.meta.env.VITE_DATA_BACKEND==='supabase';
const projectUrl='https://ruurcyasujttenkcpgfh.supabase.co';
const publicKey='sb_publishable_sx5yh_W7TrKBRkPxGrf-dg_-od81YAX';
const cloud=cloudEnabled?createClient(projectUrl,publicKey,{auth:{storageKey:'auto-partners-auth',persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}}):null;
const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function errorStatus(error:{code?:string;status?:number}){return error.status||({'PT401':401,'PT403':403,'PT409':409,'PT400':400,'PT404':404}[error.code||'']??500)}
export async function apiFetch(path:string,init:RequestInit={}):Promise<Response>{
 if(!cloud)return fetch(path,init);
 try{
  const body=init.body?JSON.parse(String(init.body)):{};
  if(path==='/api/login'){
   const {error}=await cloud.auth.signInWithPassword(body);
   if(error)return reply({error:'Не вдалося увійти. Перевір email і пароль або спробуй пізніше.'},error.status===429?429:401);
   const {data,error:accessError}=await cloud.rpc('ap_session');
   if(accessError){await cloud.auth.signOut({scope:'local'});return reply({error:'Для цього акаунта немає доступу до простору. Звернися до власника.'},403)}
   return reply(data);
  }
  if(path==='/api/logout'){await cloud.auth.signOut();return reply({ok:true})}
  const {data:session}=await cloud.auth.getSession();
  if(!session.session)return reply({error:'Потрібен вхід.'},401);
  if(path==='/api/users'&&init.method==='POST'||path==='/api/users/password'){
   const {data,error}=await cloud.functions.invoke('account-admin',{body:{action:path.endsWith('/password')?'password':'create',...body}});
   if(error){let message='Не вдалося змінити доступ. Перевір налаштування серверної функції.';let status=errorStatus(error);if('context' in error&&error.context instanceof Response){status=error.context.status;const value=await error.context.json().catch(()=>null);message=value?.error||message}return reply({error:message},status)}
   if(body.id===session.session.user.id&&path.endsWith('/password')){await cloud.auth.signOut({scope:'local'});window.dispatchEvent(new Event('auto-partners-session-ended'))}
   return reply(data,path==='/api/users'?201:200);
  }
  if(path==='/api/cars'&&body.car?.photos?.length){const {error}=await cloud.rpc('ap_photo_ready');if(error)return reply({error:'Для збереження фотографій спочатку виконай SQL-оновлення фотографій у Supabase.'},503)}
  if(path==='/api/funding'){const {data,error}=await cloud.rpc(init.method==='POST'?'ap_save_funding':'ap_funding_list',init.method==='POST'?{p_entry:body.entry}:{});if(error)return reply({error:error.code==='PGRST202'?'Для обліку інвестицій спочатку виконай SQL-оновлення фінансування в Supabase.':error.message},error.code==='PGRST202'?503:errorStatus(error));return reply(data)}
  const routes:Record<string,[string,Record<string,unknown>]>={
   '/api/session':['ap_session',{}],'/api/workspace':['ap_workspace',{}],
   '/api/cars/delete':['ap_delete_car',{p_id:body.id,p_version:body.version}],
   '/api/cars':['ap_save_car',{p_car:body.car,p_id:body.id??null,p_version:body.version??null}],
   '/api/messages':['ap_send_message',{p_body:body.body,p_car_id:body.carId??null}],
   '/api/users':['ap_users',{}],'/api/backup':['ap_backup',{}],
  };
  const route=routes[path];if(!route)return reply({error:'Не знайдено.'},404);
  const {data,error}=await cloud.rpc(route[0],route[1]);
  if(error){const status=errorStatus(error);if(status===401){await cloud.auth.signOut({scope:'local'});window.dispatchEvent(new Event('auto-partners-session-ended'))}return reply({error:error.code==='PGRST202'&&path==='/api/cars/delete'?'Для видалення спочатку виконай SQL-оновлення прав власника в Supabase.':status<500?error.message:'Не вдалося завантажити дані. Перевір підключення та налаштування Supabase.'},status)}
  return reply(data);
 }catch{return reply({error:'Не вдалося підключитися. Спробуй ще раз.'},503)}
}
export async function downloadBackup(){
 const r=await apiFetch('/api/backup');const data=await r.json();if(!r.ok)throw Error(data.error);
 const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download='auto-partners-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
