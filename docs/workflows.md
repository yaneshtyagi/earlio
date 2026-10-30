# Earlio workflows

BPMN-style process diagrams for the main workflows, drawn from the code (services, the invoice transition table in
`apps/api/src/modules/invoicing/state.ts`, the outbox handlers and background jobs in `apps/api/src/worker.ts`, and the
status constraints in `apps/api/migrations`). Companion to [er-diagrams.md](er-diagrams.md).

## How to read the diagrams

- **Lanes** are the boxes titled with an organisation and role, for example *Supplier · FinanceUser*. A lane named
  *Earlio (system)* is work the platform does itself, in the request or in the background worker.
- **Shapes**: `(( ))` circles are start and end events; rectangles are tasks; diamonds are decisions (gateways);
  stadium shapes `([ ])` are statuses an aggregate reaches.
- **Dashed tasks** (class `sys`) are automatic: a domain check, an outbox event handler or a worker job.
- Every status change writes an audit event and an outbox event (architecture rule 3). The diagrams leave those out.
- Rejections always carry a plain-language reason (rule 8). Where a check can fail, the diagram shows the failure as
  a gateway branch.

| # | Workflow | Main aggregates |
|---|---|---|
| 0 | [Invoice lifecycle](#0-invoice-lifecycle-overview) | invoice |
| 1 | [Onboarding, KYC and sanctions](#1-onboarding-kyc-and-sanctions) | organisation, KYC case, screening |
| 2 | [Supplier–buyer relationship](#2-supplierbuyer-relationship) | relationship |
| 3 | [Invoice submission and acceptance](#3-invoice-submission-and-acceptance) | invoice, acceptance |
| 4 | [Credit insurance cover](#4-credit-insurance-cover) | cover record, insurer buyer limit |
| 5 | [Bank financing](#5-bank-financing-marketplace) | invitation, offer, financing request, lien |
| 6 | [Disbursement](#6-disbursement) | disbursement |
| 7 | [Early payment by the buyer](#7-early-payment-by-the-buyer) | discount schedule, early payment |
| 8 | [Collection and reconciliation](#8-collection-reconciliation-and-exceptions) | expectation, bank transaction, exception |
| 9 | [Disputes](#9-disputes) | dispute, credit note |
| 10 | [Default, claim and recovery](#10-default-insurance-claim-and-recovery) | default, claim, recourse |
| 11 | [Terms and settings](#11-terms-and-platform-settings-maker-checker) | terms version, setting change |

---

## 0. Invoice lifecycle (overview)

The one aggregate every workflow touches. The diagram is exactly the transition table in `state.ts`; anything not
drawn is an illegal transition and throws `DomainError`. Labels say which workflow causes each move.

```mermaid
stateDiagram-v2
    [*] --> Draft: supplier creates (3)
    Draft --> Submitted: supplier submits (3)
    Draft --> Cancelled: supplier cancels (3)
    Submitted --> Accepted: buyer accepts or part-accepts (3)
    Submitted --> Rejected: buyer rejects (3)
    Rejected --> Closed
    Accepted --> OpenForFunding: funding gates 1–4 pass (5)
    Accepted --> NotEligible: a gate fails (5)
    NotEligible --> Accepted: supplier re-checks (5)
    Accepted --> Disputed: dispute in the window (9)
    OpenForFunding --> OffersReceived: first offer sent (5)
    OffersReceived --> OpenForFunding: every offer expired (5)
    OpenForFunding --> Funded: buyer pays early (7)
    OffersReceived --> Funded: disbursement credited (6) or early payment (7)
    Funded --> Settled: buyer pays, distributed (8)
    Funded --> Overdue: unpaid after due date (8)
    Funded --> Disputed: post-funding dispute (9)
    Overdue --> Settled: late payment distributed (8)
    Overdue --> Defaulted: waiting period over or insolvency (10)
    Overdue --> Disputed: post-funding dispute (9)
    Disputed --> Accepted: resolved (9)
    Disputed --> Funded: resolved (9)
    Disputed --> Overdue: resolved (9)
    Disputed --> Settled: paid while disputed (8)
    Defaulted --> Settled: buyer pays after all (8)
    Defaulted --> Closed: claim paid or rejected (10)
    Settled --> Closed: statement reconciled (8)
    Closed --> [*]
    Cancelled --> [*]
```

The swimlane diagram below shows the handoffs from creation to closure.

```mermaid
flowchart TD
    S((Start)) --> REG

    subgraph SUP[Supplier]
        REG[Onboard and KYC] --> REL[Relationship with buyer]
        REL --> INV[Create and submit invoice]
        INV --> REQ[Request funding]
        REQ --> SEL[Select offer and consent]
    end
    subgraph BUY[Buyer]
        ACC[Accept invoice and sign undertaking]
        ACK[Acknowledge assignment notice]
        PAY[Pay on due date]
    end
    subgraph INS[Insurer]
        COV[Decide cover]
        CLM[Decide and pay claim]
    end
    subgraph BNK[Bank]
        OFF[Price and send offer]
        CNF[Confirm financing]
    end
    subgraph SYS[Earlio system]
        DIS[Disburse to supplier]:::sys
        COL[Match payment, distribute, reconcile]:::sys
        DEF[Track default]:::sys
    end

    INV --> ACC --> COV
    ACC --> REQ
    REQ --> OFF --> SEL --> ACK --> CNF --> DIS --> PAY --> COL --> E((Closed))
    PAY -.->|not paid| DEF --> CLM --> E

    classDef sys stroke-dasharray: 5 3
```

---

## 1. Onboarding, KYC and sanctions

Any organisation type registers itself; platform staff never create one. Nothing can transact until KYC is `approved` and
the organisation is not blocked (`transactBlockReason`). The required documents depend on the organisation type:

| Type | KYC documents |
|---|---|
| Supplier | incorporation certificate, GST registration, IEC code, bank account proof |
| Buyer | incorporation certificate, tax registration |
| Bank | banking licence, authorised signatory |
| Insurer | insurance licence, authorised signatory |

```mermaid
flowchart TD
    subgraph ORG[Applicant organisation · Admin or FinanceUser]
        S((Start)) --> R["Register: legal name, country, type,<br/>first administrator"]
        R --> MFA[Sign in and enrol MFA]
        MFA --> U[Upload KYC documents]
        U --> SUB[Submit application]
        REJ_END((Rejected))
        OK_END((Can transact))
        BLK_END((Blocked))
    end

    subgraph SYS[Earlio system]
        R --> C1["Create organisation, Admin user,<br/>draft KYC case"]:::sys
        U --> SCAN[Virus scan and attach]:::sys
        SUB --> KYC[Simulated KYC provider check]:::sys
        SUB --> SCR[Sanctions screening of the legal name]:::sys
        KYC --> G1{Provider result}
        SCR --> G2{Screening}
        G2 -->|hit| REV([sanctions status: review])
        G2 -->|"clear, or only<br/>whitelisted matches"| CLR([sanctions status: clear])
    end

    subgraph PLT[Earlio · PlatformAdmin]
        SQ[Sanctions review]
        SQ --> G3{Decision}
        KQ[KYC queue: review case]
        KQ --> G4{Decision}
        G4 -->|approve| G5{"Sanctions hit<br/>open or confirmed?"}
    end

    G1 -->|fail| REJ_END
    G1 -->|"pass → in_review<br/>refer → referred"| KQ
    REV --> SQ
    G3 -->|false positive: whitelist name| CLR
    G3 -->|confirmed| BLK_END
    G5 -->|no| OK_END
    G5 -->|yes: approval refused| SQ
    G4 -->|reject with reason| REJ_END
    REJ_END -.->|"a new draft case opens<br/>on the next upload"| U

    classDef sys stroke-dasharray: 5 3
```

- KYC case statuses: `draft → in_review | referred | rejected`, then `approved | rejected` by platform staff.
- A confirmed sanctions match sets `blocked = true`. A KYC approval is refused while a match is open or confirmed.
- Screening also runs on the buyer's name each time an invoice is submitted (workflow 3) and before a bank confirms
  financing (workflow 5).

---

## 2. Supplier–buyer relationship

A relationship links exactly one supplier with one buyer. It needs a different approver on each side (maker-checker).
Invoices can only be submitted, and funding gate 2 only passes, while the relationship is `active`.

```mermaid
flowchart TD
    subgraph P[Proposing side · FinanceUser or Admin]
        S((Start)) --> D["Search the directory<br/>(KYC-approved, not blocked)"]
        D --> PR[Propose relationship]
    end

    subgraph SYS[Earlio system]
        PR --> V{"One supplier + one buyer,<br/>both ready to transact,<br/>no existing link?"}:::sys
        V -->|no| X((Refused with reason))
        V -->|yes| PEND([pending])
        AP1 --> BOTH{Both sides approved?}:::sys
        AP2 --> BOTH
        BOTH -->|yes| ACT([active])
        BOTH -->|no| PEND
    end

    subgraph SA[Supplier · Approver]
        AP1["Approve for supplier side<br/>(not the proposer)"]
    end
    subgraph BA[Buyer · Approver]
        AP2["Approve for buyer side<br/>(not the proposer)"]
    end
    subgraph PLT[Earlio · PlatformAdmin]
        SUS[Suspend with reason]
    end

    PEND --> AP1
    PEND --> AP2
    ACT --> E((Invoices can flow))
    ACT -.-> SUS --> SUSP([suspended])

    classDef sys stroke-dasharray: 5 3
```

Each side also picks **preferred banks** (`org:settings`). Those banks are invited when the supplier asks for funding
(workflow 5).

---

## 3. Invoice submission and acceptance

The buyer's silence is never acceptance; the worker only sends reminders. Acceptance requires signing a payment
undertaking, which locks the amount and starts the dispute window (at least 24 hours, a governed setting).

```mermaid
flowchart TD
    subgraph SF[Supplier · FinanceUser]
        S((Start)) --> CR["Create draft invoice<br/>by hand, CSV or ERP import"]
        CR --> PO["Optional: record purchase order"]
        PO --> DOC["Attach commercial invoice<br/>and delivery proof"]
        DOC --> G0{Submit or cancel?}
        G0 -->|cancel| CAN((Cancelled))
        G0 -->|submit| SUB[Submit to buyer]
    end

    subgraph SYS[Earlio system]
        SUB --> CHK{"Both documents attached,<br/>relationship active,<br/>buyer ready?"}:::sys
        CHK -->|no| FIX[Refused with reason]
        FIX --> DOC
        CHK -->|yes| SCR["Screen buyer name,<br/>share documents with buyer"]:::sys
        SCR --> SUBM([Submitted])
        SUBM --> REM["Worker: reminders while<br/>no decision"]:::sys
        WIN["Set accepted amount and<br/>dispute window end"]:::sys
        WIN --> ACCD([Accepted])
        ACCD --> EV["invoice.accepted event:<br/>request cover, open export-proceeds tracker"]:::sys
        RD["Record remainder as a<br/>non-freezing dispute"]:::sys
        RD --> WIN
    end

    subgraph BA[Buyer · Approver]
        REM --> DEC{Decision}
        DEC -->|reject with reason| REJ((Rejected))
        DEC -->|accept in full| SIGN[Sign payment undertaking]
        DEC -->|part-accept with amount and reason| SIGN2[Sign payment undertaking]
        SIGN --> WIN
        SIGN2 --> RD
    end

    EV --> NEXT((To cover, funding<br/>or early payment))

    classDef sys stroke-dasharray: 5 3
```

---

## 4. Credit insurance cover

Requested automatically when an invoice is accepted, from the insurer on the supplier–buyer relationship. Cover reserves
headroom on the insurer's per-buyer limit; funding consumes it, and settlement or cancellation releases it.

```mermaid
flowchart TD
    subgraph SYS[Earlio system]
        S((invoice.accepted)) --> G1{"Insurer on the<br/>relationship?"}:::sys
        G1 -->|no| UNI(["uninsured<br/>(financing may be unavailable)"])
        G1 -->|yes| REQ(["requested"])
        REQ --> GW["Route by the insurer's gateway:<br/>manual queue, API or CSV file"]:::sys
        RES --> HR{"Buyer-limit headroom<br/>covers the full %?"}:::sys
        HR -->|yes| APR([approved])
        HR -->|no| PAR(["partial: cover reduced<br/>to the headroom"])
        APR --> VAL[Valid 30 days]:::sys
        PAR --> VAL
        VAL --> G2{"Used for funding<br/>within 30 days?"}:::sys
        G2 -->|"yes: reservation consumed"| USED((Covers the financing))
        G2 -->|no| EXP(["expired: limit freed"])
    end

    subgraph UW[Insurer · Underwriter]
        GW --> DEC{"Decision<br/>(one by one or CSV import)"}
        DEC -->|decline with reason| DECL([declined])
        DEC -->|"approve, optionally<br/>with lower cover %"| RES[Reserve limit headroom]
        LIM["Set per-buyer insured limits<br/>(not below current exposure)"]
    end

    classDef sys stroke-dasharray: 5 3
```

At selection (workflow 5) the cover must meet the bank's minimum cover percentage in its terms.

---

## 5. Bank financing (marketplace)

One funding route per invoice: bank financing **or** early payment (workflow 7). Gates 1–4 run when funding opens; gates
5–7 run per bank inside the rule engine (bank terms, exposure limits, cover). The lien is reserved at selection, which
makes two parallel selections safe: the second one fails with a lien conflict.

```mermaid
flowchart TD
    subgraph SF[Supplier · FinanceUser]
        S((Accepted invoice)) --> OF[Request funding]
        RE[Re-check gates]
        CMP["Compare offers: annualised cost,<br/>net cash, FX rate"]
        CMP --> SEL[Select an offer]
    end

    subgraph SAP[Supplier · Approver]
        CON["Consent to assignment and terms,<br/>answer the bank's requirements"]
        CANC["Cancel in cooling-off<br/>(until payment is instructed)"]
    end

    subgraph BA[Buyer · Approver]
        ACK[Acknowledge assignment notice]
    end

    subgraph BC[Bank · CreditOfficer]
        INVT["Invitation in inbox"] --> BD{Bid?}
        BD -->|decline| DCL([invitation declined])
        BD -->|yes| PRV["Preview price within terms<br/>(offer composer, API or CSV)"]
        PRV --> SND[Send offer]
        CNF[Confirm financing]
        BDEC[Decline at confirmation]
    end

    subgraph SYS[Earlio system]
        OF --> G14{"Gates 1–4: parties verified,<br/>relationship active, accepted,<br/>dispute window elapsed"}:::sys
        G14 -->|fail| NE(["NotEligible with reasons"])
        NE --> RE --> G14
        G14 -->|pass| INV["Invite supplier's and buyer's<br/>preferred banks + partner bank<br/>(white-label: partner only)"]:::sys
        INV --> OFFS([OpenForFunding])
        OFFS --> INVT
        SND --> G57{"Gates 5–7 for this bank:<br/>terms, limits, cover"}:::sys
        G57 -->|fail| NO((Offer refused with reasons))
        G57 -->|pass| OR(["offer Submitted,<br/>invoice OffersReceived"])
        OR --> EXPW["Worker: expire offers past validity;<br/>none live → OpenForFunding"]:::sys
        OR --> CMP
        SEL --> RSV{"Offer live, cover meets bank minimum,<br/>limits reserve, lien free?"}:::sys
        RSV -->|lien taken| LC(["LienConflict"])
        RSV -->|yes| CP(["financing request ConsentPending,<br/>lien Reserved, limits reserved"])
        CP --> CON
        CON --> BCF(["BankConfirming,<br/>assignment notice issued"])
        BCF --> ACK
        BCF --> CNF
        CNF --> RC{"Re-check sanctions and KYC, gates,<br/>cover, buyer acknowledged?"}:::sys
        RC -->|no| WAIT((Refused with reason))
        RC -->|yes| APPR(["Approved → DisbursementInstructed"])
        BDEC --> REL(["Declined: limits, lien<br/>and cover released"])
        CANC --> CXL(["Cancelled: everything released"])
    end

    APPR --> D6((To disbursement))
    CP -.-> CANC
    BCF -.-> CANC
    BCF -.-> BDEC

    classDef sys stroke-dasharray: 5 3
```

Financing request statuses: `ConsentPending → BankConfirming → Approved → DisbursementInstructed → Funded`, with the
exits `Declined`, `Cancelled`, `LienConflict` and `Failed`. Offer statuses: `Drafted → Submitted → Selected`, or
`Rejected`, `Expired`, `Withdrawn`, `Superseded`.

---

## 6. Disbursement

Starts from the `financing.approved` event. The financing becomes real only when the bank reports the credit
(`completeFunding`).

```mermaid
flowchart TD
    subgraph SYS[Earlio system]
        S((financing.approved)) --> FX["Book FX at the offer rate"]:::sys
        FX --> VD{"Before the bank's cut-off<br/>on a business day?"}:::sys
        VD -->|no| Q(["QueuedForValueDate"])
        Q --> WK["Worker: on the value date"]:::sys
        VD -->|yes| SEND[Send instruction to the bank]:::sys
        WK --> SEND
        SEND --> ACC{Bank accepts?}:::sys
        ACC -->|yes| SENT([Sent])
        SENT --> POLL["Worker: poll the bank for the outcome"]:::sys
        POLL --> OUT{Outcome}
        OUT -->|pending| POLL
        OUT -->|credited, amount matches| CRED([Credited])
        CRED --> CF["completeFunding: lien Active, bank limits<br/>and cover consumed, other offers rejected,<br/>invoice Funded"]:::sys
        CF --> EVT["financing.funded event:<br/>create collection expectation"]:::sys
        OUT -->|credited, amount differs| MM["Exception: AmountMismatch,<br/>held for operations"]:::sys
        OUT -->|returned| RET["Returned + exception"]:::sys
        OUT -->|failed| FAIL([Failed])
        ACC -->|no| FAIL
        FAIL --> TRY{"Attempts < 3?"}:::sys
        TRY -->|yes| RTY([Retry]) --> WK
        TRY -->|no| REV["Reversed + exception;<br/>financing Failed, everything released"]:::sys
    end

    subgraph OPS[Bank · Operations or PlatformAdmin]
        MM --> RES{Resolve exception}
        RES -->|accept mismatch| CRED
        RET --> RES
    end

    EVT --> E((To collection))
    REV --> E2((Supplier can choose again))

    classDef sys stroke-dasharray: 5 3
```

---

## 7. Early payment by the buyer

The alternative route: the buyer pays the supplier early at a published discount. Choosing it withdraws every bank offer.

```mermaid
flowchart TD
    subgraph SF[Supplier · FinanceUser]
        S((Accepted invoice)) --> PUB["Publish discount schedule:<br/>table of dates or annual rate pro rata"]
        PUB --> OF["Request funding<br/>(opens the invoice, workflow 5)"]
        WD[Withdraw schedule]
    end

    subgraph BA[Buyer · Viewer or Approver]
        OF --> QT["Quote: pay date, funding source<br/>(cash or own bank loan) → cost and saving"]
    end
    subgraph BAP[Buyer · Approver]
        QT --> CF[Confirm early payment]
    end

    subgraph SYS[Earlio system]
        CF --> G{"Invoice open for funding,<br/>no bank route chosen, gates pass?"}:::sys
        G -->|no| X((Refused with reason))
        G -->|yes| EX["Execute simulated payment;<br/>withdraw all offers, close invitations,<br/>mark schedule used"]:::sys
        EX --> FD(["invoice Funded, route early_payment"])
        FD --> WK["Worker: credit supplier,<br/>book bank commission"]:::sys
        WK --> ST([Settled]) --> CL((Closed))
    end

    PUB -.-> WD

    classDef sys stroke-dasharray: 5 3
```

---

## 8. Collection, reconciliation and exceptions

Every funded invoice gets one unique payment reference, issued to the buyer. A payment can arrive by bank callback or
as a statement line; the two reconcile against each other.

```mermaid
flowchart TD
    subgraph SYS[Earlio system]
        S((financing.funded)) --> EXP(["Expectation: Expected,<br/>unique payment reference"])
        EXP --> DUE{"Paid by the due date?"}:::sys
        DUE -->|no| OVD(["invoice Overdue → workflow 10"])
        IN["Ingest callback or statement line<br/>(stored once, duplicates ignored)"]:::sys
        IN --> M{Matches a reference?}:::sys
        M -->|no| UNM["Exception: Unmatched"]:::sys
        M -->|yes| AMT{Amount and timing}:::sys
        AMT -->|short| SP["Exception: ShortPaid"]:::sys
        AMT -->|"over (beyond late interest)"| OP["Exception: OverPaid"]:::sys
        AMT -->|after due date| LT["Late interest; exception: Late"]:::sys
        AMT -->|exact, on time| MAT([Matched])
        LT --> MAT
        MAT --> DIST["Distribute: principal to bank, retention to<br/>supplier at settlement FX, platform fee;<br/>lien Released"]:::sys
        DIST --> SET(["Distributed; invoice Settled"])
        SET --> REC["Worker: statement line backs<br/>the payment"]:::sys
        REC --> CLS(["Reconciled; invoice Closed"])
    end

    subgraph BUY[Buyer · FinanceUser]
        PD["See payments due with<br/>reference and collection account"] --> PAY[Pay]
    end

    subgraph OPS[Bank · Operations or PlatformAdmin]
        IMP["Import statement<br/>(also fetched daily)"]
        Q["Exceptions queue"] --> RES{"Resolve: assign to invoice, wait,<br/>accept short payment, refund, acknowledge"}
    end

    EXP --> PD
    PAY --> IN
    IMP --> IN
    UNM --> Q
    SP --> Q
    OP --> Q
    RES -->|assign or accept| MAT

    classDef sys stroke-dasharray: 5 3
```

Expectation statuses: `Expected → PartiallyReceived | Received → Matched → Distributed → Reconciled`, or `Exception`.
Exception types: `Unmatched`, `ShortPaid`, `OverPaid`, `Late`, `AmountMismatch`, `DisbursementReturned`, `DisbursementFailed`.

---

## 9. Disputes

A freezing dispute stops the invoice moving on, and while it is open late interest, dunning and the insurer's waiting
period stand still. Default timers: response 48 hours, escalation 72 hours, timeout 240 hours (a governed setting).

```mermaid
flowchart TD
    subgraph PARTY[Supplier or Buyer · FinanceUser or Approver]
        S((Start)) --> RAISE["Raise dispute with reason<br/>and optional amount"]
        MSG[Post messages and evidence]
        WDR["Withdraw (raiser only;<br/>concedes the point)"]
        CN["Buyer: issue a credit note"]
    end

    subgraph SYS[Earlio system]
        RAISE --> W{"Invoice Accepted inside the window,<br/>or Funded / Overdue?"}:::sys
        W -->|no| X((Refused with reason))
        W -->|yes| OPEN(["Open; invoice Disputed;<br/>default clock frozen"])
        OPEN --> T1["Worker: no decision<br/>after 72 h"]:::sys
        T1 --> ESC([Escalated])
        OPEN --> T2["Worker: no decision<br/>after 240 h"]:::sys
        ESC --> T2
        T2 --> TO(["TimedOut: freeze lifts,<br/>nothing decided"])
        APPLY --> UNF["Unfreeze: invoice returns to its<br/>earlier status unless another<br/>freezing dispute is open"]:::sys
        TO --> UNF
        WDR --> UNF
    end

    subgraph PLT[Earlio · PlatformAdmin]
        ESC --> REV[Start review]
        OPEN --> REV
        REV --> UR([UnderReview])
        UR --> DEC{Decide}
        DEC -->|for supplier| FS([ResolvedForSupplier])
        DEC -->|for buyer| FB([ResolvedForBuyer])
        FB --> G{Outcome}
        G -->|credit amount| CRN["Issue credit note:<br/>reduces invoice or exposure"]
        G -->|"post-funding,<br/>supplier-caused"| RCS["Create recourse:<br/>supplier owes the bank"]
        CRN --> APPLY[Record decision]
        RCS --> APPLY
        G -->|neither| APPLY
        FS --> APPLY
    end

    OPEN --> MSG
    OPEN -.-> WDR
    UNF --> E((Done))

    classDef sys stroke-dasharray: 5 3
```

A part-acceptance (workflow 3) records the unaccepted remainder as a **non-freezing** dispute that can later become a
credit note. A buyer can also issue a credit note directly.

---

## 10. Default, insurance claim and recovery

Starts when a financed invoice becomes `Overdue`. The insurer's waiting period counts only unfrozen days. A buyer
insolvency waives the waiting period.

```mermaid
flowchart TD
    subgraph SYS[Earlio system]
        S((invoice.overdue)) --> OD(["Default opened: Overdue,<br/>insurer waiting period"])
        OD --> DUN["Worker: dunning notices<br/>(paused while disputed)"]:::sys
        DUN --> WP{"Waiting period over,<br/>or insolvency reported?"}:::sys
        WP -->|no| DUN
        WP -->|yes| CE(["ClaimEligible; invoice Defaulted;<br/>claim deadline set"])
        CE --> DL{"Claim filed<br/>before the deadline?"}:::sys
        DL -->|no| LAP([ClaimLapsed])
        FILED(["ClaimFiled; claim Filed"])
        PAID --> WF["Payout waterfall: bank principal<br/>and charges first, then supplier's<br/>retention; shortfall booked"]:::sys
        WF --> CLO(["Default Paid; invoice Closed;<br/>lien released"])
        REJ --> RC{"Upheld supplier-caused<br/>dispute on this invoice?"}:::sys
        RC -->|yes| RCS([Recourse opened])
        RC -->|no| CLO2(["Invoice Closed; lien released"])
        RCS --> CLO2
        LATE["Buyer pays after all"]:::sys --> RECV([Recovered])
    end

    subgraph BC[Bank · CreditOfficer]
        INS["Report buyer insolvency<br/>(or PlatformAdmin)"]
        DL -->|yes| FILE["File claim with documents"]
        FILE --> FILED
        RECO["Record recoveries from buyer or estate:<br/>net of costs, shared pro rata to losses"]
        RPAY["Record recourse repayments"]
    end

    subgraph CH[Insurer · ClaimsHandler]
        FILED --> REVW["Start review: documents and<br/>standard exclusions checked"]
        REVW --> DEC{Decide}
        DEC -->|reject| REJ([Rejected])
        DEC -->|"approve in full<br/>or approve less"| APR([Approved / PartiallyApproved])
        APR --> PAYC[Record payout]
        PAYC --> PAID([claim Paid])
    end

    subgraph SAP[Supplier · Approver]
        MODE{"Small supplier:<br/>repayment mode"}
        MODE -->|default| OFFS["Offset: at most 20%<br/>of each later payout"]
        MODE -->|choose| PLAN[90-day instalment plan]
    end

    INS -.-> WP
    CLO --> RECO
    RCS --> MODE
    RCS --> RPAY

    classDef sys stroke-dasharray: 5 3
```

Default statuses: `Overdue → WaitingPeriod → ClaimEligible → ClaimFiled → Paid`, or `ClaimLapsed` / `Recovered`. Claim
statuses: `Filed → UnderReview → Approved | PartiallyApproved | Rejected → Paid`. Recourse is `open` until `settled`, and
carries no penalty interest for small suppliers.

---

## 11. Terms and platform settings (maker-checker)

Rules are data (architecture rule 2): banks and insurers change their terms by publishing a new version, never through
code. Both terms and governed platform settings need a second person to approve.

```mermaid
flowchart TD
    subgraph MK["Maker · bank RelationshipManager, insurer Underwriter or PlatformAdmin"]
        S((Start)) --> SET["Create terms set<br/>(default or scoped override)"]
        SET --> DR["Draft a version (editor or JSON import)"]
        DR --> SIM["Simulate against 20 sample invoices<br/>and compare with terms in force"]
        SIM --> SUB["Submit with effective date"]
    end

    subgraph SYS[Earlio system]
        DR --> VAL{"Valid against the schema<br/>and platform guardrails?"}:::sys
        VAL -->|no| DR
        VAL -->|yes| D([draft])
        SUB --> P([pending])
        PUBL --> ACT(["active from the effective date;<br/>previous version end-dated"])
        ACT --> RET["Worker: retire versions<br/>past their end date"]:::sys
        RET --> R([retired])
    end

    subgraph CK[Checker · bank or insurer Approver, or PlatformAdmin]
        P --> DIFF[Review diff in the approvals inbox]
        DIFF --> DEC{"Approve?<br/>Must not be the maker"}
        DEC -->|yes| PUBL[Publish]
        DEC -->|no| BACK[Send back]
    end

    BACK --> D
    SUB -.->|maker withdraws| D

    classDef sys stroke-dasharray: 5 3
```

Governed platform settings (dispute window, dispute timers, network or white-label mode and others) follow the same
shape. One PlatformAdmin proposes a value (`pending`), and a **different** PlatformAdmin approves it (`applied`) or
rejects it (`rejected`). The proposer can withdraw it (`withdrawn`).

```mermaid
flowchart LR
    subgraph A1[PlatformAdmin · maker]
        S((Start)) --> PR[Propose new value]
        WD[Withdraw]
    end
    subgraph SYS[Earlio system]
        PR --> PEND([pending])
        APL([applied]) --> E((In force))
        REJ([rejected])
        WD --> WDN([withdrawn])
    end
    subgraph A2[Another PlatformAdmin · checker]
        PEND --> DEC{Decision}
        DEC -->|approve| APL
        DEC -->|reject| REJ
    end
    PEND -.-> WD
```
