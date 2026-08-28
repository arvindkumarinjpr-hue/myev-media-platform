import { evaluateThreshold } from "./scoring-threshold";

describe("evaluateThreshold", () => {
  it("passes when overall >= threshold, at any parametrized threshold", () => {
    for (const threshold of [0, 50, 65, 70, 80, 100]) {
      expect(evaluateThreshold(threshold, threshold)).toEqual({ threshold, passed: true });
      expect(evaluateThreshold(Math.min(100, threshold + 1), threshold).passed).toBe(true);
      if (threshold >= 1) expect(evaluateThreshold(threshold - 1, threshold).passed).toBe(false);
    }
  });

  it("echoes back the exact threshold it was given (not a hardcoded default)", () => {
    expect(evaluateThreshold(90, 42).threshold).toBe(42);
    expect(evaluateThreshold(10, 88).threshold).toBe(88);
  });

  it("treats the boundary as a pass", () => {
    expect(evaluateThreshold(70, 70).passed).toBe(true);
    expect(evaluateThreshold(69, 70).passed).toBe(false);
  });
});
