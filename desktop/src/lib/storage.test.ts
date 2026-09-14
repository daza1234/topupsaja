import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { safeGet, safeSet } from "./storage.ts";

const real = globalThis.localStorage;
afterEach(() => {
  globalThis.localStorage = real;
});

test("safeGet: localStorage melempar DOMException → null, tidak lempar", () => {
  globalThis.localStorage = {
    getItem() {
      throw new DOMException("The string did not match the expected pattern.", "SyntaxError");
    },
  } as unknown as Storage;
  assert.equal(safeGet("topupsaja.folder"), null);
});

test("safeSet: localStorage melempar → no-op, tidak lempar", () => {
  globalThis.localStorage = {
    setItem() {
      throw new DOMException("The string did not match the expected pattern.", "SyntaxError");
    },
  } as unknown as Storage;
  assert.doesNotThrow(() => safeSet("topupsaja.model", "ts/x"));
});

test("safeGet/safeSet: jalur normal tetap membaca dan menulis", () => {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  } as unknown as Storage;
  safeSet("k", "v");
  assert.equal(safeGet("k"), "v");
});
