// Kept independent of Deno so authorization and rollback can be tested with node:test.
export function createHandler({userClient,adminClient,allowedOrigins}:{userClient:(token:string)=>any;adminClient:()=>any;allowedOrigins:string[]}){
 return async(req:Request):Promise<Response>=>{
  const origin=req.headers.get('origin')||'';
  const cors={'Access-Control-Allow-Origin':allowedOrigins.includes(origin)?origin:allowedOrigins[0],
   'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
   'Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin','Cache-Control':'no-store'};
  const json=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers:{...cors,'Content-Type':'application/json'}});
  if(origin&&!allowedOrigins.includes(origin))return json(403,{error:'Недозволене джерело запиту.'});
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  if(req.method!=='POST')return json(405,{error:'Метод не підтримується.'});
  const token=req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if(!token)return json(401,{error:'Потрібен вхід.'});
  try{
   const client=userClient(token);
   const {data:auth,error:authError}=await client.auth.getUser(token);
   if(authError||!auth.user)return json(401,{error:'Потрібен вхід.'});
   const {data:session,error:sessionError}=await client.rpc('ap_session');
   if(sessionError)return json(sessionError.code==='PT403'?403:401,{error:'Сесія завершена або немає доступу.'});
   if(session.user.role!=='owner')return json(403,{error:'Керувати доступом може власник.'});
   if(!req.headers.get('content-type')?.startsWith('application/json'))return json(415,{error:'Потрібен JSON-запит.'});
   // Read byte limits even if the caller omits Content-Length.
   const reader=req.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
   if(reader){while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>32000){await reader.cancel();return json(413,{error:'Завеликий запит.'})}chunks.push(value)}}
   const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength}
   let p:any;try{p=JSON.parse(new TextDecoder().decode(bytes))}catch{return json(400,{error:'Некоректний JSON.'})}
   if(!p||!['create','password'].includes(p.action)||typeof p.password!=='string'||p.password.length<12||p.password.length>128)return json(400,{error:'Вкажи пароль із 12–128 символів.'});
   const admin=adminClient();
   if(p.action==='create'){
    if(typeof p.email!=='string'||p.email.length>254||!/^\S+@\S+\.\S+$/.test(p.email)||typeof p.name!=='string'||!p.name.trim()||p.name.length>80)return json(400,{error:'Перевір ім’я та email.'});
    const {data:existing,error:listError}=await admin.from('ap_members').select('id');
    if(listError)throw Error('list');if(existing.length>=2)return json(400,{error:'У просторі вже є два користувачі.'});
    const {data:created,error:createError}=await admin.auth.admin.createUser({email:p.email.toLowerCase().trim(),password:p.password,email_confirm:true});
    if(createError||!created.user)return json(400,{error:'Не вдалося створити акаунт. Перевір email та вимоги до пароля.'});
    const profile={id:created.user.id,email:p.email.toLowerCase().trim(),name:p.name.trim(),role:'partner'};
    const {error:insertError}=await admin.from('ap_members').insert(profile);
    if(insertError){
     // A unique role constraint handles two concurrent requests. Only roll back
     // the Auth account just created by THIS request, never an existing user.
     const {error:rollbackError}=await admin.auth.admin.deleteUser(created.user.id);
     if(rollbackError)console.error('AutoPartners account rollback failed; inspect Auth users.');
     return json(409,{error:'Не вдалося додати партнера. Онови список користувачів.'});
    }
    return json(201,{user:profile});
   }
   if(typeof p.id!=='string')return json(400,{error:'Перевір користувача.'});
   const {data:target,error:targetError}=await admin.from('ap_members').select('id').eq('id',p.id).maybeSingle();
   if(targetError)throw Error('target');if(!target)return json(404,{error:'Користувача не знайдено.'});
   const {error:updateError}=await admin.auth.admin.updateUserById(p.id,{password:p.password});
   if(updateError)return json(400,{error:'Не вдалося змінити пароль. Перевір вимоги до пароля.'});
   const {error:revokeError}=await admin.rpc('ap_revoke_user',{p_id:p.id});
   if(revokeError)return json(500,{error:'Пароль змінено, але відкликання сесій не завершено. Повтори зміну пароля.'});
   return json(200,{ok:true});
  }catch{return json(500,{error:'Не вдалося виконати запит. Перевір налаштування серверної функції.'})}
 };
}
