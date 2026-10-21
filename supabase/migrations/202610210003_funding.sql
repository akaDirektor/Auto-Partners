begin;
create table if not exists public.ap_funding_entries(
 id uuid primary key,
 kind text not null check(kind in ('funding','repayment')),
 amount numeric(12,2) not null check(amount>0 and amount<=10000000),
 date date not null,
 note text not null default '' check(length(note)<=1000),
 author_id uuid not null references public.ap_members(id),
 author_name text not null,
 created_at timestamptz not null default now()
);
alter table public.ap_funding_entries enable row level security;
drop policy if exists ap_funding_read on public.ap_funding_entries;
create policy ap_funding_read on public.ap_funding_entries for select to authenticated using((public.ap_identity()).id is not null);
revoke all on public.ap_funding_entries from public,anon,authenticated;
grant select on public.ap_funding_entries to authenticated;
grant all on public.ap_funding_entries to service_role;
create or replace function public.ap_funding_json(e public.ap_funding_entries) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',e.id,'kind',e.kind,'amount',e.amount,'date',e.date,'note',e.note,'authorName',e.author_name,'createdAt',e.created_at)
$$;
create or replace function public.ap_funding_list() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform public.ap_require_member();
 return jsonb_build_object('entries',coalesce((select jsonb_agg(public.ap_funding_json(e) order by e.date desc,e.created_at desc,e.id) from public.ap_funding_entries e),'[]'::jsonb));
end $$;
create or replace function public.ap_save_funding(p_entry jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();e public.ap_funding_entries;entry_id uuid;k text;a numeric;d date;n text;
begin
 if m.role<>'owner' then raise sqlstate 'PT403' using message='Операції фінансування вносить лише власник.';end if;
 begin
  if jsonb_typeof(p_entry) is distinct from 'object' or jsonb_typeof(p_entry->'id') is distinct from 'string' or jsonb_typeof(p_entry->'kind') is distinct from 'string' or jsonb_typeof(p_entry->'amount') is distinct from 'number' or jsonb_typeof(p_entry->'date') is distinct from 'string' or jsonb_typeof(p_entry->'note') is distinct from 'string' then raise exception 'Некоректні поля';end if;
  entry_id:=(p_entry->>'id')::uuid;k:=p_entry->>'kind';a:=round((p_entry->>'amount')::numeric,2);n:=btrim(p_entry->>'note');d:=(p_entry->>'date')::date;
  if k not in ('funding','repayment') or a<=0 or a>10000000 or length(n)>1000 or p_entry->>'date'!~ '^\d{4}-\d{2}-\d{2}$' or to_char(d,'YYYY-MM-DD')<>p_entry->>'date' then raise exception 'Некоректні поля';end if;
 exception when others then raise sqlstate 'PT400' using message='Перевір тип операції, суму, дату й примітку.';end;
 insert into public.ap_funding_entries(id,kind,amount,date,note,author_id,author_name) values(entry_id,k,a,d,n,m.id,m.name) on conflict(id) do nothing;
 select * into e from public.ap_funding_entries where id=entry_id;
 if e.kind<>k or e.amount<>a or e.date<>d or e.note<>n or e.author_id<>m.id then raise sqlstate 'PT409' using message='Ця операція вже існує з іншими даними.';end if;
 return jsonb_build_object('entry',public.ap_funding_json(e));
end $$;
revoke all on function public.ap_funding_json(public.ap_funding_entries),public.ap_funding_list(),public.ap_save_funding(jsonb) from public,anon,authenticated;
grant execute on function public.ap_funding_list(),public.ap_save_funding(jsonb) to authenticated;
create or replace function public.ap_backup() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();
begin
 if m.role<>'owner' then raise sqlstate 'PT403' using message='Експорт доступний власнику.';end if;
 return jsonb_build_object('version',1,'createdAt',now(),'funding',coalesce((select jsonb_agg(public.ap_funding_json(e) order by e.date,e.created_at,e.id) from public.ap_funding_entries e),'[]'::jsonb),
 'cars',coalesce((select jsonb_agg(public.ap_car_json(c) order by c.created_at,c.id) from public.ap_cars c),'[]'::jsonb),
 'messages',coalesce((select jsonb_agg(public.ap_message_json(msg) order by msg.created_at,msg.id) from public.ap_messages msg),'[]'::jsonb));
end $$;
commit;
