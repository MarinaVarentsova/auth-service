# Community Hub: серверная проверка сессии

GET `/api/auth/session` принимает только `Authorization: Bearer <accessToken>`. Cookie, query-параметры и дополнительные identity-заголовки не задают пользователя. Endpoint не выполняет регистрацию, refresh, logout, отправку email или запись в БД. Существующие auth-маршруты и CORS не изменены.

Успех HTTP 200:

```json
{"authenticated":true,"user":{"id":"00000000-0000-4000-8000-000000000101","projectId":"00000000-0000-4000-8000-000000000001","emailVerified":true}}
```

UUID в примере синтетические. Email, роли, пароль, hash и токены не возвращаются. Ответ содержит `Cache-Control: no-store` и `Pragma: no-cache`, включая ошибки.

Проверки: единственный Authorization header не более 4096 UTF-8 байт, Bearer JWT, существующая `verifyToken()` проверяет подпись и expiry; дополнительно обязательны UUID sub/projectId и конечный числовой exp в будущем. Подписанные sub/projectId используются в параметризованном SELECT с JOIN auth_users/auth_projects. Требуются совпадение проекта, email_verified=true, status='active', is_active=true. Только SELECT в BEGIN READ ONLY. Отдельный pool max=5, connectionTimeout=3s, query_timeout=4s; statement_timeout=3s, lock_timeout=2s. Старый pool не изменён. Ошибки не логируются handler'ом; существующий HTTP logger не сериализует заголовки/тело/query.

Ошибки имеют только `{"error":"Unauthorized"}` (401), `{"error":"Forbidden"}` (403), `{"error":"Service unavailable"}` (503). Нет токена/невалидный/истёкший/слишком большой токен → 401; отсутствующая или недопустимая связка пользователя/проекта → 403; ошибка БД или отсутствующий AUTH_SECRET/известный development fallback → 503. Заголовки сверх общего лимита Node/proxy могут быть отклонены до Express (например, 431). Лимит 4096 относится только к новому endpoint.

## Подключение Community Hub (отдельный этап)

Community backend отправляет access token на этот endpoint по заранее настроенному HTTPS URL, с таймаутом и без redirect, не логируя токен. Только успешный минимальный JSON может стать основой identity. Community должен проверять ожидаемый projectId и связывать `(auth-service, projectId, user.id)` с уже существующим profile UUID через управляемую таблицу связей. Email не является ключом и не нужен в ответе. Несвязанному пользователю доступ закрыт. Роли пространства читаются из Community БД, не из auth-заголовков. AUTH_SECRET остаётся только в auth-service; не копировать в Community Hub. Реализация Community в этом commit не меняется.

AUTH_SECRET должен быть явно установлен до старта процесса. Endpoint использует существующие DATABASE_URL и JWT_EXPIRES; новых production env не требуется. Production значения не читались и не менялись. CORS остаётся прежним; серверному запросу CORS не нужен. CSRF для этого endpoint не требуется, поскольку cookie не принимается как credential.

После logout уже выданный access token может работать до exp: по умолчанию до 15 минут с момента выпуска. Endpoint проверяет актуальные статусы в БД, но не связывает access JWT с refresh-сессией. Срок токена не увеличен. Текущее JWT не содержит token_type/issuer/audience; историческая helper createRefreshToken также способна выпускать JWT того же формата. Реальный refresh login-маршрута — случайная hex-строка, которая здесь отклоняется. Семантику существующих токенов в этом этапе не меняем.

## Локальная проверка без production-секретов

С установленными workspace dependencies и PostgreSQL 17 на Windows:

```powershell
./scripts/test-auth-session.ps1
$env:PORT='5174'; $env:BASE_PATH='/'; $env:NODE_ENV='production'
pnpm run build
```

Скрипт создаёт собственный временный кластер с trust только на loopback и случайном порту, синтетическую БД session_test и тестовую схему по существующим колонкам. Не применяет миграции или drizzle push к внешним базам. В finally останавливает кластер и восстанавливает переменные. Секрет тестового JWT генерируется случайно для дочернего процесса. HTTP запросы идут только на loopback, email/registration не вызываются. Проверяются session/claims/статусы/ошибки/логи, login, ротация refresh, logout и verify-email. Изменение auth_users на время проверки ошибки БД происходит только внутри одноразовой локальной БД. Bundle тестов находится в игнорируемом dist-tests, production entry его не импортирует.

Lockfile содержит исключения Windows native packages для Replit/Linux. Для локального Windows build нужны соответствующие версии esbuild, Rollup, Lightning CSS и Tailwind Oxide. Установка локальных binaries не требует изменения lockfile и не должна попадать в Git. Базовые auth handlers также проверяются на неизменность относительно исходного main.

Проверка 2026-10-16: 14/14 Node tests (включая HTTP/PostgreSQL и регрессию legacy auth) прошли без skip. Workspace typecheck и production build успешны; OpenAPI YAML разобран, test markers в production backend bundle отсутствуют. Тест lock_timeout вернул 503 примерно через 2 секунды и подтвердил восстановление подключения. Временные PostgreSQL-кластеры остановлены. Единственное предупреждение build — sourcemap существующего tooltip.tsx.
