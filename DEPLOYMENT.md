# HTTPS: GitHub Pages + Supabase

## Стан

Код підтримує два режими: звичайний локальний Node.js 24 + SQLite та хмарний Supabase Auth + PostgreSQL. Наявні SQLite-дані автоматично до Supabase не переносяться. Не видаляйте локальну базу. Перед перемиканням експортуйте JSON, якщо є реальні записи.

Хмарна версія використовує проєкт `ruurcyasujttenkcpgfh`. У клієнті лише публічна адреса і publishable key; вони не замінюють перевірки доступу. Усі таблиці захищені RLS. Лише акаунти з `ap_members` можуть читати дані та викликати функції запису. Обмеження UNIQUE для ролей дозволяє лише одного власника та одного партнера. Прямий запис у таблиці для браузерних ролей заборонений.

## 1. База

У SQL Editor окремого проєкту Auto-Partners один раз виконайте `supabase/migrations/202610210001_workspace.sql`. Скрипт транзакційний, не містить паролів чи реальних записів. Повторний запуск не потрібен.

У Authentication → Sign In / Providers вимкніть реєстрацію нових користувачів. У Authentication → Users → Add user створіть власника з його email та паролем 12–128 символів. Для створеного адміністратором акаунта ввімкніть Auto Confirm User. Не передавайте пароль у чат чи GitHub.

Прив'яжіть власника через SQL (замініть email; самі паролі у SQL не вставляються):

```sql
do $$
declare owner_id uuid;
begin
 select id into owner_id from auth.users where lower(email)=lower('OWNER_EMAIL_HERE');
 if owner_id is null then raise exception 'Спочатку створіть власника у Authentication → Users';end if;
 insert into public.ap_members(id,email,name,role)
 select id,email,'Слава','owner' from auth.users where id=owner_id;
end $$;
```

Партнера створює власник усередині застосунку. Самостійна реєстрація стороннього акаунта не надає доступу до простору.

## 2. Функція керування акаунтами

Розгорніть `account-admin` у цьому ж Supabase-проєкті. Варіант із CLI (власник виконує автентифікацію сам):

```sh
supabase login
supabase link --project-ref ruurcyasujttenkcpgfh
supabase functions deploy account-admin
```

У `supabase/config.toml` налаштовано `verify_jwt=false`: функція сама перевіряє токен через Auth.getUser та поточну дозволену сесію через `ap_session`, включно з роллю owner. Це необхідно для нових ключів підпису й publishable keys замість старого gateway JWT-контролю. Не прибирайте перевірки з handler.ts.

Можна також використати Dashboard → Edge Functions → Deploy a new function → Via Editor. Назва `account-admin`; додайте index.ts і handler.ts з відповідної папки. У налаштуваннях функції вимкніть лише legacy gateway Verify JWT, оскільки перевірка користувача реалізована всередині функції. Supabase надає `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` у серверному середовищі. Ці серверні ключі не копіюються у браузер або GitHub.

Функція дозволяє власнику створити одного партнера і змінити пароль лише учаснику цього простору. Після зміни пароля всі сесії, розпочаті раніше, втрачають доступ, навіть якщо оновлюють JWT. Зміна власного пароля повертає на форму входу.

## 3. GitHub Pages

У репозиторії Settings → Pages → Source виберіть GitHub Actions. Після завершення налаштування Supabase зміни в main публікуються автоматично. За потреби повторної публікації використайте Actions → Publish HTTPS app → Run workflow для main.

Публікація автоматично запускається після кожного push або об’єднання змін у main; ручний запуск залишається для повторної публікації. Workflow перевіряє типи, SQL/серверні тести та збирає застосунок із `VITE_DATA_BACKEND=supabase` і `VITE_BASE_PATH=/Auto-Partners/`. Секрети до збірки не передаються. Очікувана адреса після успішного deploy: `https://akadirektor.github.io/Auto-Partners/`.

Перед об’єднанням змін, які потребують нових SQL-міграцій, спочатку застосуйте ці міграції в Supabase. Сам frontend відкритий; автомобілі та чати доступні лише після входу дозволених учасників.

## 4. Перевірка перед спільною роботою

У двох браузерах увійдіть як власник і партнер. Створіть авто, перевірте мінімальний/цільовий/фактичний прибуток, відредагуйте другим акаунтом. Стара форма першого акаунта має показати конфлікт. Перевірте загальний чат, обговорення авто, CSV, JSON і збереження після перезавантаження. Автоматичне оновлення — кожні 8 секунд і при поверненні до вкладки.

Локально `npm test` додатково перевіряє SQL у справжньому PostgreSQL runtime PGlite, а Node/SQLite — у тимчасовій базі. Це не замінює перевірку двох реальних Auth-сесій у налаштованому Supabase.

Звичайний локальний запуск залишається `npm ci`, `npm run build`, `npm start`. Для хмарного локального frontend використовуйте `VITE_DATA_BACKEND=supabase npm run dev`.
