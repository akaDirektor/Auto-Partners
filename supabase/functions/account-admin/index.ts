import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import {createHandler} from './handler.ts';
const url=Deno.env.get('SUPABASE_URL')!;
const anon=Deno.env.get('SUPABASE_ANON_KEY')!;
const service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
Deno.serve(createHandler({
 userClient:token=>createClient(url,anon,{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false}}),
 adminClient:()=>createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}),
 allowedOrigins:['https://akadirektor.github.io','http://localhost:3000','http://localhost:5173','http://127.0.0.1:5173'],
}));
