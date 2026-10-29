# NewCRM backend

Node.js (Express) + SQLite. No database server to install: the DB is a single file, `data/crm.db`, created on first start.

## Run

```bash
npm install
cp .env.example .env     # then edit JWT_SECRET and ADMIN_PASSWORD
npm run dev              # http://localhost:3000
npm test
```

On the first start an admin user is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD`, plus default services and expense types.

## Using the API from the frontend

- Every `/api/*` route except `POST /api/auth/login` needs `Authorization: Bearer <token>`.
- Dates: `YYYY-MM-DD`. Date-times: send `YYYY-MM-DD HH:MM` (or with `T`); responses are always `YYYY-MM-DD HH:MM:SS`. Times use `APP_TIMEZONE` (default `Asia/Tashkent`).
- Fields not yet filled are `""` (strings) or `0` (numbers), as in the TZ.
- Errors: `{ "error": "message", "details": [...] }` with 400 (validation), 401, 403, 404, 409 (wrong status for this action).
- Lists: `?page=1&limit=20` -> `{ data: [...], meta: { page, limit, total } }`.

### Auth and users

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/login` | `{ username, password }` -> `{ token, user }` |
| GET | `/api/auth/me` | current user |
| GET/POST/PATCH | `/api/users`, `/api/users/:id` | admin only. Roles: `admin`, `operator`, `driver` |

### Dropdown data

| Method | Path | Notes |
|---|---|---|
| GET | `/api/services` | Xizmat turlari (Gilam yuvish, Adyol ...) for the order lines |
| GET | `/api/expense-types` | Xarajat turlari (Oylik, Obed ...) |
| POST/PATCH | same paths (`/:id`) | admin only: `{ name }` / `{ name?, isActive? }` |

### 1. Sotuvlar

All orders sit in one `orders` table; the three menus are status filters.

| Menu | Method | Path | Status after |
|---|---|---|---|
| 1.1 Olingan zakazlar | GET | `/api/orders/received` | list of `Zakaz Qabul qilindi` (`?search=` name / phone / docNum) |
| | POST | `/api/orders` | creates it as `Zakaz Qabul qilindi` |
| | PATCH | `/api/orders/:docNum/pickup` | -> `Olib Ketildi` |
| 1.2 Olib ketildi | GET | `/api/orders/picked-up` | list of `Olib Ketildi` |
| | PATCH | `/api/orders/:docNum/deliver` | -> `Yetkazib berildi` |
| 1.3 Tugallangan | GET | `/api/orders/completed` | list of `Yetkazib berildi`, read only |
| (any) | GET | `/api/orders/:docNum` | one order with its lines |
| Extra | PATCH | `/api/orders/:docNum` | fix client / location / landmark / pickupTime. Only while `Zakaz Qabul qilindi`. admin, operator |
| Extra | POST | `/api/orders/:docNum/cancel` | `{ reason }` -> `Bekor qilindi`. Allowed before delivery. admin, operator |
| Extra | GET | `/api/orders/cancelled` | list of cancelled orders |
| Extra | POST | `/api/orders/:docNum/payments` | `{ amount, paidDate? }`: client pays off debt of a delivered order. admin, operator |
| Extra | GET | `/api/orders/:docNum/payments` | payment history of the order |

**POST /api/orders**

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

`price` is per 1 kv.m. The backend sets: `status`, `docStatus: "Open"`, `createdBy` (the logged-in user), `docNum` (auto increment), `docTotal: 0`, `paid: 0`, `docRate: 0`, `createdAt` (today), `orderTakenAt` (now), empty `deliveryTime` / `pickedUpAt` / `deliveredDate` / `waybillNumber`. Each line gets `status: "Open"`, `customerPrice` = `price`, `quantity: 0`, `sqm: 0`, `currency: "UZS"`.

**PATCH /api/orders/:docNum/pickup** (driver). Must list every line of the order.

```json
{
  "waybillNumber": "N-123",
  "deliveryTime": "2026-11-03 18:00",
  "lines": [{ "id": 12, "quantity": 2 }]
}
```

Sets status `Olib Ketildi` and `pickedUpAt` = now.

**PATCH /api/orders/:docNum/deliver**. Must list every line of the order.

```json
{
  "deliveredDate": "2026-11-03",
  "paid": 100000,
  "lines": [{ "id": 12, "sqm": 6.5 }]
}
```

Sets status `Yetkazib berildi`, `deliveredAt` = now, `docTotal` = sum of (`sqm` x `price`) over the lines, and `paid`. `debt` in responses is `max(docTotal - paid, 0)`. `deliveredDate` defaults to today if omitted.

### 2. Xarajatlar

| Method | Path | Notes |
|---|---|---|
| POST | `/api/expenses` | `{ expenseTypeId, amount, expenseDate }`. Backend sets `createdAt` (today) and `creator` |
| GET | `/api/expenses` | filters `?from=&to=&expenseTypeId=`. `meta.totalAmount` is the sum of the filtered rows |

### 3. Mijozlar (clients) and reports

A client is created automatically from the phone number of an order (phones are stored without spaces, e.g. `+998901234567`), so repeat customers share one record.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/clients?search=` | clients with `ordersCount` and `debt` |
| GET | `/api/clients/:id` | one client with all their orders |
| GET | `/api/reports/debtors` | clients who owe money, biggest first. admin, operator |
| GET | `/api/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` | admin only: orders by status, sales (delivered in range, total and kv.m), money collected, expenses by type, `netCash` (collected - expenses), all-time `outstandingDebt` |

Orders also record who picked up (`pickedUpBy`) and who delivered (`deliveredBy`). Money received at delivery is saved as the first payment of the order.

## Who can do what

Set in the two constants at the top of [src/app.js](src/app.js).

- Orders: `admin`, `operator`, `driver` can read and run pickup / deliver. Only `admin` and `operator` can create orders.
- Expenses: `admin`, `operator`.
- Clients: same roles as orders. Reports: see the table above.
- Users, and changing services / expense types: `admin`.

## Layout

```
index.js            entry point
src/app.js          express app, route wiring, role rules
src/db.js           SQLite schema, order status names, seed data
src/routes/         auth, users, catalog (services / expense types), orders, expenses
src/middleware/     JWT auth, zod validation, error handler
test/api.test.js    end-to-end tests (in-memory DB)
```
