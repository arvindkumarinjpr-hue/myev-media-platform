import { ApiError, friendlyMessage, isStaleLockConflict } from "./errors";

describe("ApiError / friendlyMessage / isStaleLockConflict", () => {
  it("carries status/code/message/details from the backend's own error body", () => {
    const error = new ApiError(422, { code: "KNOWLEDGE_VALIDATION_FAILED", message: "failed", details: ["a", "b"] });
    expect(error.status).toBe(422);
    expect(error.code).toBe("KNOWLEDGE_VALIDATION_FAILED");
    expect(error.details).toEqual(["a", "b"]);
  });

  it("friendlyMessage never leaks a raw non-ApiError value", () => {
    expect(friendlyMessage(new TypeError("Failed to fetch"))).toBe("Something went wrong. Please try again.");
    expect(friendlyMessage("some raw string")).toBe("Something went wrong. Please try again.");
  });

  it("friendlyMessage falls back to a stable message for a status with no server message", () => {
    expect(friendlyMessage(new ApiError(401, { code: "X", message: "" }))).toBe("Your session has expired. Please sign in again.");
    expect(friendlyMessage(new ApiError(403, { code: "X", message: "" }))).toBe("You don't have permission to do that.");
  });

  it("friendlyMessage prefers the server's own message when present", () => {
    expect(friendlyMessage(new ApiError(422, { code: "X", message: "Name is required." }))).toBe("Name is required.");
  });

  it("isStaleLockConflict recognizes only the specific 409 KNOWLEDGE_CONFLICT shape", () => {
    expect(isStaleLockConflict(new ApiError(409, { code: "KNOWLEDGE_CONFLICT", message: "" }))).toBe(true);
    expect(isStaleLockConflict(new ApiError(409, { code: "SOME_OTHER_CODE", message: "" }))).toBe(false);
    expect(isStaleLockConflict(new ApiError(422, { code: "KNOWLEDGE_CONFLICT", message: "" }))).toBe(false);
    expect(isStaleLockConflict(new Error("nope"))).toBe(false);
  });
});
