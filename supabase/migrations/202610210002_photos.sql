-- Optional private photos; existing cars are preserved.
begin;
create or replace function public.ap_validate_car(c jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare k text;n numeric;v text;d date;photo jsonb;outcar jsonb:='{}'::jsonb;
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
 if c ? 'photos' then
  if jsonb_typeof(c->'photos') is distinct from 'array' then raise exception 'Некоректні фото.';end if;
  if jsonb_array_length(c->'photos')>6 then raise exception 'Максимум 6 фотографій.';end if;
  for photo in select value from jsonb_array_elements(c->'photos') loop
   if jsonb_typeof(photo) is distinct from 'string' or length(photo#>>'{}')>160000 or (photo#>>'{}')!~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$' then raise exception 'Некоректний формат фото.';end if;
  end loop;
  outcar:=outcar||jsonb_build_object('photos',c->'photos');
 else outcar:=outcar||jsonb_build_object('photos','[]'::jsonb);
 end if;
 return outcar;
exception when others then raise sqlstate 'PT400' using message=case when sqlstate='P0001' then sqlerrm else 'Перевір поля автомобіля.' end;
end $$;
create or replace function public.ap_photo_ready() returns boolean language plpgsql stable security definer set search_path='' as $$
begin perform public.ap_require_member();return true;end $$;
revoke all on function public.ap_photo_ready() from public,anon,authenticated;
grant execute on function public.ap_photo_ready() to authenticated;
commit;
