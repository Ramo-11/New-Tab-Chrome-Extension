import { expect, test } from "bun:test";
import { isBlocked, normalizeBlockList } from "@homepage/agent-core";

test("normalizes pasted hosts and URLs", () => {
  expect(normalizeBlockList([" HTTPS://WWW.Google.COM/path ", "", " # comment", "*.Example.COM", "google.com"])).toEqual(["google.com", "*.example.com"]);
});

test("matches hosts and subdomains without matching lookalikes", () => {
  for (const host of ["google.com", "mail.google.com", "https://WWW.GOOGLE.COM./path"]) {
    expect(isBlocked(host, ["google.com"])).toBe(true);
  }
  expect(isBlocked("deep.sub.example.com", ["*.example.com"])).toBe(true);
  expect(isBlocked("example.com", ["*.example.com"])).toBe(true);
  for (const url of ["https:/mail.google.com", "https:\\mail.google.com", "HTTPS://user:pw@Mail.Google.com:443/x"]) {
    expect(isBlocked(url, ["google.com"])).toBe(true);
  }
  expect(isBlocked("localhost:3000", ["localhost"])).toBe(true);
  expect(isBlocked("notgoogle.com", ["google.com"])).toBe(false);
  expect(isBlocked("google.com.evil.test", ["google.com"])).toBe(false);
});

test("always blocks loopback, private and local-network hosts", () => {
  for (const url of [
    "http://localhost:5173", "http://127.0.0.2/", "http://0.0.0.0:8080", "http://2130706433/",
    "http://[::1]:3000/", "http://[::ffff:127.0.0.1]/", "http://[fd12::1]/", "http://[fe80::1]/",
    "http://10.0.0.5/", "http://172.20.1.1/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data",
    "http://100.100.1.1/", "http://router/", "http://printer.local/", "https://wiki.corp.internal/",
    "http://nas.lan/", "http://box.home.arpa/",
  ]) {
    expect(isBlocked(url, [])).toBe(true);
  }
  for (const url of ["https://8.8.8.8/", "https://172.32.0.1/", "https://192.169.0.1/", "https://news.ycombinator.com/", "https://[2606:4700::1111]/"]) {
    expect(isBlocked(url, [])).toBe(false);
  }
});
