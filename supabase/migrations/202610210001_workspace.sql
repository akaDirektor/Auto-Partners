-- Run once in the SQL Editor of the separate Auto-Partners project.
-- No passwords, user emails or application records belong in this file.
begin;
create table public.ap_members (
 id uuid primary key references auth.users(id),
 email text not null,
 name text not null check(length(btrim(name)) between 1 and 80),
 role text not null unique check(role in ('owner','partner')),
 revoked_before timestamptz not null default '-infinity',
 created_at timestamptz not null default now()
);
create table public.ap_cars (
 id uuid primary key default gen_random_uuid(),
 version integer not null default 1 check(version>0),
 payload jsonb not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by text not null,
 created_by uuid not null references public.ap_members(id)
);
create table public.ap_messages (
 id uuid primary key default gen_random_uuid(),
 car_id uuid references public.ap_cars(id),
 body text not null check(length(btrim(body)) between 1 and 5000),
 author_id uuid not null references public.ap_members(id),
 author_name text not null,
 created_at timestamptz not null default now()
);
create index ap_messages_car_date on public.ap_messages(car_id,created_at);
alter table public.ap_members enable row level security;
alter table public.ap_cars enable row level security;
alter table public.ap_messages enable row level security;

-- Password reset invalidates every session started before revoked_before,
-- including refreshed access tokens from an older session.
create function public.ap_identity() returns public.ap_members
language sql stable security definer set search_path='' as $$
 select m from public.ap_members m
 join auth.sessions s on s.user_id=m.id
 where m.id=auth.uid() and s.id::text=auth.jwt()->>'session_id'
 and s.created_at>m.revoked_before
$$;
create function public.ap_require_member() returns public.ap_members
language plpgsql stable security definer set search_path='' as $$
declare m public.ap_members;
begin
 if auth.uid() is null then raise sqlstate 'PT401' using message='Потрібен вхід.';end if;
 select * into m from public.ap_members where id=auth.uid();
 if not found then raise sqlstate 'PT403' using message='Немає доступу до простору.';end if;
 m:=public.ap_identity();
 if m.id is null then raise sqlstate 'PT401' using message='Сесія завершена. Увійди знову.';end if;
 return m;
end $$;
create policy ap_members_read on public.ap_members for select to authenticated
 using (id=(public.ap_identity()).id or (public.ap_identity()).role='owner');
create policy ap_cars_read on public.ap_cars for select to authenticated
 using ((public.ap_identity()).id is not null);
create policy ap_messages_read on public.ap_messages for select to authenticated
 using ((public.ap_identity()).id is not null);
revoke all on public.ap_members,public.ap_cars,public.ap_messages from public,anon,authenticated;
grant select on public.ap_members,public.ap_cars,public.ap_messages to authenticated;
grant all on public.ap_members,public.ap_cars,public.ap_messages to service_role;

create function public.ap_car_json(c public.ap_cars) returns jsonb
language sql immutable set search_path='' as $$
 select c.payload||jsonb_build_object('id',c.id,'version',c.version,'createdAt',c.created_at,'updatedAt',c.updated_at,'updatedBy',c.updated_by,'createdBy',c.created_by)
$$;
create function public.ap_message_json(m public.ap_messages) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('id',m.id,'carId',m.car_id,'body',m.body,'authorId',m.author_id,'authorName',m.author_name,'createdAt',m.created_at)
$$;
create function public.ap_session() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();
begin return jsonb_build_object('user',jsonb_build_object('id',m.id,'email',m.email,'name',m.name,'role',m.role));end $$;
create function public.ap_workspace() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();
begin return public.ap_session()||jsonb_build_object(
 'cars',coalesce((select jsonb_agg(public.ap_car_json(c) order by c.created_at desc,c.id) from public.ap_cars c),'[]'::jsonb),
 'messages',coalesce((select jsonb_agg(public.ap_message_json(msg) order by msg.created_at,msg.id) from (select * from public.ap_messages order by created_at desc,id desc limit 1000) msg),'[]'::jsonb));end $$;

create function public.ap_validate_car(c jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare k text;n numeric;v text;d date;outcar jsonb:='{}'::jsonb;
begin
 if jsonb_typeof(c) is distinct from 'object' then raise exception 'Перевір поля автомобіля.';end if;
 foreach k in array array['make','model','engine','gearbox','color','boughtAt','sellBy','status','notes','url'] loop
  if jsonb_typeof(c->k) is distinct from 'string' then raise exception 'Перевір текстові поля.';end if;
  v:=c->>k;
  if k in ('make','model') then v:=btrim(v);end if;
  if (k='make' and length(v) not between 1 and 80) or (k='model' and length(v) not between 1 and 120)
   or (k in ('engine','gearbox') and length(v)>40) or (k='color' and length(v)>50)
   or (k='notes' and length(v)>5000) or (k='url' and (length(v)>2000 or (v<>'' and v!~* '^https?://'))) then raise exception 'Перевір поля автомобіля.';end if;
  if k in ('boughtAt','sellBy') and v<>'' then
   if v!~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Перевір дату.';end if;
   d:=v::date;
   if to_char(d,'YYYY-MM-DD')<>v then raise exception 'Перевір дату.';end if;
  end if;
  outcar:=outcar||jsonb_build_object(k,v);
 end loop;
 if c->>'status' not in ('planned','bought','preparing','selling','sold') then raise exception 'Перевір етап.';end if;
 foreach k in array array['purchase','expenses','minimum','target','actual'] loop
  if k='actual' and c->k='null'::jsonb then outcar:=outcar||jsonb_build_object(k,null);continue;end if;
  if jsonb_typeof(c->k) is distinct from 'number' then raise exception 'Перевір суми.';end if;
  n:=(c->>k)::numeric;if n<0 or n>10000000 then raise exception 'Перевір суми.';end if;
  outcar:=outcar||jsonb_build_object(k,round(n,2));
 end loop;
 if (outcar->>'target')::numeric<(outcar->>'minimum')::numeric then raise exception 'Цільова ціна має бути не нижчою за мінімальну.';end if;
 if c->>'status'='sold' and c->'actual'='null'::jsonb then raise exception 'Вкажи фактичну ціну продажу.';end if;
 if c->'year'='null'::jsonb then outcar:=outcar||jsonb_build_object('year',null);
 else
  if jsonb_typeof(c->'year') is distinct from 'number' then raise exception 'Перевір рік.';end if;
  n:=(c->>'year')::numeric;if n<>trunc(n) or n<1900 or n>2027 then raise exception 'Перевір рік.';end if;
  outcar:=outcar||jsonb_build_object('year',n);
 end if;
 return outcar;
exception when others then raise sqlstate 'PT400' using message=case when sqlstate='P0001' then sqlerrm else 'Перевір поля автомобіля.' end;
end $$;
create function public.ap_save_car(p_car jsonb,p_id uuid default null,p_version integer default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();c public.ap_cars;clean jsonb:=public.ap_validate_car(p_car);
begin
 if p_id is null then
  insert into public.ap_cars(payload,updated_by,created_by) values(clean,m.name,m.id) returning * into c;
 else
  if p_version is null then raise sqlstate 'PT400' using message='Некоректна версія.';end if;
  update public.ap_cars set payload=clean,version=version+1,updated_at=clock_timestamp(),updated_by=m.name
   where id=p_id and version=p_version returning * into c;
  if not found then raise sqlstate 'PT409' using message='Партнер уже оновив автомобіль. Закрий форму й відкрий її знову.';end if;
 end if;
 return jsonb_build_object('car',public.ap_car_json(c));
end $$;
create function public.ap_send_message(p_body text,p_car_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();msg public.ap_messages;
begin
 if p_body is null or length(btrim(p_body)) not between 1 and 5000 then raise sqlstate 'PT400' using message='Повідомлення має містити 1–5000 символів.';end if;
 if p_car_id is not null and not exists(select 1 from public.ap_cars where id=p_car_id) then raise sqlstate 'PT404' using message='Автомобіль не знайдено.';end if;
 insert into public.ap_messages(car_id,body,author_id,author_name) values(p_car_id,btrim(p_body),m.id,m.name) returning * into msg;
 return jsonb_build_object('message',public.ap_message_json(msg));
end $$;
create function public.ap_users() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();
begin
 if m.role<>'owner' then raise sqlstate 'PT403' using message='Керувати доступом може власник.';end if;
 return jsonb_build_object('users',(select jsonb_agg(jsonb_build_object('id',id,'email',email,'name',name,'role',role) order by created_at) from public.ap_members));
end $$;
create function public.ap_backup() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.ap_members:=public.ap_require_member();
begin
 if m.role<>'owner' then raise sqlstate 'PT403' using message='Експорт доступний власнику.';end if;
 return jsonb_build_object('version',1,'createdAt',now(),
 'cars',coalesce((select jsonb_agg(public.ap_car_json(c) order by c.created_at,c.id) from public.ap_cars c),'[]'::jsonb),
 'messages',coalesce((select jsonb_agg(public.ap_message_json(msg) order by msg.created_at,msg.id) from public.ap_messages msg),'[]'::jsonb));
end $$;
-- Only the server-side admin client can invalidate application sessions.
create function public.ap_revoke_user(p_id uuid) returns void
language sql security definer set search_path='' as $$
 update public.ap_members set revoked_before=clock_timestamp() where id=p_id
$$;

-- PostgreSQL defaults grant functions to PUBLIC: explicitly close that default.
revoke all on function public.ap_identity(),public.ap_require_member(),public.ap_car_json(public.ap_cars),public.ap_message_json(public.ap_messages),public.ap_validate_car(jsonb),public.ap_session(),public.ap_workspace(),public.ap_save_car(jsonb,uuid,integer),public.ap_send_message(text,uuid),public.ap_users(),public.ap_backup(),public.ap_revoke_user(uuid) from public,anon,authenticated;
grant execute on function public.ap_identity(),public.ap_session(),public.ap_workspace(),public.ap_save_car(jsonb,uuid,integer),public.ap_send_message(text,uuid),public.ap_users(),public.ap_backup() to authenticated;
grant execute on function public.ap_revoke_user(uuid) to service_role;
commit;
