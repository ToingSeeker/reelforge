import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, errorMessage } from "../src/api.ts";

test("a validation error says what is wrong, not just 'invalid workflow'", () => {
  const e = new ApiError(400, "VALIDATION_ERROR", "invalid workflow", {
    issues: [
      { path: "version", message: "Invalid input: expected 1" },
      { path: "project", message: "Invalid input" },
    ],
  });
  assert.equal(errorMessage(e), "invalid workflow: version: Invalid input: expected 1; project: Invalid input");
  const many = new ApiError(400, "VALIDATION_ERROR", "invalid workflow", { issues: Array.from({ length: 7 }, (_, i) => ({ path: `steps.${i}`, message: "Invalid input" })) });
  assert.match(errorMessage(many), /steps\.4: Invalid input \(\+2 more\)$/);
});

test("other errors keep their message", () => {
  assert.equal(errorMessage(new ApiError(400, "VALIDATION_ERROR", "/x.json is not valid JSON")), "/x.json is not valid JSON");
  assert.equal(errorMessage(new ApiError(409, "BUSY", "busy", { issues: "nope" })), "busy");
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage("plain"), "plain");
});

test("issues already spelled out in the message are not repeated", () => {
  const msg = 'invalid workflow: version: Invalid input: expected 1; steps.0: unknown step "kind"';
  const e = new ApiError(400, "VALIDATION_ERROR", msg, { issues: [{ path: "version", message: "Invalid input: expected 1" }, { path: "steps.0", message: 'unknown step "kind"' }] });
  assert.equal(errorMessage(e), msg);
});
