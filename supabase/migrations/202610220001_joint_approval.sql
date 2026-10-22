begin;
alter table public.ap_cars add column if not exists approval_revision integer not null default 1;
create table if not exists public.ap_car_approvals(
 car_id uuid not null references public.ap_cars(id),revision integer not null,
 signer_id uuid not null references public.ap_members(id),signer_name text not null,
 proposal jsonb not null,signer_role text not null check(signer_role in ('owner','partner')),created_at timestamptz not null default now(),
 primary key(car_id,revision,signer_id)
);
alter table public.ap_car_approvals enable row level security;
drop policy if exists ap_approvals_read on public.ap_car_approvals;
create policy ap_approvals_read on public.ap_car_approvals for select to authenticated using((public.ap_identity()).id is not null and exists(select 1 from public.ap_cars c where c.id=car_id and c.payload->>'deleted' is distinct from 'true'));
revoke all on public.ap_car_approvals from public,anon,authenticated;
grant select on public.ap_car_approvals to authenticated;
grant all on public.ap_car_approvals to service_role;
create or replace function public.ap_approval(c public.ap_cars) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('revision',c.approval_revision,'approved',count(distinct a.signer_role)=2,'signatures',coalesce(jsonb_agg(jsonb_build_object('userId',a.signer_id,'name',a.signer_name,'role',a.signer_role,'createdAt',a.created_at) order by a.created_at) filter(where a.signer_id is not null),'[]'::jsonb)) from public.ap_car_approvals a where a.car_id=c.id and a.revision=c.approval_revision
$$;
create or replace function public.ap_car_json(c public.ap_cars) returns jsonb language sql stable security definer set search_path='' as $$
 select c.payload||jsonb_build_object('id',c.id,'version',c.version,'createdAt',c.created_at,'updatedAt',c.updated_at,'updatedBy',c.updated_by,'createdBy',c.created_by,'approval',public.ap_approval(c))
$$;
create or replace function public.ap_proposal(p jsonb) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_object_agg(key,value) from jsonb_each(p) where key=any(array['make','model','year','engine','gearbox','color','purchase','expenses','minimum','target','boughtAt','sellBy'])
$$;
create or replace function public.ap_save_car(p_car jsonb,p_id uuid default null,p_version integer default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();c public.ap_cars;clean jsonb:=public.ap_validate_car(p_car);changed boolean;
begin
 if p_id is null then
  clean:=clean||jsonb_build_object('status','planned','actual',null);
  insert into public.ap_cars(payload,updated_by,created_by) values(clean,m.name,m.id) returning * into c;
 else
  select * into c from public.ap_cars where id=p_id and payload->>'deleted' is distinct from 'true' for update;
  if not found or p_version is null or c.version<>p_version then raise sqlstate 'PT409' using message='Партнер уже оновив автомобіль. Закрий форму й відкрий її знову.';end if;
  changed:=public.ap_proposal(clean) is distinct from public.ap_proposal(c.payload);
  if changed then clean:=clean||jsonb_build_object('status','planned');
  elsif clean->>'status'<>'planned' and not (public.ap_approval(c)->>'approved')::boolean then raise sqlstate 'PT403' using message='Спочатку потрібні дві згоди: власника та партнера.';end if;
  update public.ap_cars set payload=clean,version=version+1,approval_revision=approval_revision+case when changed then 1 else 0 end,updated_at=clock_timestamp(),updated_by=m.name where id=p_id returning * into c;
 end if;
 return jsonb_build_object('car',public.ap_car_json(c));
end $$;
create or replace function public.ap_approve_car(p_id uuid,p_version integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();c public.ap_cars;
begin
 select * into c from public.ap_cars where id=p_id and payload->>'deleted' is distinct from 'true' for update;
 if not found then raise sqlstate 'PT404' using message='Автомобіль не знайдено.';end if;
 if p_version is null or c.version<>p_version then raise sqlstate 'PT409' using message='Умови автомобіля змінилися. Онови картку перед підтвердженням.';end if;
 insert into public.ap_car_approvals(car_id,revision,signer_id,signer_name,signer_role,proposal) values(c.id,c.approval_revision,m.id,m.name,m.role,public.ap_proposal(c.payload)) on conflict do nothing;
 return jsonb_build_object('car',public.ap_car_json(c));
end $$;
revoke all on function public.ap_approval(public.ap_cars),public.ap_proposal(jsonb),public.ap_approve_car(uuid,integer) from public,anon,authenticated;
grant execute on function public.ap_approve_car(uuid,integer) to authenticated;
create or replace function public.ap_backup() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();funding jsonb:='[]'::jsonb;
begin
 if m.role<>'owner' then raise sqlstate 'PT403' using message='Експорт доступний власнику.';end if;
 if to_regprocedure('public.ap_funding_list()') is not null then execute 'select public.ap_funding_list()->''entries''' into funding;end if;
 return jsonb_build_object('version',1,'createdAt',now(),'funding',funding,
 'cars',coalesce((select jsonb_agg(public.ap_car_json(c) order by c.created_at,c.id) from public.ap_cars c),'[]'::jsonb),
 'messages',coalesce((select jsonb_agg(public.ap_message_json(msg) order by msg.created_at,msg.id) from public.ap_messages msg),'[]'::jsonb),
 'approvalHistory',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.ap_car_approvals a),'[]'::jsonb));
end $$;
commit;
