import "reflect-metadata";
import { IsString } from "class-validator";
import type { AgentDefinition } from "./agent-definition";

/**
 * Module 3 Phase 3.2 — Part 16: "Create at least one TEST-ONLY generic
 * Agent definition that uses FakeProvider... It must not be a
 * business/content Agent." Exists solely to prove the full framework
 * end-to-end (registry → Knowledge Pack resolution → context building →
 * provider execution → structured-output validation → ai_jobs
 * persistence) with zero paid/network AI calls. Never registered
 * alongside a real business agent's identifier.
 */
export class TestEchoAgentInput {
  @IsString()
  message!: string;
}

export class TestEchoAgentOutput {
  @IsString()
  echo!: string;
}

export const TEST_ECHO_AGENT_V1: AgentDefinition<TestEchoAgentInput, TestEchoAgentOutput> = {
  identifier: "test-echo-agent",
  version: 1,
  purpose: "Deterministic test-only agent exercising the full Agent Framework via FakeProvider.",
  type: "test",
  providerPreference: { provider: "fake", model: "fake-model-1" },
  inputSchema: TestEchoAgentInput,
  outputSchema: TestEchoAgentOutput,
  buildPrompt: (input) => ({ prompt: input.message }),
  timeoutMs: 5_000,
  executionPolicy: { maxAttempts: 1 },
};

/**
 * Module 3 Phase 3.3 — three more test-only fixture agents, each pointed
 * at a distinct FakeProvider instance/id registered specifically to
 * prove the durable dispatch, retry, and permanent-failure paths against
 * a real, already-running Worker process (whose AIProviderRegistry is
 * fixed at bootstrap, unlike Phase 3.2's own unit tests, which could
 * freely construct a fresh registry per test). Plain-text output (no
 * outputSchema) — proving retry/failure/timeout behavior needs no
 * structured-output coverage of its own; that's already proven by
 * TEST_ECHO_AGENT_V1 above. None of these is a business/content agent.
 */
export const TEST_FLAKY_AGENT_V1: AgentDefinition<TestEchoAgentInput, object> = {
  identifier: "test-flaky-agent",
  version: 1,
  purpose: "Deterministic test-only agent proving transient-failure-then-retry-then-success against a real durable dispatch.",
  type: "test",
  providerPreference: { provider: "fake-flaky", model: "fake-model-1" },
  inputSchema: TestEchoAgentInput,
  buildPrompt: (input) => ({ prompt: input.message }),
  timeoutMs: 5_000,
  executionPolicy: { maxAttempts: 3 },
};

export const TEST_PERMANENT_FAIL_AGENT_V1: AgentDefinition<TestEchoAgentInput, object> = {
  identifier: "test-permanent-fail-agent",
  version: 1,
  purpose: "Deterministic test-only agent proving a non-retryable provider failure reaches a terminal AiJob state with no retry.",
  type: "test",
  providerPreference: { provider: "fake-permanent", model: "fake-model-1" },
  inputSchema: TestEchoAgentInput,
  buildPrompt: (input) => ({ prompt: input.message }),
  timeoutMs: 5_000,
  executionPolicy: { maxAttempts: 3 },
};

export const TEST_TIMEOUT_AGENT_V1: AgentDefinition<TestEchoAgentInput, object> = {
  identifier: "test-timeout-agent",
  version: 1,
  purpose: "Deterministic test-only agent proving a provider timeout maps to the exact TIMED_OUT AiJob status once retries are exhausted.",
  type: "test",
  providerPreference: { provider: "fake-timeout", model: "fake-model-1" },
  inputSchema: TestEchoAgentInput,
  buildPrompt: (input) => ({ prompt: input.message }),
  timeoutMs: 5_000,
  // maxAttempts: 1 — the very first (and only) attempt is already the
  // last, so the worker processor's own terminal-vs-retry branch takes
  // the terminal path immediately and deterministically.
  executionPolicy: { maxAttempts: 1 },
};
