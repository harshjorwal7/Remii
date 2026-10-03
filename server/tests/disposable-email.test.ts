import { describe, expect, test } from "bun:test";
import { isDisposableEmail } from "../src/auth/disposable-email";

describe("disposable email detection", () => {
  test("identifies explicitly disallowed domains", () => {
    expect(isDisposableEmail("user@mailinator.com")).toBe(true);
    expect(isDisposableEmail("attacker@guerrillamail.com")).toBe(true);
    expect(isDisposableEmail("bot@sharklasers.com")).toBe(true);
    expect(isDisposableEmail("free@tempmail.com")).toBe(true);
    expect(isDisposableEmail("free@10minutemail.com")).toBe(true);
    expect(isDisposableEmail("scam@yopmail.com")).toBe(true);
    expect(isDisposableEmail("test@trashmail.com")).toBe(true);
  });

  test("identifies subdomains of disposable providers", () => {
    expect(isDisposableEmail("user@sub.mailinator.com")).toBe(true);
    expect(isDisposableEmail("test@deep.sub.guerrillamail.com")).toBe(true);
  });

  test("normalizes uppercase and surrounding spaces", () => {
    expect(isDisposableEmail(" USER@MAILINATOR.COM ")).toBe(true);
    expect(isDisposableEmail("bot@GuerrillaMail.Com")).toBe(true);
  });

  test("allows legitimate consumer and business email domains", () => {
    expect(isDisposableEmail("alice@gmail.com")).toBe(false);
    expect(isDisposableEmail("bob@yahoo.com")).toBe(false);
    expect(isDisposableEmail("carol@outlook.com")).toBe(false);
    expect(isDisposableEmail("dave@company.co.uk")).toBe(false);
    expect(isDisposableEmail("engineer@github.com")).toBe(false);
  });

  test("handles empty or malformed inputs safely", () => {
    expect(isDisposableEmail("")).toBe(false);
    expect(isDisposableEmail("not-an-email")).toBe(false);
    expect(isDisposableEmail("@mailinator.com")).toBe(true);
    expect(isDisposableEmail("user@")).toBe(false);
  });
});
