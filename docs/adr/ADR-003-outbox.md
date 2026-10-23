# ADR-003: Transactional outbox
State changes write an event to `platform.outbox` in the same transaction. A worker (`drainOutbox`) dispatches to subscribers (notifications, projections). No broker in the MVP. Handlers must be idempotent; delivery is at-least-once.
