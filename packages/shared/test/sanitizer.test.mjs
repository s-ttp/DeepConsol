// Sanitizer regression tests. Run with: npm test -w @deepconsol/shared
// (builds src → dist first, then runs node:test against the built module —
// the same code the API, worker and browser use).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitize, BUILTIN_RULES } from "../dist/sanitizer.js";

const s = (input, overlay) => sanitize(input, {}, overlay).sanitized;

// ── Built-in rules: one before/after case per rule (mirrors the README table) ──
const CASES = {
  "ssh-private-key-block": ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----", "[REDACTED:PRIVATE_KEY]"],
  "pgp-private-key-block": ["-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----", "[REDACTED:PRIVATE_KEY]"],
  "putty-private-key": ["PuTTY-User-Key-File-3: ssh-ed25519\nPrivate-Lines: 1\nAAAA\nPrivate-MAC: abc123", "[REDACTED:PRIVATE_KEY]"],
  "openssh-pubkey-with-comment": ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMq noc@jump01", "[REDACTED:SSH_KEY]"],
  "authorization-header": ['Authorization: Digest username="ops"', "Authorization: [REDACTED]"],
  "cookie-header": ["Cookie: session=abc123", "Cookie: [REDACTED]"],
  "bearer-token": ["curl -H 'X: Bearer abcdef1234567890xyz'", "curl -H 'X: Bearer [REDACTED]'"],
  "basic-auth": ["X: Basic dXNlcjpwYXNzd29yZA==", "X: Basic [REDACTED]"],
  "jwt": ["token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlX3h5eg", "token [REDACTED:JWT]"],
  "connection-string-creds": ["mongodb://admin:S3cret@db.example.com:27017", "mongodb://[REDACTED]@HOST_001:27017"],
  "aws-access-key": ["AKIAIOSFODNN7EXAMPLE", "[REDACTED:AWS_ACCESS_KEY]"],
  "google-api-key": ["AIzaSyA1234567890abcdefghijklmnopqrstuv", "[REDACTED:API_KEY]"],
  "cloud-provider-token": ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "[REDACTED:TOKEN]"],
  "generic-api-key-kv": ["api_key=9f8e7d6c5b4a3f2e1d0c", "api_key: [REDACTED]"],
  "generic-token-kv": ["access_token=9f8e7d6c5b4a3f2e1d0c", "access_token: [REDACTED]"],
  "password-kv": ["password: Winter2026!", "password: [REDACTED]"],
  "cisco-type7-password": ["username ops password 7 0822455D0A16", "username ops password 7 [REDACTED]"],
  "cisco-enable-secret": ["enable secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0", "enable secret [REDACTED]"],
  "unix-password-hash": ["root:$6$rounds=5000$saltsalt$abcdefghijk:19000", "root:[REDACTED:HASH]:19000"],
  "sim-auth-key": ["Ki=465B5CE8B199B49FAA5F0A2EE238A6BC", "Ki: [REDACTED]"],
  "snmp-community": ["snmp-server community Publ1cR0 RO", "snmp-server community [REDACTED] RO"],
  "credit-card": ["card 4111-1111-1111-1111", "card [REDACTED:CARD]"],
  "email": ["contact noc.lead@operator.com", "contact [REDACTED:EMAIL]"],
  "phone-e164": ["call +966501234567", "call [REDACTED:PHONE]"],
  "iccid": ["iccid: 8996601234567890123", "iccid: ICCID_001"],
  "imei": ["IMEI: 356938035643809", "IMEI: IMEI_001"],
  "imsi": ["IMSI 420011234567890 attached", "IMSI IMSI_001 attached"],
  "msisdn": ["msisdn=966501234567 call drop", "msisdn=MSISDN_001 call drop"],
  "subscriber-id": ["5G-GUTI: 42001-0a1b-2c3d4e5f", "5G-GUTI: SUBID_001"],
  "network-id": ["PLMN: 42001 TAC: 0x1A2B APN=internet.operator", "PLMN: NETID_001 TAC: NETID_002 APN=NETID_003"],
  "ipv4": ["peer 203.0.113.7 via 10.20.0.1", "peer IP_001 via 10.20.0.1"],
  "ipv6": ["neighbor 2001:db8:85a3::8a2e:370:7334 up", "neighbor IP6_001 up"],
  "mac": ["mac 00:1a:2b:3c:4d:5e", "mac MAC_001"],
  "cellid": ["cell-id: 1A2B3C", "cell-id: CELL_001"],
  "hostname": ["core-sw01.dc1.operator.com and mme01.corp", "HOST_001 and HOST_002"],
};

test("every built-in rule has a test case", () => {
  assert.equal(BUILTIN_RULES.length, 35);
  for (const r of BUILTIN_RULES) assert.ok(CASES[r.name], `missing test case for ${r.name}`);
});

for (const [name, [input, expected]] of Object.entries(CASES)) {
  test(`built-in rule: ${name}`, () => assert.equal(s(input), expected));
}

// ── IPv6 ──
test("ipv6: full, compressed and prefix forms are pseudonymized", () => {
  assert.equal(s("addr 2001:0db8:85a3:0000:0000:8a2e:0370:7334"), "addr IP6_001");
  assert.equal(s("route 2001:db8:abcd::/48 via 2001:db8::1"), "route IP6_001/48 via IP6_002");
  assert.equal(s("peer 2a00:1450:4001::200e, again 2A00:1450:4001::200E."), "peer IP6_001, again IP6_001.");
});

test("ipv6: loopback, link-local and unique-local are kept (like private IPv4)", () => {
  assert.equal(s("::1 fe80::1ff:fe23:4567:890a fd12:3456:789a::1"), "::1 fe80::1ff:fe23:4567:890a fd12:3456:789a::1");
});

test("ipv6: does not touch times, C++ scopes, MACs or IPv4", () => {
  assert.equal(s("at 09:39:37 std::vector"), "at 09:39:37 std::vector");
  assert.equal(s("10.1.1.1:22"), "10.1.1.1:22");
  assert.doesNotMatch(s("00:1a:2b:3c:4d:5e"), /IP6_/);
});

// ── MAC ──
test("mac: colon, hyphen and Cisco dotted formats", () => {
  assert.equal(s("a 00:1a:2b:3c:4d:5e b 00-1A-2B-3C-4D-5F c 001a.2b3c.4d60"), "a MAC_001 b MAC_002 c MAC_003");
  assert.equal(s("same 00:1a:2b:3c:4d:5e and 00:1a:2b:3c:4d:5e"), "same MAC_001 and MAC_001");
});

// ── Alias semantics documented in the README ──
test("aliases are consistent within a message and numbered per value", () => {
  assert.equal(
    s("IMSI 420011234567890 then IMSI 420011234567890 and 420019999999999"),
    "IMSI IMSI_001 then IMSI IMSI_001 and IMSI_002"
  );
});

test("private and loopback IPv4 ranges are preserved", () => {
  assert.equal(s("10.0.0.1 172.16.5.4 192.168.1.1 127.0.0.1 8.8.8.8"), "10.0.0.1 172.16.5.4 192.168.1.1 127.0.0.1 IP_001");
});

test("no overlay (overlay failed to load) runs the full baseline", () => {
  assert.equal(s("password: x1 peer 8.8.8.8", undefined), "password: [REDACTED] peer IP_001");
});

// ── Admin overlay ──
const rule = (o) => ({ id: o.id ?? o.value, label: o.label ?? "Custom", match_type: "wildcard", action: "redact", alias_prefix: null, case_insensitive: true, enabled: true, ...o });

test("overlay: disabled built-in is skipped", () => {
  assert.equal(s("host core-sw01.dc1.operator.com", { disabledBuiltins: ["hostname"] }), "host core-sw01.dc1.operator.com");
});

test("overlay: README custom-rule examples", () => {
  const overlay = {
    disabledBuiltins: ["msisdn"],
    customRules: [
      rule({ label: "KSA MSISDN", value: "9665????????", action: "pseudonymize", alias_prefix: "SUB" }),
      rule({ label: "Customer", match_type: "literal", value: "Acme Telecom" }),
      rule({ label: "Site", value: "RYD-SITE-*", action: "pseudonymize", alias_prefix: "SITE" }),
    ],
  };
  assert.equal(
    s("acme telecom reports drop for 966501234567 at RYD-SITE-0042 and RYD-SITE-0042", overlay),
    "[REDACTED:CUSTOMER] reports drop for SUB_001 at SITE_001 and SITE_001"
  );
  const ip = { customRules: [rule({ value: "10.20.*", action: "pseudonymize", alias_prefix: "MGMT_IP" })] };
  assert.equal(s("ping 10.20.0.1 and 10.20.3.9 and 10.20.0.1", ip), "ping MGMT_IP_001 and MGMT_IP_002 and MGMT_IP_001");
  const keys = { customRules: [rule({ label: "Device key", value: "tacacs-server key * *" }), rule({ label: "Device key", value: "radius-server key *", id: "r" })] };
  assert.equal(s("tacacs-server key 7 0822455D0A16", keys), "[REDACTED:DEVICE_KEY]");
  assert.equal(s("radius-server key MyRadiusKey123", keys), "[REDACTED:DEVICE_KEY]");
});

test("overlay: disabled custom rule is ignored; regex metacharacters are literal", () => {
  assert.equal(s("acme", { customRules: [rule({ match_type: "literal", value: "acme", enabled: false })] }), "acme");
  assert.equal(s("a.b and axb", { customRules: [rule({ match_type: "literal", value: "a.b" })] }), "[REDACTED:CUSTOM] and axb");
});
