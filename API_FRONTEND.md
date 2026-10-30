# NewCRM API: frontend guide

Base URL: `https://bis-newcrm-api.fly.dev/api`
Health check (no auth, outside `/api`): `https://bis-newcrm-api.fly.dev/health`

The server sleeps when idle, so the first request after a pause can take a few seconds. Show a loading state and do not treat it as an error.

## Basics

- Send and receive JSON. Set `Content-Type: application/json` on requests with a body.
- Every route except `POST /auth/login` needs the header `Authorization: Bearer <token>`.
- The token expires after 12 hours. On a `401`, clear it and send the user to the login page.
- Dates are `YYYY-MM-DD`. Date-times are sent as `YYYY-MM-DD HH:MM` (a `T` also works). Responses always use `YYYY-MM-DD HH:MM:SS`, in the Asia/Tashkent time zone.
- Fields not filled in yet come back as `""` (strings) or `0` (numbers), never `null`.
- Phone numbers are stored without spaces, for example `+998901234567`. One phone number is one client.
- Lists take `?page=1&limit=20` (limit max 200) and return `{ "data": [...], "meta": { "page", "limit", "total" } }`.

### Errors

Every error is `{ "error": "message", "details": [...] }`. `details` appears only on `400`.

| Code | Meaning |
|---|---|
| 400 | Validation failed. `details` is `[{ "path": "lines.0.price", "message": "..." }]`, so you can show the message next to the field |
| 401 | Missing, wrong or expired token, or wrong username/password |
| 403 | Your role is not allowed to do this |
| 404 | Not found |
| 409 | Wrong status for this action, or a duplicate (for example the order was already picked up) |
| 429 | Too many login attempts (10 per 15 minutes). Ask the user to wait |

### Small fetch helper

```js
const API = 'https://bis-newcrm-api.fly.dev/api';

export async function api(path, { method = 'GET', body } = {}) {
  const token = localStorage.getItem('token');
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login') {
    localStorage.removeItem('token');
    window.location.href = '/login';
  }
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, details: data.details });
  return data;
}
```

## Counting at each workshop step

Pieces are counted three times and each count is kept: `pickedQuantity` (driver, at pickup), `washedQuantity` (after washing) and `quantity` (at packing). **`quantity` is what the client is charged for**: it starts as the pickup count and is replaced by the packed count.

`PATCH /orders/:docNum/wash` and `PATCH /orders/:docNum/pack` now need a body with every line: `{ lines: [{ id, quantity }] }` (whole numbers, at least 1). `wash` stores `washedQuantity`; `pack` sets `quantity`. The activity log keeps the picked / washed / packed counts per service.

`POST /clients` also accepts an optional `address: { latitude, longitude, landmark }`.

## Units (kv.m / metr / dona)

Each service has a `unit`: `kv.m` (default), `metr` or `dona`. `POST /services` and `PATCH /services/:id` accept `unit`; `defaultPrice` is the price per that unit. A new order line copies the service's unit (`line.unit`), so changing a service later never changes old orders.

At delivery, `lines[].sqm` is the measured amount in the line's unit (kv.m or metr). For `dona` lines send only `{ id }`: the total is the counted pieces (`quantity`, entered at pickup) times the price. The `sales.totalSqm` in the summary counts only `kv.m` lines.

## Discounts (chegirma)

New permission `orders.discount` (admin always, operator by default; others only if an admin grants it). A discount reduces what the client owes: `debt = docTotal - discount - paid`. The order object has `discount`; every debt figure (clients, debtors, summary) already uses it, and `summary.sales.discount` totals discounts of the delivered orders in the range.

- `PATCH /orders/:docNum/deliver` accepts `discount` (not more than the order total).
- `POST /orders/:docNum/payments` accepts `{ amount, discount, paidDate }`: either may be 0 but not both. `amount` plus `discount` cannot exceed the debt. A payment row carries the `discount` given with it.

## Clients: CRUD and saved addresses

New permission `clients.manage` (admin; operator by default, also added to an existing operator role once). `clients.view` is still enough to read.

| Method | Path | Notes |
|---|---|---|
| POST | `/clients` | `{ name, phone }`. `409` if the phone already exists |
| PATCH | `/clients/:id` | `{ name?, phone? }`. The new name/phone is copied onto the client's orders |
| DELETE | `/clients/:id` | Only when the client has no orders (`409` otherwise) |
| GET | `/clients/:id` | Now also returns `addresses`, most recently used first: `{ id, latitude, longitude, landmark, lastUsedAt }` |
| GET / POST | `/clients/:id/addresses` | List, or add `{ latitude, longitude, landmark }` by hand |
| PATCH / DELETE | `/clients/:id/addresses/:addressId` | Edit or remove one |

Saved addresses fill themselves from orders: every order's location is remembered for its client (a pin within about 30 m of a saved one counts as the same place and just becomes the most recent). Addresses of orders that existed before this feature were backfilled once.

**Creating an order for an existing client:** `POST /orders` with `{ clientId, location, landmark, pickupTime, lines }`; the client's saved name and phone are used. For a new client send `clientName` and `clientPhone` instead; the client is created automatically (and logged). To default the form to the client's last place, use `addresses[0]` from `GET /clients/:id`.

## Comments

Notes on an order, a client or an expense. You need the permission that lets you see that record (`orders.view`, `clients.view`, `expenses.manage`).

| Method | Path | Notes |
|---|---|---|
| GET | `/comments?entity=order\|client\|expense&entityId=` | `{ data: [{ id, userId, userName, body, createdAt }] }`, oldest first |
| POST | `/comments` | `{ entity, entityId, body }`, body 1 to 1000 characters |
| DELETE | `/comments/:id` | The author, or an admin |
| GET | `/comments/counts?entity=&ids=1,2,3` | `{ data: { "<id>": count } }` for list badges |

Adding or deleting a comment is also written to the activity log (`comment.added`, `comment.deleted`), so comments show up in an order's history.

## Activity log (audit trail)

Every change is written to an append-only log in the same transaction as the change: order created / edited (with `changes: { field: { from, to } }`) / picked up / washed / packed / delivered / cancelled / payment, and admin changes to users (never the password), roles, services, expense types, expenses and project settings.

| Method | Path | Notes |
|---|---|---|
| GET | `/orders/:docNum/history` | Timeline of one order, oldest first (`orders.view`) |
| GET | `/activity?page&limit&entity&entityId&userId&from&to&search` | Everything, newest first (admin only) |

An entry is `{ id, at, userId, userName, entity, entityId, action, details }`. `action` examples: `order.washed`, `order.payment`, `user.updated`. Status changes carry `details.from` and `details.to`. Orders created before this log existed have no history.

## Roles and permissions

Roles are data. An admin edits which permissions each role has (`/roles`), and can add roles. Built-in roles: `admin` (always everything), `operator`, `driver`, `packer` (upakovkachi).

Permissions: `orders.view`, `orders.create`, `orders.edit` (edit and cancel), `orders.pickup`, `orders.wash`, `orders.pack`, `orders.deliver`, `orders.payments`, `orders.discount`, `clients.view`, `clients.manage`, `debtors.view`, `expenses.manage`, `reports.view`.

Login and `/auth/me` return `role`, `roleName` and `permissions`. Hide what the user cannot use with `permissions`; the server enforces it anyway and answers `403`. Users, roles, services and branding changes are admin only.

| Endpoint | Who |
|---|---|
| `GET /roles` | admin. `{ data: [{ key, name, isSystem, permissions, usersCount }], meta: { permissions } }` |
| `POST /roles` | admin. `{ name, permissions: [] }`, the `key` is generated from the name |
| `PATCH /roles/:key` | admin. `{ name?, permissions? }`. `admin` cannot be changed |
| `DELETE /roles/:key` | admin. Not for built-in roles or roles that still have users |

## Branding (project name and logo)

| Endpoint | Who |
|---|---|
| `GET /branding` | public. `{ name, logo }`, `logo` is a PNG/JPEG/WebP data URL or `null` |
| `PUT /branding` | admin. `{ name, logo }` (logo under about 200 KB; the web app downsizes it) |

## Auth

### POST /auth/login
```json
{ "username": "admin", "password": "..." }
```
Returns:
```json
{ "token": "eyJ...", "user": { "id": 1, "username": "admin", "fullName": "Administrator", "role": "admin" } }
```

### GET /auth/me
Returns the current user: `{ id, username, fullName, role }`. Use it to restore the session on page load.

## Dropdown data

| Method | Path | Notes |
|---|---|---|
| GET | `/services` | Service types for order lines. Returns `{ "data": [{ "id", "name", "isActive" }] }`. Only active ones |
| GET | `/expense-types` | Expense types, same shape |
| POST | `/services`, `/expense-types` | Admin. Body `{ "name": "..." }` |
| PATCH | `/services/:id`, `/expense-types/:id` | Admin. Body `{ "name"?, "isActive"? }` |

Admins can pass `?all=true` on the GET routes to also see inactive items.

## Sotuvlar (orders)

One order goes through these statuses. The `status` field holds these exact strings.

```
Zakaz Qabul qilindi  ->  Olib Ketildi  ->  Yetkazib berildi
        |                     |
        +----> Bekor qilindi <-+   (cancel is allowed before delivery)
```

| Menu | Method | Path | What it does |
|---|---|---|---|
| 1.1 Olingan zakazlar | GET | `/orders/received` | List of `Zakaz Qabul qilindi` |
| | POST | `/orders` | Create an order (admin, operator) |
| | PATCH | `/orders/:docNum/pickup` | Driver picks up, status becomes `Olib Ketildi` |
| 1.2 Olib ketildi | GET | `/orders/picked-up` | List of `Olib Ketildi` |
| | PATCH | `/orders/:docNum/wash` | Washed (`orders.wash`), status becomes `Yuvib bo'lingan`. No body |
| Yuvib bo'lingan | GET | `/orders/washed` | List of `Yuvib bo'lingan` |
| | PATCH | `/orders/:docNum/pack` | Packed (`orders.pack`), status becomes `Upakovka qilingan`. No body |
| Upakovka qilingan | GET | `/orders/packed` | List of `Upakovka qilingan` |
| | PATCH | `/orders/:docNum/deliver` | Deliver (`orders.deliver`), only from `Upakovka qilingan`, status becomes `Yetkazib berildi` |
| 1.3 Tugallangan | GET | `/orders/completed` | List of `Yetkazib berildi` (read only) |
| Extra | GET | `/orders/cancelled` | List of `Bekor qilindi` |
| Extra | GET | `/orders/:docNum` | One order with its lines, any status |
| Extra | PATCH | `/orders/:docNum` | Fix client/location/landmark/pickupTime. Only while `Zakaz Qabul qilindi` (admin, operator) |
| Extra | POST | `/orders/:docNum/cancel` | Cancel with a reason (admin, operator) |
| Extra | POST | `/orders/:docNum/payments` | Client pays off debt of a delivered order (admin, operator) |
| Extra | GET | `/orders/:docNum/payments` | Payment history of the order |

All four list routes accept `?page=`, `?limit=` and `?search=` (matches client name, phone, or an exact `docNum`).

### POST /orders
```json
{
  "clientName": "Ali Valiyev",
  "clientPhone": "+998901234567",
  "location": { "latitude": 41.311, "longitude": 69.279 },
  "landmark": "Korzinka yonida",
  "pickupTime": "2026-11-01 10:00",
  "lines": [{ "serviceId": 1, "price": 15000 }]
}
```
- `price` is per 1 kv.m. `landmark` is optional.
- `lines` needs 1 to 50 items. `serviceId` comes from `GET /services`.
- Returns `201` with the full order. The backend fills in `docNum`, status, `createdBy`, timestamps and zeroed totals.

### PATCH /orders/:docNum/pickup
The body must list **every** line of the order exactly once. Otherwise you get `400` with `details` containing `expectedLineIds`.
```json
{
  "waybillNumber": "N-123",
  "deliveryTime": "2026-11-03 18:00",
  "lines": [{ "id": 12, "quantity": 2 }]
}
```
`lines[].id` is the **line id** from the order's `lines`, not the `serviceId`. `quantity` is a whole number from 1.

### PATCH /orders/:docNum/deliver
Again, list every line once.
```json
{
  "deliveredDate": "2026-11-03",
  "paid": 100000,
  "lines": [{ "id": 12, "sqm": 6.5 }]
}
```
- `deliveredDate` is optional and defaults to today.
- `paid` is the money taken from the client now. It can be `0`.
- The backend computes `docTotal` as the sum of `sqm x price` over the lines. `debt` is `max(docTotal - paid, 0)`.

### PATCH /orders/:docNum
Send only the fields you want to change. At least one is required.
```json
{ "clientName": "...", "clientPhone": "+998...", "location": { "latitude": 0, "longitude": 0 }, "landmark": "...", "pickupTime": "2026-11-01 11:00" }
```

### POST /orders/:docNum/cancel
```json
{ "reason": "Mijoz rad etdi" }
```
Works on `Zakaz Qabul qilindi` and `Olib Ketildi`. Other statuses return `409`.

### POST /orders/:docNum/payments
```json
{ "amount": 50000, "paidDate": "2026-11-05" }
```
`paidDate` is optional and defaults to today. The order must be `Yetkazib berildi`, and `amount` cannot be more than its current debt (otherwise `400`). Returns `201` with the updated order.

### Order object
```json
{
  "docNum": 7,
  "status": "Yetkazib berildi",
  "docStatus": "Closed",
  "clientId": 3,
  "clientName": "Ali Valiyev",
  "clientPhone": "+998901234567",
  "location": { "latitude": 41.311, "longitude": 69.279 },
  "landmark": "Korzinka yonida",
  "pickupTime": "2026-11-01 10:00:00",
  "createdBy": { "id": 1, "name": "Administrator" },
  "docTotal": 97500,
  "paid": 50000,
  "debt": 47500,
  "docRate": 0,
  "createdAt": "2026-10-30",
  "orderTakenAt": "2026-10-30 09:12:00",
  "deliveryTime": "2026-11-03 18:00:00",
  "pickedUpAt": "2026-11-01 10:20:00",
  "deliveredDate": "2026-11-03",
  "deliveredAt": "2026-11-03 17:40:00",
  "waybillNumber": "N-123",
  "pickedUpBy": "Driver Name",
  "deliveredBy": "Driver Name",
  "cancelReason": "",
  "cancelledAt": "",
  "lines": [
    {
      "id": 12, "serviceId": 1, "serviceName": "Gilam yuvish", "status": "Closed",
      "price": 15000, "customerPrice": 15000, "quantity": 2, "sqm": 6.5,
      "lineTotal": 97500, "currency": "UZS"
    }
  ]
}
```
Line `status` is `Open` or `Closed`. `docStatus` is `Open` until the order is delivered or cancelled.

## Chat

Open to every signed-in user (no permission needed). Two kinds of conversation: the **global room** everyone sees, and **private** one-to-one messages only the two people see. The web app polls every few seconds.

| Method | Path | Notes |
|---|---|---|
| GET | `/chat/users` | Active users to write to: `{ id, fullName, roleName, unread, last }` |
| GET | `/chat/unread` | `{ global, direct: { [userId]: n }, total }` for the menu badge |
| GET / POST | `/chat/global` | Read (`?after=<id>` for new ones only, `?limit=`) or send `{ body }` to the global room |
| GET / POST | `/chat/with/:userId` | Same, for the private conversation with that user |
| PUT | `/chat/read/:peer` | `peer` is `global` or a user id. Body `{ upTo: <message id> }` |

A message is `{ id, senderId, senderName, recipientId (null = global), body, createdAt, file }`. `body` is 1 to 2000 characters (empty for file messages). `file` is `null` or `{ name, mime, size, kind }` with `kind` one of `image`, `audio`, `file`.

### Files, images and voice messages
| Method | Path | Notes |
|---|---|---|
| POST | `/chat/global/file?name=<name>&type=<mime>` | Body is the raw file (`Content-Type: application/octet-stream`), up to 15 MB. Returns the new message |
| POST | `/chat/with/:userId/file?name=&type=` | Same, private |
| GET | `/chat/files/:messageId` | The file, only for people who can see the message. Needs the Bearer header, so fetch it as a blob. Images and audio are inline; everything else is a download |

Voice messages are just audio files (`audio/webm`, `audio/mp4`, ...). Files are stored on the volume next to the database (`UPLOAD_DIR`, default `<db folder>/uploads`) and are not part of the Litestream backup.

### Calls (one to one, WebRTC)
Media flows between the two browsers; the server only relays signaling.

| Method | Path | Notes |
|---|---|---|
| GET | `/chat/events` | Server-sent events stream. Events: `signal` with `{ from: { id, fullName }, callId, type, media, data }` |
| POST | `/chat/call/signal` | `{ to, callId, type: offer\|answer\|ice\|hangup\|reject\|busy, media?: audio\|video, data? }`. An `offer` to someone with no open stream answers `409 User is offline` |
| GET | `/chat/ice` | `{ iceServers }`. STUN by default; set `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` for a TURN relay |

## Xarajatlar (expenses), admin and operator only

### POST /expenses
```json
{ "expenseTypeId": 1, "amount": 500000, "expenseDate": "2026-10-30" }
```
Returns `201`:
```json
{ "id": 1, "expenseTypeId": 1, "expenseType": "Oylik", "amount": 500000, "expenseDate": "2026-10-30", "createdAt": "2026-10-30", "creator": { "id": 1, "name": "Administrator" } }
```

### GET /expenses
Query: `?from=YYYY-MM-DD&to=YYYY-MM-DD&expenseTypeId=&page=&limit=`. Returns `data` and `meta`, where `meta.totalAmount` is the sum of **all** rows matching the filters (not just the current page).

## Mijozlar (clients)

| Method | Path | Notes |
|---|---|---|
| GET | `/clients?search=&page=&limit=` | `{ id, name, phone, createdAt, ordersCount, debt }` per client |
| GET | `/clients/:id` | The same fields plus `orders: [{ docNum, status, docTotal, paid, createdAt, deliveredDate }]` |

Clients are created automatically when an order is created. There is no create-client route.

## Reports

### GET /reports/debtors (admin, operator)
```json
{ "data": [{ "clientId": 3, "name": "Ali Valiyev", "phone": "+998901234567", "ordersCount": 2, "debt": 47500 }], "meta": { "totalDebt": 47500 } }
```
Sorted by biggest debt first.

### GET /reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD (admin only)
Both dates are required, and `from` must not be after `to`.
```json
{
  "from": "2026-10-01", "to": "2026-10-31",
  "ordersByStatus": [{ "status": "Yetkazib berildi", "count": 12 }],
  "sales": { "ordersCount": 12, "total": 1200000, "totalSqm": 80.5 },
  "collected": 1000000,
  "expenses": { "total": 600000, "byType": [{ "expenseType": "Oylik", "total": 500000 }] },
  "netCash": 400000,
  "outstandingDebt": 200000
}
```
`netCash` is collected minus expenses. `outstandingDebt` is all-time and ignores the date range.

## Users (admin only)

| Method | Path | Body |
|---|---|---|
| GET | `/users` | none. Returns `{ "data": [{ id, username, fullName, role, isActive, createdAt }] }` |
| POST | `/users` | `{ "username", "fullName", "password", "role" }`. Username is 3 to 50 characters (letters, digits, `_ . -`), password at least 8 characters, role is `admin`, `operator` or `driver`. Returns `201` |
| PATCH | `/users/:id` | Any of `fullName`, `password`, `role`, `isActive`. An admin cannot disable or demote their own account (`409`) |

## Typical flows

**Login screen:** `POST /auth/login`, store `token`, store `user`, then load `/services` for later dropdowns.

**Creating an order:** `POST /orders`, then refresh `/orders/received`.

**Driver at pickup:** open `GET /orders/:docNum`, read `lines[].id`, then `PATCH .../pickup` with a `quantity` for each line.

**Driver at delivery:** `PATCH .../deliver` with `sqm` for each line and the `paid` amount. The response already contains `docTotal` and `debt`, so show them straight away.

**Debt later:** `GET /reports/debtors`, then `POST /orders/:docNum/payments`.
