// Terminal target policy tests. Run with: npm test -w @deepconsol/api
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTargetPolicy, checkIp, resolveTarget, parseCidr } from "../dist/services/target-policy.js";

// Fixed "server addresses" so results don't depend on the test machine.
const SELF = ["127.0.0.1", "::1", "10.212.0.6", "172.17.0.1", "fe80::42:deff:fe14:46ed%docker0"];
const policy = (o = {}) => buildTargetPolicy({ selfAddresses: () => SELF, ...o });
const denied = (p, ip) => { const d = checkIp(p, ip); assert.equal(d.ok, false, `${ip} should be denied`); return d.reason; };
const allowed = (p, ip) => assert.equal(checkIp(p, ip).ok, true, `${ip} should be allowed`);

test("built-in denies: loopback, metadata, link-local, unspecified, multicast, reserved", () => {
  const p = policy();
  assert.match(denied(p, "127.0.0.1"), /loopback/);
  assert.match(denied(p, "127.8.9.10"), /loopback/);
  assert.match(denied(p, "169.254.169.254"), /metadata/);
  assert.match(denied(p, "100.100.100.200"), /metadata/);
  assert.match(denied(p, "0.0.0.0"), /unspecified/);
  assert.match(denied(p, "224.0.0.5"), /multicast/);
  assert.match(denied(p, "240.1.2.3"), /reserved/);
  assert.match(denied(p, "255.255.255.255"), /broadcast/);
  assert.match(denied(p, "::1"), /loopback/);
  assert.match(denied(p, "::"), /unspecified/);
  assert.match(denied(p, "fe80::1"), /link-local/);
  assert.match(denied(p, "fd00:ec2::254"), /metadata/);
  assert.match(denied(p, "ff02::1"), /multicast/);
});

test("IPv4-mapped IPv6 can't bypass IPv4 rules", () => {
  const p = policy();
  assert.match(denied(p, "::ffff:127.0.0.1"), /loopback/);
  assert.match(denied(p, "::ffff:169.254.169.254"), /metadata/);
  assert.match(denied(p, "[::ffff:10.212.0.6]"), /this server/);
});

test("the server's own interface addresses are denied", () => {
  const p = policy();
  assert.match(denied(p, "10.212.0.6"), /this server/);
  assert.match(denied(p, "172.17.0.1"), /this server/);
});

test("default: private and public device addresses are allowed", () => {
  const p = policy();
  for (const ip of ["10.0.0.1", "10.212.0.7", "172.16.5.4", "192.168.1.1", "203.0.113.7", "2001:db8::1", "fd12:3456::1"]) allowed(p, ip);
});

test("admin deny list", () => {
  const p = policy({ deniedCidrs: ["172.18.0.0/16", "192.0.2.10"] });
  assert.match(denied(p, "172.18.0.2"), /TERMINAL_DENIED_CIDRS/);
  assert.match(denied(p, "192.0.2.10"), /TERMINAL_DENIED_CIDRS/);
  allowed(p, "192.0.2.11");
});

test("admin allow list restricts to listed ranges, and built-in denies still win", () => {
  const p = policy({ allowedCidrs: ["10.50.0.0/16", "2001:db8:100::/48"] });
  allowed(p, "10.50.3.4");
  allowed(p, "2001:db8:100::9");
  assert.match(denied(p, "10.51.0.1"), /not in TERMINAL_ALLOWED_CIDRS/);
  assert.match(denied(p, "8.8.8.8"), /not in TERMINAL_ALLOWED_CIDRS/);
  const wide = policy({ allowedCidrs: ["0.0.0.0/0"] });
  assert.match(denied(wide, "127.0.0.1"), /loopback/);
  assert.match(denied(wide, "10.212.0.6"), /this server/);
});

test("invalid CIDRs throw (fail closed at startup)", () => {
  assert.throws(() => parseCidr("10.0.0.0/33"));
  assert.throws(() => parseCidr("not-an-ip"));
  assert.throws(() => buildTargetPolicy({ allowedCidrs: ["10.0.0/8"] }));
  assert.deepEqual(parseCidr(" 192.0.2.1 "), { network: "192.0.2.1", prefix: 32, type: "ipv4" });
});

test("hostnames: every resolved address must pass; connect IP is returned", async () => {
  const p = policy();
  const dns = (map) => async (h) => {
    if (!(h in map)) throw new Error("ENOTFOUND");
    return map[h].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  const lookup = dns({
    "router1.lab": ["10.1.1.1"],
    "localhost": ["127.0.0.1", "::1"],
    "sneaky.example": ["203.0.113.5", "169.254.169.254"],
    "metadata.google.internal": ["169.254.169.254"],
  });
  assert.deepEqual(await resolveTarget(p, "router1.lab", lookup), { ok: true, ip: "10.1.1.1", family: 4 });
  assert.equal((await resolveTarget(p, "localhost", lookup)).ok, false);
  assert.equal((await resolveTarget(p, "sneaky.example", lookup)).ok, false);
  assert.equal((await resolveTarget(p, "metadata.google.internal", lookup)).ok, false);
  assert.match((await resolveTarget(p, "nope.invalid", lookup)).reason, /cannot resolve/);
  assert.match((await resolveTarget(p, "  ", lookup)).reason, /empty/);
  // IP literals skip DNS entirely
  assert.deepEqual(await resolveTarget(p, "[2001:db8::7]", lookup), { ok: true, ip: "2001:db8::7", family: 6 });
});

test("self-address detection reads the kernel's local addresses (incl. down interfaces)", async () => {
  const { parseFibTrieLocal, parseIfInet6 } = await import("../dist/services/target-policy.js");
  const fib = `Local:
  +-- 0.0.0.0/0 3 0 5
     |-- 10.212.0.6
        /32 host LOCAL
     |-- 10.212.0.255
        /32 link BROADCAST
     +-- 172.17.0.0/16 2 0 2
        |-- 172.17.0.1
           /32 host LOCAL
`;
  assert.deepEqual(parseFibTrieLocal(fib).sort(), ["10.212.0.6", "172.17.0.1"]);
  const inet6 = "fe80000000000000004242fffe1446ed 04 40 20 80  docker0\n00000000000000000000000000000001 01 80 10 80       lo\n";
  const addrs = parseIfInet6(inet6);
  assert.deepEqual(addrs, ["fe80:0000:0000:0000:0042:42ff:fe14:46ed", "0000:0000:0000:0000:0000:0000:0000:0001"]);
  // Expanded kernel form must still match the compressed form users type.
  const p = buildTargetPolicy({ selfAddresses: () => ["2001:0db8:0000:0000:0000:0000:0000:0042"] });
  assert.match(checkIp(p, "2001:db8::42").reason, /this server/);
});

test("default policy on this machine blocks its own addresses", () => {
  const p = buildTargetPolicy({});
  // 127.0.0.1 is always local; it must be denied whichever rule catches it.
  assert.equal(checkIp(p, "127.0.0.1").ok, false);
});
