import { describe, it, expect, vi } from "vitest";

// 云厂商公布的元数据端点里，有三个落在「公网可路由」的段里，无法靠普通私有段
// 判据覆盖：Aliyun 100.100.100.200（在 CGNAT 段内但同段还有 tailnet 对等体）、
// Azure 168.63.129.16、Oracle 192.0.0.192。闸门此前对后两者判公网。
// 判据是「是否被拒绝」，所以这里断言 toThrow，不锁具体错误文案。

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns", () => ({
  default: { promises: { lookup: lookupMock } },
  promises: { lookup: lookupMock },
}));

const { assertPublicUrl, assertPublicUrlResolved, listBlockedRanges } =
  await import("../../src/shared/utils/ssrfGuard.js");

describe("assertPublicUrl: cloud metadata endpoints outside RFC1918", () => {
  it.each([
    ["168.63.129.16", "Azure WireServer / IMDS"],
    ["192.0.0.192", "Oracle Cloud IMDS"],
    ["100.100.100.200", "Aliyun metadata"],
    ["169.254.169.254", "AWS / GCP metadata"],
  ])("blocks %s (%s)", (ip) => {
    expect(() => assertPublicUrl(`http://${ip}/`)).toThrow();
  });

  it("blocks the IPv6 form of the AWS endpoint", () => {
    expect(() => assertPublicUrl("http://[fd00:ec2::254]/latest/meta-data/")).toThrow();
  });

  it("blocks the IPv4-mapped IPv6 form of each (the /32s must survive the prefix rewrite)", () => {
    expect(() => assertPublicUrl("http://[::ffff:168.63.129.16]/")).toThrow();
    expect(() => assertPublicUrl("http://[::ffff:192.0.0.192]/")).toThrow();
  });

  it.each([
    ["168.63.129.16.nip.io", "168.63.129.16"],
    ["192.0.0.192.nip.io", "192.0.0.192"],
  ])("blocks %s, which only becomes an IP after resolution", async (name, address) => {
    lookupMock.mockResolvedValue([{ address, family: 4 }]);
    await expect(assertPublicUrlResolved(`http://${name}/`)).rejects.toThrow();
  });

  it("still allows a public host (positive control for the same code path)", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(assertPublicUrlResolved("https://example.com/")).resolves.toBeUndefined();
  });
});

describe("listBlockedRanges: the deny set is enumerable", () => {
  it("exposes each blocked range with a reason", () => {
    const ranges = listBlockedRanges();
    expect(ranges.length).toBeGreaterThanOrEqual(9);
    for (const r of ranges) {
      expect(r.cidr).toMatch(/^\d+\.\d+\.\d+\.\d+\/\d+$/);
      expect(typeof r.reason).toBe("string");
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it("lists the four cloud metadata addresses the gate refuses", () => {
    const joined = JSON.stringify(listBlockedRanges());
    for (const addr of ["168.63.129.16", "192.0.0.192", "100.100.100.200", "169.254.169.254"]) {
      expect(joined).toContain(addr);
    }
  });
});
