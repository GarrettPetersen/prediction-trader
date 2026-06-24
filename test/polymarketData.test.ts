import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGammaList } from "../src/marketplaces/polymarketData.js";

describe("Polymarket data helpers", () => {
  it("parses Gamma stringified arrays", () => {
    assert.deepEqual(parseGammaList('["Yes","No"]'), ["Yes", "No"]);
  });

  it("passes through array values", () => {
    assert.deepEqual(parseGammaList(["1", 2]), ["1", "2"]);
  });

  it("returns an empty list for malformed values", () => {
    assert.deepEqual(parseGammaList("not json"), []);
    assert.deepEqual(parseGammaList(undefined), []);
  });
});
