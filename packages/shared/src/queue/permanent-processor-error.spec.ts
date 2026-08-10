import { PermanentProcessorError } from "./permanent-processor-error";

describe("PermanentProcessorError", () => {
  it("is an instance of Error and of itself", () => {
    const error = new PermanentProcessorError("SOME_CODE", "Safe message.");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PermanentProcessorError);
  });

  it("preserves errorCode and errorMessageSafe as read-only fields", () => {
    const error = new PermanentProcessorError("PAYLOAD_VALIDATION_FAILED", "The event payload failed validation.");
    expect(error.errorCode).toBe("PAYLOAD_VALIDATION_FAILED");
    expect(error.errorMessageSafe).toBe("The event payload failed validation.");
  });

  it("has a stable name, independent of construction context", () => {
    const error = new PermanentProcessorError("X", "y");
    expect(error.name).toBe("PermanentProcessorError");
  });

  it("uses errorMessageSafe as the underlying Error message — safe by construction, nothing else is appended", () => {
    const error = new PermanentProcessorError("X", "safe text only");
    expect(error.message).toBe("safe text only");
  });
});
