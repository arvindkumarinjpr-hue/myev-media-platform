-- Milestone 8.2 correctness fix: persistent claim/lease for the
-- OutboxRelayManager transactional-outbox relay.
--
-- FOR UPDATE SKIP LOCKED only provides mutual exclusion for the lifetime
-- of the claiming transaction. The "no Redis/BullMQ network call while a
-- Postgres row lock is held" invariant forces that transaction to commit
-- BEFORE dispatch starts, which means the lock itself cannot be the
-- ownership mechanism during dispatch — empirically confirmed (two
-- independent claim attempts, run sequentially with the first fully
-- committed before the second begins, both successfully claimed the same
-- still-undispatched row). These three nullable columns are the minimal
-- additive fix: a lease persisted on the row itself, set by the atomic
-- claim UPDATE, extended by ownership-guarded renewal while dispatch is
-- in progress, and cleared by an ownership-guarded finalize.
--
-- No existing DomainEvent semantics change: dispatchedAt remains the sole
-- terminal marker, eventType/eventVersion/payload/occurredAt are
-- untouched, and a row with claimExpiresAt in the past is exactly as
-- eligible for claim as a row that was never claimed — that equivalence
-- is the entire crash-recovery mechanism; no separate sweep job is
-- needed.
ALTER TABLE "domain_events"
  ADD COLUMN "claim_token" UUID,
  ADD COLUMN "claimed_at" TIMESTAMP(3),
  ADD COLUMN "claim_expires_at" TIMESTAMP(3);
