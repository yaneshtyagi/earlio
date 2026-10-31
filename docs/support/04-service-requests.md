# 4. Service requests

Routine, non-incident requests. Always **verify the requester's identity and authority** before acting: confirm the request comes from the user's registered e-mail address *and* is approved by an administrator of the same organisation (or by the account owner on file). Record the verification in the ticket.

Several requests below have **no screen in the MVP** (gap G9 in the [technical manual](../technical-manual/06-deployment.md#69-production-gaps-to-close)). Those are done by L3 with a reviewed change that also writes an audit event; L1/L2 prepare the ticket.

## Contents
| # | Request | Done by |
| --- | --- | --- |
| S1 | [Unlock an account](#s1-unlock-an-account) | Wait 15 min (self-healing) or L3 |
| S2 | [Password reset](#s2-password-reset) | L3 (no self-service yet) |
| S3 | [Lost MFA device](#s3-lost-mfa-device) | User (recovery code) or L3 |
| S4 | [Add a user or change a role](#s4-add-a-user-or-change-a-role) | The organisation's own Admin |
| S5 | [Remove a user (leaver)](#s5-remove-a-user-leaver) | L3 on the org Admin's request |
| S6 | [Bank API key: create, rotate, revoke](#s6-bank-api-key-create-rotate-revoke) | The bank's Admin |
| S7 | [Tenant name or custom domain](#s7-tenant-name-or-custom-domain) | Bank Admin / PlatformAdmin |
| S8 | [Register or remove a bank webhook](#s8-register-or-remove-a-bank-webhook) | The bank's Admin |
| S9 | [Change a governed platform setting](#s9-change-a-governed-platform-setting) | Two PlatformAdmins |
| S10 | [Audit extract for a customer or auditor](#s10-audit-extract-for-a-customer-or-auditor) | L2 / Auditor |
| S11 | [Suspend a supplier–buyer relationship](#s11-suspend-a-supplierbuyer-relationship) | PlatformAdmin on business instruction |

---

## S1. Unlock an account

After 5 wrong passwords, an account is locked for **15 minutes** and then unlocks itself. Tell the user to wait 15 minutes and try again, carefully.

If the user is locked out repeatedly, or reports they did not make the attempts, check [Q11](06-diagnostic-queries.md#q11-a-users-sign-in-history) for `auth.login_failed` events. Many failures the user did not make → possible password-guessing → escalate to L3 as a security concern.

Immediate unlock (only if business-critical; **L3**): set `failed_attempts = 0, locked_until = null` for that user, with the ticket number recorded.

## S2. Password reset

There is no self-service reset or e-mailed reset link yet.

1. Verify identity and authority (top of page).
2. **L3** sets a temporary password through a reviewed script that hashes it with the application's password function (`kernel/password.ts`), never by writing a hash by hand, and writes an audit event.
3. Send the temporary password to the user through a channel separate from the ticket (e.g. phone), and ask them to change it at first sign-in once that feature exists.
4. MFA is unaffected.

## S3. Lost MFA device

1. **Recovery codes first.** Users received recovery codes when they enrolled MFA. On the code step they can enter a recovery code instead of the 6-digit code; each code works once. See [Getting started § 2.2](../user-manual/00-getting-started.md#gs-recovery-codes).
2. No codes left: verify identity **strictly** (this bypasses the second factor) — e.g. a call-back to the phone number on file plus approval by the organisation's Admin.
3. **L3** resets MFA for the user (clears the stored secret and recovery codes, sets MFA as not enrolled) with an audit event. At next sign-in the user enrols a new authenticator and receives new recovery codes.
4. For **platform administrators**, a second PlatformAdmin must approve the reset.

## S4. Add a user or change a role

Organisations manage their own users: an **Admin** of the organisation opens **Users** and adds the member with a role. Roles per organisation type:

| Organisation | Roles |
| --- | --- |
| Supplier, buyer | Admin, FinanceUser, Approver, Viewer |
| Bank | Admin, FinanceUser, Approver, Viewer, CreditOfficer, Operations, RelationshipManager |
| Insurer | Admin, Approver, Viewer, Underwriter, ClaimsHandler |
| Platform | PlatformAdmin, Auditor |

What each role can do: [permissions matrix](../permissions-matrix.md). The Users page cannot yet e-mail an invitation; the Admin tells the new user how to sign in. If the organisation has no remaining Admin, escalate to L2 to verify authority and to L3 to add one.

## S5. Remove a user (leaver)

The **Users** page cannot remove members or deactivate users yet, so leavers are handled by L3:

1. The organisation's Admin requests the removal in writing; L2 verifies their authority.
2. **L3**, through a reviewed change with an audit event: deletes the user's membership of that organisation, deletes their rows in `identity.sessions` (ending any open session at once), and — if the user belongs to no other organisation — sets `locked_until` far in the future so they cannot sign in.
3. Confirm with [Q11](06-diagnostic-queries.md#q11-a-users-sign-in-history) that no sign-in happens afterwards.
4. If the leaver was a bank Admin who created API keys, ask the bank to rotate them ([S6](#s6-bank-api-key-create-rotate-revoke)).

## S6. Bank API key: create, rotate, revoke

Done by the **bank's Admin** in **API and files → API keys**:

- **Create**: name the key (e.g. `core-banking`); the key and its signing secret are shown **once** — the bank must store them in its vault immediately. Support can never retrieve them.
- **Rotate**: issues a new key; the old one keeps working for **24 hours**, then stops. A key can be rotated once.
- **Revoke**: stops a key immediately. Use for a suspected leak, then create a new key.

If a bank reports a leaked key: ask its Admin to **revoke** it now (or, if they cannot, L3 revokes on their verified instruction), then treat as a security incident. [Q9](06-diagnostic-queries.md#q9-bank-api-keys) shows keys' status and last use.

## S7. Tenant name or custom domain

- **Tenant name** (`<tenant>.<domain>`): the bank's Admin changes it on the **Bank console**; platform staff can set or clear it on **Tenant domains**. Names are 2–32 lower-case letters, digits or hyphens; reserved names (`www`, `app`, `admin`, `api`, `earlio`, …) and names already taken are refused.
- **Custom domain** (e.g. `trade.bank.com`): platform-only, on **Tenant domains**. Before setting it, the bank creates the DNS record (CNAME to the platform) and **L3** adds the domain to the TLS certificate and proxy. Set it in Earlio last, then check the portal.
- Changing a tenant name changes the portal URL immediately; tell the bank's users. Each change is audited (`branding.tenant_set`).

## S8. Register or remove a bank webhook

Done by the bank's Admin in **API and files → Webhooks**: the URL must be **HTTPS** and publicly reachable (private and local addresses are refused in production). Leave *Events* empty for all events, or list topics such as `offer.submitted, financing.approved`. Deliveries are signed with the bank's newest active API-key signing secret, so the bank needs an active key. **Recent deliveries** shows status and errors ([R7](03-runbooks.md#r7-bank-webhook-deliveries-failing)).

## S9. Change a governed platform setting

Platform defaults (fees, platform mode, dispute wording, …) are governed: one PlatformAdmin **proposes** the change on **Defaults and guardrails**, and a **different** PlatformAdmin approves it on **Approvals** (maker-checker). Support never changes these directly. Wording that has legal effect (governing law, dispute text) needs counsel's approval first. See [Platform manual](../user-manual/05-platform.md).

## S10. Audit extract for a customer or auditor

1. Confirm the requester is entitled (their own organisation's records, or an authorised auditor with a written request).
2. Use [Q10](06-diagnostic-queries.md#q10-audit-trail-for-an-entity) for an entity, or filter `audit.events` by `org_id` and a date range. Export as CSV.
3. Run **Verify chain** and include the result and time in the extract.
4. Remove other organisations' data and internal-only fields before sending; send through an approved secure channel.

## S11. Suspend a supplier–buyer relationship

On a written instruction from compliance or the product owner (for example a sanctions concern), a PlatformAdmin suspends the relationship. New invoices between the pair are then refused ("This relationship is suspended."). Record the instruction in the ticket; the action is audited (`relationship.suspended`).
