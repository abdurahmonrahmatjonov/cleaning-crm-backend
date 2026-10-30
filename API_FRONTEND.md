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

Every error is `{ "error": "message", "details": ... }`. `details` appears only on `400`, in one of two shapes. Validation errors from request schemas carry `details` as an **array** of `{ path, message }`. Errors thrown by a handler carry `details` as a plain **object**; in this feature: `{ "path": "paidDate" }`, `{ "path": "prices" }`, `{ "lineId": 12 }` (sizes sent for a line that is not kv.m) and `{ "path": "paid" }` or `{ "path": "discount" }` (money sent when handing a saygak order over). Many handler 400s have no `details` at all.

| Code | Meaning |
|---|---|
| 400 | Validation failed. `details` is `[{ "path": "lines.0.price", "message": "..." }]`, so you can show the message next to the field |
| 401 | Missing, wrong or expired token, or wrong username/password |
| 403 | Your role is not allowed to do this. A saygak (partner) token gets `403` on every route except `/api/partner/*`, `/api/auth/*` (login, me) and the public `GET /api/branding` (`/health` is also open) |
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

`PATCH /orders/:docNum/wash` and `PATCH /orders/:docNum/pack` now need a body with every line: `{ lines: [{ id, quantity, sizes? }] }` (`quantity` is a whole number, at least 1; `sizes` is described below). `wash` stores `washedQuantity`; `pack` sets `quantity`. The activity log keeps the picked / washed / packed counts per service.

## Carpet sizes (gilam o'lchamlari)

Staff can record the width and length of each carpet at the wash and pack steps, so the final `sqm` at delivery can be pre-filled.

```json
PATCH /orders/:docNum/pack
{ "lines": [{ "id": 12, "quantity": 2, "sizes": [{ "width": 2.5, "length": 4 }, { "width": 3, "length": 3 }] }] }
```

- `sizes` is optional per line. **Absent = keep what is stored. `[]` = clear. A list = replace the whole list** (so pack can correct what wash saved).
- Only lines whose `unit` is `kv.m` accept sizes. For `metr` or `dona` lines the server answers `400`.
- `width` and `length` are in metres, greater than 0 and at most 100, rounded to 2 decimals (a value that rounds to 0 gives `400`). At most 100 rows per line.
- The server computes each row's `area = round2(width x length)`.
- Every order line in responses now has `sizes: [{ width, length, area }]` (empty list when none) and `sizesTotal` (sum of the row areas, `0` when none). Use `sizesTotal` to pre-fill `sqm` in the deliver form; `sqm` itself is still what the client is charged for and may differ.
- Order lines also have `expectedQuantity` (what a saygak said they would bring; `0` = not given; always `0` for regular orders).

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
| PATCH | `/clients/:id` | `{ name?, phone?, isPartner? }` (`isPartner` is a boolean, see "Saygak clients"). The new name/phone is copied onto the client's orders |
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
{ "token": "eyJ...", "user": { "id": 1, "username": "admin", "fullName": "Administrator", "role": "admin", "roleName": "Admin", "permissions": ["orders.view", "..."], "clientId": null } }
```
`clientId` is `null` for staff. A **saygak** login has `role: "saygak"`, `permissions: []` and `clientId` set to their client id. When `clientId` is not `null`, show the saygak portal (only `/api/partner/*`, `/api/auth/*` and the public `GET /api/branding` work for that token; every other route gives `403`).

### GET /auth/me
Returns the current user: `{ id, username, fullName, role, roleName, permissions, clientId }` (`clientId` is `null` for staff). Use it to restore the session on page load.

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
| | PATCH | `/orders/:docNum/wash` | Washed (`orders.wash`), status becomes `Yuvib bo'lingan`. Body `{ lines: [{ id, quantity, sizes? }] }` |
| Yuvib bo'lingan | GET | `/orders/washed` | List of `Yuvib bo'lingan` |
| | PATCH | `/orders/:docNum/pack` | Packed (`orders.pack`), status becomes `Upakovka qilingan`. Body `{ lines: [{ id, quantity, sizes? }] }` |
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
- You can send `clientId` of an existing client instead of `clientName` + `clientPhone`.
- **Saygak (partner) clients:** if the client (found by `clientId` or by phone) has `isPartner`, the order is created as `kind: "partner"`. Then omit `location`, `landmark` and `pickupTime` (they are not needed; if you do send them they are still validated, so `pickupTime: ""` or `location: null` gives `400`), and each line's `price` is ignored: the server uses the client's saved prices (`/clients/:id/prices`). A service without a saved price gives `400` (`details` is the object `{ "path": "lines.N.serviceId" }`, not an array). Lines may carry `expectedQuantity` (1 to 100000). At most 10 open (`Zakaz Qabul qilindi`) orders per saygak, the 11th gives `409`.
- For regular clients `location`, `pickupTime` and every line's `price` are required (`400` otherwise).

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

For `kind: "partner"` orders `waybillNumber` and `deliveryTime` are optional (they are stored as `""` when omitted). Omit the keys; do not send empty strings (`waybillNumber: ""` and `deliveryTime: ""` give `400`). For regular orders they are required.

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
- **Partner orders** take no money at handover: `paid` and `discount` must be `0`/absent, otherwise `400`. The saygak pays later with a lump payment (see "Saygak clients"). The UI label for this step is "Topshirildi", the status string is still `Yetkazib berildi`.

### PATCH /orders/:docNum
Send only the fields you want to change. At least one is required. On a partner order only `pickupTime` can be sent; `clientName`, `clientPhone`, `landmark` or `location` give `409`. A regular order cannot be re-pointed to a saygak's phone (`409`).
```json
{ "clientName": "...", "clientPhone": "+998...", "location": { "latitude": 0, "longitude": 0 }, "landmark": "...", "pickupTime": "2026-11-01 11:00" }
```

### POST /orders/:docNum/cancel
```json
{ "reason": "Mijoz rad etdi" }
```
Works on `Zakaz Qabul qilindi`, `Olib Ketildi`, `Yuvib bo'lingan` and `Upakovka qilingan`. Other statuses return `409`.

### POST /orders/:docNum/payments
```json
{ "amount": 50000, "paidDate": "2026-11-05" }
```
`paidDate` is optional and defaults to today. The order must be `Yetkazib berildi`, and `amount` cannot be more than its current debt (otherwise `400`). Returns `201` with the updated order. For `kind: "partner"` orders this always returns `409` ("Saygak orders are paid from the client page"); use the client lump payment instead.

### Order object
```json
{
  "docNum": 7,
  "kind": "regular",
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
      "lineTotal": 97500, "currency": "UZS", "unit": "kv.m", "expectedQuantity": 0,
      "pickedQuantity": 2, "washedQuantity": 2,
      "sizes": [{ "width": 2.5, "length": 4, "area": 10 }], "sizesTotal": 10
    }
  ]
}
```
`kind` is `regular` or `partner` (a saygak order: no address, `location` is `0/0`, `landmark` is `""`). The object also has `discount`, `washedAt`, `packedAt`, `washedBy`, `packedBy` (omitted from the example for brevity). Line `status` is `Open` or `Closed`. `docStatus` is `Open` until the order is delivered or cancelled.

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
| GET | `/clients?search=&page=&limit=` | `{ id, name, phone, isPartner, createdAt, ordersCount, debt }` per client. `isPartner` is `0` or `1` |
| GET | `/clients/:id` | The same fields plus `orders: [{ docNum, kind, status, docTotal, paid, createdAt, deliveredDate }]` (`kind` is `regular` or `partner`) |

Clients are also created automatically when an order is created (see `POST /clients` above for creating one by hand).

## Saygak clients (partner accounts)

A **saygak** is a partner client with special prices, its own login, no delivery address, and month-end lump payments instead of per-order payments. Staff flag a client with `PATCH /clients/:id { "isPartner": true }` (`clients.manage`). `isPartner` comes back as `0` or `1` from the client endpoints.

Un-flagging (`isPartner: false`) is refused with `409` while the saygak has an active login ("Deactivate the saygak login first") or an unpaid delivered partner order ("Settle the saygak debt first"). A client with a login or saved prices cannot be deleted (`409`); deactivate the login instead.

### Prices and login (admin only, except GET prices)

| Method | Path | Notes |
|---|---|---|
| GET | `/clients/:id/prices` | Any staff with `clients.view`. `{ data: [{ serviceId, serviceName, unit, price }] }` for every active service; `price` is `null` when not set |
| PUT | `/clients/:id/prices` | Admin. `{ prices: [{ serviceId, price }] }` (price 0 to 1e9, no duplicate service, at most 500). **Replaces** the whole list: services not sent lose their price. Inactive/unknown service gives `400`. `409` if the client is not a saygak. Returns the same shape as GET |
| GET | `/clients/:id/login` | Admin. `{ username, isActive }` or `null` when the client has no login |
| PUT | `/clients/:id/login` | Admin. `{ username, fullName?, password }` creates the login, or resets username and password of the existing one. `username` is 3 to 50 characters: letters, digits and `_ . -`. `password` is 8 to 100 characters. `409` for a duplicate username or a client that is not a saygak. Returns `{ username, isActive }` |
| PATCH | `/clients/:id/login` | Admin. `{ isActive }`. `404` if there is no login. A deactivated saygak's token stops working at once (`401`). Returns `{ username, isActive }` |

The bodies of `PUT /clients/:id/login`, `PUT /clients/:id/prices`, `PATCH /clients/:id/login` and `POST /clients/:id/payments` are strict: an unknown key gives `400`.

One login per saygak. Saygak users do not appear in `/users`, and the `saygak` role cannot be edited or assigned there.

### Lump payments and statement

Money from a saygak arrives as one payment that is spread over their delivered, unpaid orders oldest first (by `deliveredDate`, then `docNum`).

| Method | Path | Notes |
|---|---|---|
| POST | `/clients/:id/payments` | `orders.payments`. Body `{ amount?, discount?, paidDate? }`; either `amount` or `discount` must be above 0. `discount` needs `orders.discount` (`403` otherwise). `paidDate` defaults to today and **cannot be in the future** (`400`). `amount + discount` cannot exceed the saygak's total debt (`400`, nothing is written). `409` if the client is not a saygak |
| GET | `/clients/:id/payments` | `{ data: [batch] }`, newest first, including reversed ones |
| DELETE | `/clients/:id/payments/:batchId` | **Admin only.** Reverses a whole batch: the orders get their `paid`/`discount` back. Returns `{ reversed: true }`. `404` unknown batch, `409` if it is already reversed |
| GET | `/clients/:id/statement?month=YYYY-MM` | Monthly statement (month defaults to the current one) |

`POST` returns `201`:
```json
{ "batchId": "6f1c...", "allocations": [{ "docNum": 41, "cash": 100000, "disc": 0 }, { "docNum": 42, "cash": 150000, "disc": 0 }], "debtLeft": 350000 }
```
A batch in the list is `{ batchId, clientId, amount, discount, paidDate, createdAt, creatorId, creatorName, allocations, reversedAt, reversedByName }`; `reversedAt` is `""` while active.

Statement (same shape for staff and for the saygak's own `/api/partner/statement`):
```json
{
  "month": "2026-10",
  "opening": 0, "charges": 600000, "credits": 250000, "closing": 350000,
  "orders": [{ "docNum": 41, "deliveredDate": "2026-10-03", "docTotal": 100000, "sqmTotal": 4 }],
  "payments": [{ "batchId": "6f1c...", "paidDate": "2026-10-20", "amount": 250000, "discount": 0 }],
  "inProgress": [{ "docNum": 50, "status": "Olib Ketildi", "createdAt": "2026-10-28" }]
}
```
`charges` are partner orders delivered in the month (by `deliveredDate`). `credits` are non-reversed batches paid in the month (by `paidDate`, cash plus discount). `closing = opening + charges - credits`, and for the current month it equals the saygak's current debt. `inProgress` lists open orders without amounts. `sqmTotal` counts only `kv.m` lines.

### Reports

`GET /reports/debtors` and `GET /reports/summary` already include saygak money: a delivered partner order counts in `sales.total` (by `deliveredDate`) and its unpaid part in `debt` / `outstandingDebt`. Lump payments reduce them; `collected` counts the cash of batches by `paidDate`.

## Saygak portal API (`/api/partner/*`)

For a logged-in saygak only (token whose user has `clientId`). Staff tokens get `403` here, and a saygak token gets `403` on every other route except `/api/auth/*` (login, me) and the public `GET /api/branding`. The saygak is always identified by the token: any `clientId` in the body or query is ignored. An order of another client or a regular order gives `404` on every `:docNum` route. A deactivated login gets `401`.

| Method | Path | Notes |
|---|---|---|
| GET | `/partner/me` | `{ client: { id, name, phone }, inProgressOrders, receivedOrders, orderCap, debt }`. `inProgressOrders` counts orders before delivery; `receivedOrders` those still `Zakaz Qabul qilindi`; `orderCap` is 10 |
| GET | `/partner/services` | A **plain array** (not wrapped in `data`): `[{ id, name, unit, price }]`, only active services that have a price for this saygak |
| GET | `/partner/orders?page=&limit=&status=` | `{ data: [order], meta }`, newest first. `status` is one of the status strings |
| POST | `/partner/orders` | `{ lines: [{ serviceId, expectedQuantity? }] }`, 1 to 20 lines, each service once. Returns `201` with the order. `400` for a service without a price; `409` when the 10 open orders cap is reached |
| GET | `/partner/orders/:docNum` | One order |
| PATCH | `/partner/orders/:docNum` | `{ lines: [{ id, expectedQuantity }] }` (`0` clears it). Only while `Zakaz Qabul qilindi` (`409` otherwise); a line id from another order gives `400` |
| POST | `/partner/orders/:docNum/cancel` | `{ reason }`. Only while `Zakaz Qabul qilindi` (`409` otherwise) |
| GET | `/partner/statement?month=YYYY-MM` | Same statement as for staff |

The order the saygak sees is built field by field. No address, workers, waybill, cancel reason or prices before handover:
```json
{
  "docNum": 41, "status": "Yetkazib berildi",
  "createdAt": "2026-10-28", "deliveredDate": "2026-10-30", "cancelledAt": "",
  "lines": [{
    "id": 12, "serviceName": "Gilam yuvish", "unit": "kv.m",
    "expectedQuantity": 3, "quantity": 3,
    "sizes": [{ "width": 2.5, "length": 4, "area": 10 }], "sizesTotal": 10,
    "price": 5000, "sqm": 10, "lineTotal": 50000
  }],
  "docTotal": 50000, "discount": 0, "paid": 0, "debt": 50000
}
```
- `quantity` is `null` until the order is packed (`Upakovka qilingan`); from then on it is the packed count. `sizes` appear as staff saved them.
- **Only after handover** (`Yetkazib berildi`): line `price`, `sqm`, `lineTotal` and order `docTotal`, `discount`, `paid`, `debt`. Before that these keys are absent.
- `debt` is never negative.

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
| POST | `/users` | `{ "username", "fullName", "password", "role" }`. Username is 3 to 50 characters (letters, digits, `_ . -`), password at least 8 characters, role is `admin`, `operator` or `driver`. Returns `201`. Saygak users are hidden here and the `saygak` role cannot be used (they are managed under `/clients/:id/login`) |
| PATCH | `/users/:id` | Any of `fullName`, `password`, `role`, `isActive`. An admin cannot disable or demote their own account (`409`) |

## Typical flows

**Login screen:** `POST /auth/login`, store `token`, store `user`, then load `/services` for later dropdowns.

**Creating an order:** `POST /orders`, then refresh `/orders/received`.

**Driver at pickup:** open `GET /orders/:docNum`, read `lines[].id`, then `PATCH .../pickup` with a `quantity` for each line.

**Driver at delivery:** `PATCH .../deliver` with `sqm` for each line and the `paid` amount. The response already contains `docTotal` and `debt`, so show them straight away.

**Saygak month end:** `GET /clients/:id/statement`, then `POST /clients/:id/payments` with the amount received; a mistaken payment is undone by an admin with `DELETE /clients/:id/payments/:batchId`.

**Debt later:** `GET /reports/debtors`, then `POST /orders/:docNum/payments`.
