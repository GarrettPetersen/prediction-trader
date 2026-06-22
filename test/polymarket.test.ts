import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPolymarketExecutionStatus } from "../src/marketplaces/polymarket.js";

describe("Polymarket execution status", () => {
  it("marks matched orders as filled", () => {
    assert.equal(getPolymarketExecutionStatus({ success: true, status: "matched" }), "filled");
  });

  it("marks explicit CLOB errors as failed", () => {
    assert.equal(getPolymarketExecutionStatus({ error: "not enough balance" }), "failed");
  });

  it("marks HTTP-style error statuses as failed", () => {
    assert.equal(getPolymarketExecutionStatus({ status: 400 }), "failed");
  });
});
