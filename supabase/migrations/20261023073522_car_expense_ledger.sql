-- Actual payments are a separate ledger from the approved planned expense budget.
create table if not exists public.ap_expense_entries(
 id uuid primary key,car_id uuid not null references public.ap_cars(id),
 amount numeric(12,2) not null check(amount>0 and amount<=10000000),
 date date not null,note text not null check(length(btrim(note)) between 1 and 1000),
 author_id uuid not null references public.ap_members(id),author_name text not null,
 created_at timestamptz not null default now(),version integer not null default 1,
 deleted_at timestamptz,deleted_by uuid references public.ap_members(id)
);
create index if not exists ap_expense_car_date on public.ap_expense_entries(car_id,date);
alter table public.ap_expense_entries enable row level security;
do $policy$ begin
 if not exists(select 1 from pg_policies where schemaname='public' and tablename='ap_expense_entries' and policyname='ap_expenses_read') then
  create policy ap_expenses_read on public.ap_expense_entries for select to authenticated using(
   (public.ap_identity()).id is not null and deleted_at is null and exists(select 1 from public.ap_cars c where c.id=car_id and c.payload->>'deleted' is distinct from 'true'));
 end if;
end $policy$;
revoke all on public.ap_expense_entries from public,anon,authenticated;
grant select on public.ap_expense_entries to authenticated;
grant all on public.ap_expense_entries to service_role;
create or replace function public.ap_expense_json(e public.ap_expense_entries) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',e.id,'carId',e.car_id,'amount',e.amount,'date',e.date,'note',e.note,'version',e.version,'authorName',e.author_name,'createdAt',e.created_at)
$$;
create or replace function public.ap_expense_list() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform public.ap_require_member();
 return jsonb_build_object('entries',coalesce((select jsonb_agg(public.ap_expense_json(e) order by e.date desc,e.created_at desc,e.id) from public.ap_expense_entries e join public.ap_cars c on c.id=e.car_id where e.deleted_at is null and c.payload->>'deleted' is distinct from 'true'),'[]'::jsonb));
end $$;
create or replace function public.ap_save_expense(p_entry jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();e public.ap_expense_entries;c public.ap_cars;entry_id uuid;car_id uuid;a numeric;d date;n text;
begin
 begin
  if jsonb_typeof(p_entry) is distinct from 'object' or jsonb_typeof(p_entry->'id') is distinct from 'string' or jsonb_typeof(p_entry->'carId') is distinct from 'string' or jsonb_typeof(p_entry->'amount') is distinct from 'number' or jsonb_typeof(p_entry->'date') is distinct from 'string' or jsonb_typeof(p_entry->'note') is distinct from 'string' then raise exception 'Invalid fields';end if;
  entry_id:=(p_entry->>'id')::uuid;car_id:=(p_entry->>'carId')::uuid;a:=round((p_entry->>'amount')::numeric,2);d:=(p_entry->>'date')::date;n:=btrim(p_entry->>'note');
  if a<=0 or a>10000000 or length(n) not between 1 and 1000 or p_entry->>'date'!~ '^\d{4}-\d{2}-\d{2}$' or to_char(d,'YYYY-MM-DD')<>p_entry->>'date' then raise exception 'Invalid fields';end if;
 exception when others then raise sqlstate 'PT400' using message='Перевір автомобіль, суму, дату та опис витрати.';end;
 select * into c from public.ap_cars where id=car_id and payload->>'deleted' is distinct from 'true' for update;
 if not found then raise sqlstate 'PT404' using message='Автомобіль не знайдено.';end if;
 select * into e from public.ap_expense_entries where id=entry_id;
 if found then
  if e.deleted_at is not null or e.car_id<>car_id or e.amount<>a or e.date<>d or e.note<>n or e.author_id<>m.id then raise sqlstate 'PT409' using message='Цей запис уже існує з іншими даними.';end if;
  return jsonb_build_object('entry',public.ap_expense_json(e));
 end if;
 if not (public.ap_approval(c)->>'approved')::boolean then raise sqlstate 'PT403' using message='Витрати можна вносити лише після двох згод за автомобілем.';end if;
 insert into public.ap_expense_entries(id,car_id,amount,date,note,author_id,author_name) values(entry_id,car_id,a,d,n,m.id,m.name) on conflict(id) do nothing;
 select * into e from public.ap_expense_entries where id=entry_id;
 if e.car_id<>car_id or e.amount<>a or e.date<>d or e.note<>n or e.author_id<>m.id or e.deleted_at is not null then raise sqlstate 'PT409' using message='Цей запис уже існує з іншими даними.';end if;
 return jsonb_build_object('entry',public.ap_expense_json(e));
end $$;
create or replace function public.ap_delete_expense(p_id uuid,p_version integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();
begin
 if m.role<>'owner' then raise sqlstate 'PT403' using message='Видаляти записи може лише власник.';end if;
 if p_id is null or p_version is null then raise sqlstate 'PT400' using message='Перевір запис і версію.';end if;
 update public.ap_expense_entries set deleted_at=clock_timestamp(),deleted_by=m.id,version=version+1 where id=p_id and version=p_version and deleted_at is null;
 if not found then raise sqlstate 'PT409' using message='Витрату вже змінено або видалено.';end if;
 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.ap_expense_json(public.ap_expense_entries),public.ap_expense_list(),public.ap_save_expense(jsonb),public.ap_delete_expense(uuid,integer) from public,anon,authenticated;
grant execute on function public.ap_expense_list(),public.ap_save_expense(jsonb),public.ap_delete_expense(uuid,integer) to authenticated;
create or replace function public.ap_car_json(c public.ap_cars) returns jsonb language sql stable security definer set search_path='' as $$
 select c.payload||jsonb_build_object('id',c.id,'version',c.version,'createdAt',c.created_at,'updatedAt',c.updated_at,'updatedBy',c.updated_by,'createdBy',c.created_by,'approval',public.ap_approval(c),
 'actualExpenses',coalesce((select sum(e.amount) from public.ap_expense_entries e where e.car_id=c.id and e.deleted_at is null),0),
 'expenseCount',(select count(*) from public.ap_expense_entries e where e.car_id=c.id and e.deleted_at is null))
$$;
create or replace function public.ap_backup() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();
begin
 if m.role<>'owner' then raise sqlstate 'PT403' using message='Експорт доступний власнику.';end if;
 return jsonb_build_object('version',1,'createdAt',now(),
 'funding',coalesce((select jsonb_agg(public.ap_funding_json(e) order by e.date,e.created_at,e.id) from public.ap_funding_entries e),'[]'::jsonb),
 'expenses',coalesce((select jsonb_agg(public.ap_expense_json(e)||jsonb_build_object('deletedAt',e.deleted_at,'deletedBy',e.deleted_by) order by e.date,e.created_at,e.id) from public.ap_expense_entries e),'[]'::jsonb),
 'cars',coalesce((select jsonb_agg(public.ap_car_json(c) order by c.created_at,c.id) from public.ap_cars c),'[]'::jsonb),
 'messages',coalesce((select jsonb_agg(public.ap_message_json(msg) order by msg.created_at,msg.id) from public.ap_messages msg),'[]'::jsonb),
 'approvalHistory',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.ap_car_approvals a),'[]'::jsonb));
end $$;

-- A partner may add/reorder photos, but only the owner may remove persisted photos.
create or replace function public.ap_save_car(p_car jsonb,p_id uuid default null,p_version integer default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();c public.ap_cars;clean jsonb:=public.ap_validate_car(p_car);changed boolean;
begin
 if p_id is null then
  clean:=clean||jsonb_build_object('status','planned','actual',null);
  insert into public.ap_cars(payload,updated_by,created_by) values(clean,m.name,m.id) returning * into c;
 else
  select * into c from public.ap_cars where id=p_id and payload->>'deleted' is distinct from 'true' for update;
  if not found or p_version is null or c.version<>p_version then raise sqlstate 'PT409' using message='Партнер уже оновив автомобіль. Закрий форму й відкрий її знову.';end if;
  if m.role<>'owner' and exists(select 1 from jsonb_array_elements_text(coalesce(c.payload->'photos','[]'::jsonb)) photo where not coalesce(clean->'photos','[]'::jsonb) @> jsonb_build_array(photo)) then raise sqlstate 'PT403' using message='Видаляти збережені фото може лише власник.';end if;
  changed:=public.ap_proposal(clean) is distinct from public.ap_proposal(c.payload);
  if changed then clean:=clean||jsonb_build_object('status','planned');
  elsif clean->>'status'<>'planned' and not (public.ap_approval(c)->>'approved')::boolean then raise sqlstate 'PT403' using message='Спочатку потрібні дві згоди: власника та партнера.';end if;
  update public.ap_cars set payload=clean,version=version+1,approval_revision=approval_revision+case when changed then 1 else 0 end,updated_at=clock_timestamp(),updated_by=m.name where id=p_id returning * into c;
 end if;
 return jsonb_build_object('car',public.ap_car_json(c));
end $$;
