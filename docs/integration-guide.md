# Bank integration guide (BNK-13)

Earlio offers a banks three ways to connect, all documented in the OpenAPI spec (`/openapi.json`, tags `integration` and `machine`).

| Route | Use it for | Auth |
|---|---|---|
| **Console** (web, BNK-13) | Create keys, register webhooks, upload or download CSV files by hand | Logged-in bank administrator / credit officer / operations user |
| **Machine API** (`/api/v1/machine/*`) | Core-banking or ERP systems submitting offers, pushing statements, pulling instructions | API key + signed request |
| **File drop** (CSV) | Banks that cannot call an API yet | Console upload, or the machine API's `files/*` endpoints |

## 1. API keys
Create a key in the console (bank administrators only). The **API key** (`ek_<8 hex>_<48 hex>`) and the **signing secret** are shown **once**; only a hash of the key is stored.

**Rotation.** *Rotate* issues a new key and puts the old one into `rotating`: it keeps working for **24 hours**, then stops. A key can be rotated only once, and *Revoke* stops a key immediately. Every create, rotate and revoke is written to the audit trail. Keys that are unused should be revoked.

## 2. Authenticating a call
```
Authorization: Bearer ek_1a2b3c4d_<secret>
```
Every call that **changes** something must also be signed:

```
x-earlio-timestamp: <unix ms>
x-earlio-nonce:     <unique string per request>
x-earlio-signature: hex( HMAC_SHA256( signingSecret, "<timestamp>.<nonce>.<raw request body>" ) )
```
The timestamp must be within 5 minutes of Earlio's clock, and a nonce is accepted **once** (a replay returns `409 replay`). A wrong signature, stale timestamp or missing header returns `401`. Read calls (`GET`) need only the key.

```js
const ts = Date.now(), nonce = crypto.randomUUID(), body = JSON.stringify({ invoiceId });
const sig = crypto.createHmac('sha256', signingSecret).update(`${ts}.${nonce}.${body}`).digest('hex');
```

## 3. Endpoints
| Method and path | Purpose |
|---|---|
| `GET /api/v1/machine/invitations` | Invoices currently open for offers from your bank |
| `POST /api/v1/machine/offers` | Submit an offer `{invoiceId, ratePct?, advancePct?, fxSpreadPct?, validityHours?}`. Omitted values come from your published terms; guardrails still apply. Send `Idempotency-Key` so a retry returns the same offer. |
| `POST /api/v1/machine/statements` | Push statement lines `{lines:[{bankTxnId, reference, currency, amount, valueDate, payer}]}`; the same `bankTxnId` is never booked twice |
| `GET /api/v1/machine/instructions` | Disbursement instructions waiting for your bank (`?format=csv` for the file form) |
| `POST /api/v1/machine/files/offers?filename=` and `/files/statements?filename=` | CSV bodies (`Content-Type: text/csv`), signed |

Errors use one shape: `{ "code": "...", "message": "...", "details": null }`.

## 4. File drop (CSV)
All files are UTF-8, comma-separated, first row = header. At most 1,000 rows. **Each row stands alone**: a bad row is reported (`row` = line number in the file) and the remaining rows still go in. Every upload is listed in the console with its row counts.

| Direction | Columns |
|---|---|
| Offers in | `invoice` (number such as `EXP-1042`, or id), `ratePct`, `advancePct`, `fxSpreadPct`, `validityHours` (blank = use your terms) |
| Statements in | `bankTxnId`, `reference`, `currency` (USD/SGD), `amount`, `valueDate` (YYYY-MM-DD), `payer` |
| Instructions out | `reference`, `invoice`, `beneficiary`, `currency`, `amountForeign`, `fxRate`, `amountInr`, `valueDate`, `status` |

Cells that begin with `= + - @` are prefixed with `'` on export so spreadsheet software never runs them as formulas.

**SFTP.** The MVP's file drop is HTTPS upload. An SFTP gateway that moves files into the same endpoints is a deployment task (see *pilot-readiness*, gap G-3).

## 5. Webhooks (outbound)
Register an HTTPS URL (in development `http://localhost` is allowed; private network addresses are refused in production) and, optionally, the event types you want (empty = all events that concern your bank), e.g. `offer.submitted`, `financing.approved`, `disbursement.credited`.

Each delivery is a `POST` of `{ "id", "type", "data" }` with the same three signature headers, signed with your newest active key's **signing secret**. Respond `2xx` to acknowledge. A non-2xx or timeout is retried on later worker passes, up to 5 attempts, then marked `failed`; recent deliveries and errors are visible in the console. Deliveries are at-least-once: de-duplicate on `id`.

## 6. Incoming payment callbacks
Payment callbacks from the partner bank's payments rail use `POST /api/v1/webhooks/bank/{bankId}` with a per-bank secret derived from the platform key; same header scheme and replay protection.
