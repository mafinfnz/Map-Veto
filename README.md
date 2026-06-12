# Map Veto — CS2

Сайт для пика/бана карт CS2 двумя игроками. Дизайн в стиле Apple, авторизация
по паролю и через Google, без npm-зависимостей — нужен только Node.js 18+.
Капитаны и зрители тоже должны войти или зарегистрироваться перед открытием ссылки матча.

## Запуск

```bash
cd cs2-veto
node server.js
# → http://localhost:3000
```

## Как пользоваться

1. **Организатор** входит → «Новый матч» (BO1/BO3/BO5) → получает ссылки для двух капитанов и наблюдателей.
2. **Капитан или зритель** открывает ссылку. Если он ещё не вошёл, сайт сначала покажет экран входа/регистрации, затем вернёт на нужную ссылку.
3. Капитаны по очереди банят и пикают. Всё синхронизируется автоматически, итог — список карт + decider.

| Формат | Последовательность (A — создатель, B — оппонент) |
|--------|---------------------------------------------------|
| BO1 | 6 банов по очереди → последняя карта играется |
| BO3 | ban A, ban B, pick A, pick B, ban A, ban B → decider |
| BO5 | ban A, ban B, pick A, pick B, pick A, pick B → decider |

Маппул (Active Duty 2026): Ancient, Anubis, Dust II, Inferno, Mirage, Nuke, Overpass — меняется в `server.js` → `MAP_POOL`.

---

## Авторизация через Google — настройка за 5 минут

Код уже написан и на сервере, и на фронтенде. Нужно только получить Client ID. Client Secret для текущей схемы входа не нужен и его нельзя добавлять во фронтенд:

1. Откройте [Google Cloud Console](https://console.cloud.google.com/) → создайте проект (любое имя).
2. Меню → **APIs & Services → OAuth consent screen** → тип **External** → заполните имя приложения и email → сохраните. Добавлять scope и проходить верификацию не нужно.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - **Authorized JavaScript origins**: `http://localhost:3000` (и ваш боевой домен, например `https://veto.example.com`)
4. Скопируйте **Client ID** (вида `1234-abc.apps.googleusercontent.com`).
5. Передайте его серверу любым из двух способов:

```bash
# способ 1 — переменная окружения
GOOGLE_CLIENT_ID="ваш-id.apps.googleusercontent.com" node server.js
```

```jsonc
// способ 2 — файл cs2-veto/config.json
{ "googleClientId": "ваш-id.apps.googleusercontent.com" }
```

Перезапустите сервер — кнопка «Войти через Google» появится на странице входа сама.

**Как это работает внутри:** фронтенд подключает Google Identity Services,
Google возвращает подписанный ID-token, сервер проверяет его через
`https://oauth2.googleapis.com/tokeninfo` (подпись, срок действия и что токен
выдан именно вашему приложению), затем находит/создаёт пользователя и ставит
обычную HttpOnly-сессию. Никаких секретов на клиенте нет.

> ⚠️ Google OAuth работает только на `localhost` или на **HTTPS**-домене —
> с голого IP-адреса (`http://1.2.3.4`) кнопка работать не будет.
>
> Если Google показывает `no registered origin` / `invalid_client`, добавьте текущий адрес сайта
> в **Authorized JavaScript origins**. Нужен только origin без пути и без слеша в конце,
> например `http://localhost:3000` или `https://ваше-имя.onrender.com`.

---

## Как «сделать через GitHub» (репозиторий + деплой)

GitHub Pages здесь **не подойдёт** — Pages раздаёт только статику, а у нас есть
бэкенд (Node.js). Правильная схема: код хранится на GitHub, а хостинг
автоматически деплоит его из репозитория.

### 1. Залить код на GitHub

```bash
cd cs2-veto
git init
git add .
git commit -m "CS2 Map Veto"
# создайте пустой репозиторий на github.com, затем:
git remote add origin https://github.com/ВАШ_ЛОГИН/cs2-veto.git
git push -u origin main
```

Добавьте `.gitignore`, чтобы не коммитить данные и секреты:

```
data.json
config.json
```

### 2. Подключить бесплатный хостинг к репозиторию

Любой из вариантов, везде логика одна — «Deploy from GitHub repo»:

| Хостинг | Шаги |
|---------|------|
| **Render** (есть free-план) | New → Web Service → выбрать репозиторий → Start command: `node server.js` |
| **Railway** | New Project → Deploy from GitHub repo → всё определится само |
| **Fly.io / VPS** | `fly launch` или `git pull && node server.js` на сервере |

На хостинге задайте переменную окружения `GOOGLE_CLIENT_ID` (в разделе
Environment), а в Google Console добавьте выданный домен
(`https://ваше-имя.onrender.com`) в *Authorized JavaScript origins*.

После этого каждый `git push` в `main` автоматически обновляет сайт — это и
есть рабочий процесс «через GitHub».

> Нюанс free-планов: файл `data.json` может стираться при пересоздании
> контейнера. Для дружеских veto это не критично; для постоянного хранения
> подключите диск (Render Disk / Railway Volume) или замените файл на SQLite/Postgres.

---

## Технические детали

- **Бэкенд:** чистый Node.js `http`, без npm-пакетов.
- **Пароли:** scrypt + соль; **сессии:** HttpOnly-cookie.
- **Google OAuth:** ID-token проверяется на серверах Google, на клиенте нет секретов.
- **Синхронизация:** polling раз в 2 с; DOM перерисовывается только при изменениях, чтобы анимации не дёргались.
- **Все правила veto проверяются на сервере** — походить вне очереди или за соперника невозможно.
- **Дизайн:** системный стек SF Pro, кнопки-«пилюли», сегмент-контрол как в iOS, glass-навбар с blur, плавные пружинные анимации (`cubic-bezier(.32,.72,0,1)`), поддержка `prefers-reduced-motion`.
