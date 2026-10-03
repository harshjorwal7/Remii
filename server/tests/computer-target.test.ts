import { describe, expect, test } from "bun:test";
import {
  checkComputerAddress,
  checkNavigationTarget,
} from "../src/computer/target";

describe("navigation targets", () => {
  test("allows an ordinary public address", () => {
    expect(checkNavigationTarget("https://example.com/pricing")).toEqual({
      allowed: true,
      url: "https://example.com/pricing",
    });
  });

  /*
   * Each of these IS ALLOWED now, and that is the decision rather than an oversight.
   *
   * There used to be a floor under them — "reachable from the Bot's container and not from the
   * person's laptop" — with an `allowPrivateHosts` opt-in that a deployment had to remember to set.
   * Individual-user SaaS removed the opt-in entirely: the person asking is trusted, so their Bot may
   * open anything on the web INCLUDING this deployment's own network, because a user's own service
   * legitimately lives at a private address and refusing it made the product useless for them.
   *
   * What survives is the check that no configuration can reach, and it is tested below: the cloud
   * metadata endpoints, in every spelling an address can carry. That is the one destination where
   * "open anything on the web" would hand somebody this deployment's own credentials, so it is the
   * one that stays refused — and the private-range rule is not a weaker version of it, it was a
   * different rule about a different question.
   */
  test.each([
    ["http://localhost:5432", "loopback by name"],
    ["http://127.0.0.1/admin", "loopback by address"],
    ["http://10.0.0.5/", "RFC1918 10/8"],
    ["http://192.168.1.1/", "RFC1918 192.168/16"],
    ["http://172.16.4.4/", "RFC1918 172.16/12"],
  ])("allows %s (%s), because the person asking is trusted", (url) => {
    expect(checkNavigationTarget(url).allowed).toBe(true);
  });

  // Separated from the list above because these are refused under every configuration; the second
  // argument exercises the private-host opt-in explicitly.
  test.each([
    ["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
    ["http://metadata.google.internal/", "cloud metadata by name"],
  ])("refuses %s (%s) even with private hosts allowed", (url) => {
    for (const allowPrivateHosts of [false, true]) {
      const verdict = checkNavigationTarget(url, { allowPrivateHosts });

      expect(verdict.allowed).toBe(false);
      expect(verdict.allowed === false && verdict.reason).toContain(
        "cloud credentials",
      );
    }
  });

  // The same destinations written the other ways a URL can carry them. Chromium resolves every one
  // of these to the address the tests above refuse, so a floor that only matches dotted quads and
  // exact names is a floor with a door in it.
  test.each([
    [
      "http://[::ffff:169.254.169.254]/latest/meta-data/",
      "IPv4-mapped metadata",
    ],
    ["http://[fd00:ec2::254]/latest/meta-data/", "AWS metadata over IPv6"],
    ["http://metadata.google.internal./", "metadata name with a trailing dot"],
    [
      "http://[64:ff9b::169.254.169.254]/latest/meta-data/",
      "metadata behind the NAT64 prefix",
    ],
    [
      "http://[::169.254.169.254]/latest/meta-data/",
      "metadata as an IPv4-compatible address",
    ],
  ])("refuses %s (%s) even with private hosts allowed", (url) => {
    for (const allowPrivateHosts of [false, true]) {
      const verdict = checkNavigationTarget(url, { allowPrivateHosts });

      expect(verdict.allowed).toBe(false);
      expect(verdict.allowed === false && verdict.reason).toContain(
        "cloud credentials",
      );
    }
  });

  test.each([
    ["http://[::ffff:127.0.0.1]/", "IPv4-mapped loopback"],
    ["http://[::ffff:10.0.0.5]/", "IPv4-mapped RFC1918"],
    ["http://[fe80::1]/", "link-local IPv6"],
    ["http://[fc00::1]/", "unique local IPv6"],
    ["http://[0:0:0:0:0:0:0:1]/", "IPv6 loopback written out in full"],
  ])("allows %s (%s), for the same reason", (url) => {
    expect(checkNavigationTarget(url).allowed).toBe(true);
  });

  // Public IPv6 is most of the internet. Refusing it to be safe would be its own outage.
  test("allows ordinary public IPv6", () => {
    expect(checkNavigationTarget("http://[2606:4700::1111]/").allowed).toBe(
      true,
    );
    expect(checkNavigationTarget("https://example.com./").allowed).toBe(true);
  });

  test("refuses a non-web scheme, naming it", () => {
    const verdict = checkNavigationTarget("file:///etc/passwd");

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toBe(
      "Only web addresses are allowed, and that one is file.",
    );
  });

  test("refuses something that is not an address at all", () => {
    expect(checkNavigationTarget("open the pricing page")).toEqual({
      allowed: false,
      reason: "That is not a web address.",
    });
  });

  // The option is still in the signature and still ignored, which is worth pinning: a caller that
  // passes `allowPrivateHosts: false` expecting a floor gets the same permissive answer, so the
  // parameter cannot be mistaken for a control that does something.
  test("the private-host option no longer changes the answer", () => {
    for (const allowPrivateHosts of [false, true]) {
      expect(
        checkNavigationTarget("http://localhost:3000", { allowPrivateHosts })
          .allowed,
      ).toBe(true);
    }
  });

  // The edges of 172.16/12 are no longer a boundary, so both sides are allowed along with the range
  // itself. Kept as a test because these are the three addresses most likely to be caught by a future
  // range check reintroduced by accident, and this is where it would show.
  test("all of the 172.16/12 neighbourhood is allowed, boundaries included", () => {
    expect(checkNavigationTarget("http://172.15.0.1/").allowed).toBe(true);
    expect(checkNavigationTarget("http://172.16.0.1/").allowed).toBe(true);
    expect(checkNavigationTarget("http://172.31.255.255/").allowed).toBe(true);
    expect(checkNavigationTarget("http://172.32.0.1/").allowed).toBe(true);
  });
});

/**
 * The address a supervisor hands back, before anything is called on it.
 *
 * Not the navigation check. Our own supervisor answers with a loopback address for a container on
 * this machine, so refusing private hosts here would refuse the ordinary case. What is worth
 * checking is that the thing is an address at all, and that it is not the one place a token must
 * never be sent, because with a hosted provider it arrives from somebody else's API.
 */
describe("checkComputerAddress", () => {
  test("allows the private address our own supervisor returns", () => {
    expect(checkComputerAddress("http://127.0.0.1:49213")).toEqual({
      allowed: true,
      url: "http://127.0.0.1:49213/",
    });
  });

  test("allows a hosted provider's public address", () => {
    const verdict = checkComputerAddress("https://sandbox-abc123.example.net");
    expect(verdict.allowed).toBe(true);
  });

  test.each(["169.254.169.254", "metadata.google.internal", "metadata.goog"])(
    "refuses the cloud metadata address %s however it arrived",
    (host) => {
      const verdict = checkComputerAddress(`http://${host}/latest/meta-data/`);
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) {
        expect(verdict.reason).toContain("cloud credentials");
      }
    },
  );

  /*
   * The same address written the other ways, on this side too.
   *
   * A computer's address arrives from a provider rather than from a person, but the provider is a
   * plug and the address goes straight into a fetch carrying this deployment's computer token. The
   * spellings a browser resolves are the spellings a fetch resolves, so the two gates have to agree
   * on what a hostname is. `[fd00:ec2::254]` is the one that shows why: it is in the refused set
   * already and was still allowed, because a URL keeps the brackets and the set does not have them.
   */
  test.each([
    ["http://[::ffff:169.254.169.254]/", "IPv4-mapped"],
    ["http://[::ffff:a9fe:a9fe]/", "IPv4-mapped in hex"],
    ["http://[64:ff9b::169.254.169.254]/", "NAT64"],
    ["http://[fd00:ec2::254]/", "the IPv6 metadata endpoint"],
  ])("refuses %s (%s) as a computer address", (raw) => {
    const verdict = checkComputerAddress(raw);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toContain("cloud credentials");
    }
  });

  test.each(["file:///etc/passwd", "ftp://example.com", "gopher://x"])(
    "refuses %s, which is not a scheme a computer speaks",
    (raw) => {
      expect(checkComputerAddress(raw).allowed).toBe(false);
    },
  );

  test("refuses something that is not a URL", () => {
    const verdict = checkComputerAddress("not-an-address");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toContain("not a URL");
    }
  });
  /*
   * Lives in the `checkComputerAddress` block but exercises `checkNavigationTarget` — it did when it
   * was written, and moving it would only churn the diff. It is left here rather than relocated.
   *
   * The IPv6 spellings of "this machine" are now ALLOWED, for the same reason every other private
   * address is: the person asking is trusted and their own service may listen on any of them. What
   * this test is actually guarding is that these are addresses at all rather than something the parser
   * should refuse, and the metadata cases above are the ones that must stay refused.
   */
  test("the unspecified and loopback IPv6 forms are addresses, so they are allowed", () => {
    expect(checkNavigationTarget("http://[::ffff:0.0.0.0]:5432/").allowed).toBe(
      true,
    );
    expect(checkNavigationTarget("http://[::ffff:0:0]:5432/").allowed).toBe(
      true,
    );
    expect(checkNavigationTarget("http://[::]/").allowed).toBe(true);
    expect(checkNavigationTarget("http://[::1]/").allowed).toBe(true);
  });

  test("refuses the container credential endpoints even with private hosts allowed", () => {
    // Never allowed means never: the opt-in is the weakest configuration and is when this holds.
    const allowed = { allowPrivateHosts: true };
    expect(
      checkNavigationTarget("http://169.254.170.2/", allowed).allowed,
    ).toBe(false);
    expect(
      checkNavigationTarget("http://100.100.100.200/", allowed).allowed,
    ).toBe(false);
    expect(checkNavigationTarget("http://10.0.0.5/", allowed).allowed).toBe(
      true,
    );
  });
});
