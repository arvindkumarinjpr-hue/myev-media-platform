/**
 * Module 9 Phase 9.3 — the error taxonomy any PublishingChannelProvider
 * implementation (a real connector in a later phase, or the fixture
 * provider today) throws from `publish()`/`validateConnection()` to
 * signal whether a failure is worth retrying. Not test-specific — this
 * is part of the provider contract itself, so a future real connector
 * (WordPress/YouTube/Facebook/Instagram) throws the same two types and
 * the worker execution service's retry classification never needs to
 * know which provider it was talking to.
 */
export class PublishingProviderRetryableError extends Error {
  constructor(
    public readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "PublishingProviderRetryableError";
  }
}

export class PublishingProviderPermanentError extends Error {
  constructor(
    public readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "PublishingProviderPermanentError";
  }
}
