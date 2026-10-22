-- Owner-only removal from the active fleet; records remain in owner backups.
begin;
create or replace function public.ap_workspace() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();
begin return public.ap_session()||jsonb_build_object(
 'cars',coalesce((select jsonb_agg(public.ap_car_json(c) order by c.created_at desc,c.id) from public.ap_cars c where c.payload->>'deleted' is distinct from 'true'),'[]'::jsonb),
 'messages',coalesce((select jsonb_agg(public.ap_message_json(msg) order by msg.created_at,msg.id) from (select * from public.ap_messages where car_id is null or exists(select 1 from public.ap_cars c where c.id=car_id and c.payload->>'deleted' is distinct from 'true') order by created_at desc,id desc limit 1000) msg),'[]'::jsonb));end $$;

create or replace function public.ap_save_car(p_car jsonb,p_id uuid default null,p_version integer default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();c public.ap_cars;clean jsonb:=public.ap_validate_car(p_car);
begin
 if p_id is null then
  insert into public.ap_cars(payload,updated_by,created_by) values(clean,m.name,m.id) returning * into c;
 else
  if p_version is null then raise sqlstate 'PT400' using message='Некоректна версія.';end if;
  update public.ap_cars set payload=clean,version=version+1,updated_at=clock_timestamp(),updated_by=m.name
   where id=p_id and version=p_version and payload->>'deleted' is distinct from 'true' returning * into c;
  if not found then raise sqlstate 'PT409' using message='Партнер уже оновив автомобіль. Закрий форму й відкрий її знову.';end if;
 end if;
 return jsonb_build_object('car',public.ap_car_json(c));
end $$;
create or replace function public.ap_send_message(p_body text,p_car_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();msg public.ap_messages;
begin
 if p_body is null or length(btrim(p_body)) not between 1 and 5000 then raise sqlstate 'PT400' using message='Повідомлення має містити 1–5000 символів.';end if;
 if p_car_id is not null and not exists(select 1 from public.ap_cars where id=p_car_id and payload->>'deleted' is distinct from 'true') then raise sqlstate 'PT404' using message='Автомобіль не знайдено.';end if;
 insert into public.ap_messages(car_id,body,author_id,author_name) values(p_car_id,btrim(p_body),m.id,m.name) returning * into msg;
 return jsonb_build_object('message',public.ap_message_json(msg));
end $$;
create or replace function public.ap_delete_car(p_id uuid,p_version integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();
begin
 if m.role<>'owner' then raise sqlstate 'PT403' using message='Видаляти автомобілі може лише власник.';end if;
 if p_id is null or p_version is null then raise sqlstate 'PT400' using message='Некоректний автомобіль або версія.';end if;
 update public.ap_cars set payload=payload||jsonb_build_object('deleted',true),version=version+1,updated_at=clock_timestamp(),updated_by=m.name where id=p_id and version=p_version and payload->>'deleted' is distinct from 'true';
 if not found then raise sqlstate 'PT409' using message='Автомобіль уже змінено або видалено. Онови таблицю.';end if;
 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.ap_delete_car(uuid,integer) from public,anon,authenticated;
grant execute on function public.ap_delete_car(uuid,integer) to authenticated;
drop policy if exists ap_cars_read on public.ap_cars;
create policy ap_cars_read on public.ap_cars for select to authenticated using((public.ap_identity()).id is not null and payload->>'deleted' is distinct from 'true');
drop policy if exists ap_messages_read on public.ap_messages;
create policy ap_messages_read on public.ap_messages for select to authenticated using((public.ap_identity()).id is not null and (car_id is null or exists(select 1 from public.ap_cars c where c.id=car_id and c.payload->>'deleted' is distinct from 'true')));
commit;
