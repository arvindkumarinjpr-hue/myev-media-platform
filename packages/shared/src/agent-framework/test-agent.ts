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
