# ADR-001: Modular monolith
One deployable API process (plus an in-process worker loop) with strict module boundaries (`apps/api/src/modules/*`, schema per module). Chosen for MVP speed and transactional integrity across invoice, lien, limits and audit writes. Modules may later be split out because they communicate through service functions and outbox events.
