/**
 * DI token for the process's frozen `QueueRegistry` (from @myev/shared).
 *
 * Every worker process — the general worker (`apps/worker`) and the
 * dedicated render/media worker (`apps/render-worker`) — provides its own
 * `QueueRegistry` under this one token: the manifests it registers and
 * the handlers it binds, frozen and validated (bijection scoped to that
 * worker's own WORKER_QUEUES) at DI construction time. `BullMqWorkerManager`
 * and `BackgroundJobReconciliationManager` (both here in worker-core)
 * inject the registry via this token without knowing which worker they
 * run in.
 */
export const QUEUE_REGISTRY = Symbol("QUEUE_REGISTRY");
