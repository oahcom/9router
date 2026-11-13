import { describe, it, expect, beforeEach } from "vitest";

// asip 关掉：这个用例只验「端口 → 出口身份」这张表本身，不该去连 UDS。
process.env.ASIP_DISABLED = "1";

import {
  notePortLine,
  egressForPort,
  asipEgressForPort,
  currentAsipEgress,
  noteActiveLine,
} from "../../open-sse/utils/asipRotate.js";

describe("每端口出口身份", () => {
  it("并发下按端口各存一份，不会被另一台闸覆写", () => {
    notePortLine("http://127.0.0.1:7896", "WARP-H2-HKG-10", "2a09:bac5:495e:263c::3cf:6c", 1700);
    notePortLine("http://127.0.0.1:7893", "WARP-H2-ORD-11", "2a09:bac5:a5ff:25a5::3c0:27", 1800);

    // 7896 的请求报障时带回去的必须是它自己的地址。旧实现（currentAsipEgress）
    // 返回的是「进程最近一次看到的」，也就是 7893 的 —— 实测 52% 的报障地址
    // 与本槽出口不在同一个 /64 就是这么来的。
    expect(egressForPort("http://127.0.0.1:7896")).toEqual({
      egress: "2a09:bac5:495e:263c::3cf:6c",
      since: 1700,
    });
    expect(egressForPort("http://127.0.0.1:7893").egress).toBe("2a09:bac5:a5ff:25a5::3c0:27");
    // 全局值只反映「最后一次 rotate 看到谁」，与端口无关 —— 正是不能拿它当
    // failedEgress 的原因：谁最后换过线，它就说谁。
    noteActiveLine("WARP-H2-ORD-11", "2a09:bac5:a5ff:25a5::3c0:27");
    expect(currentAsipEgress()).toBe("2a09:bac5:a5ff:25a5::3c0:27");
    noteActiveLine("WARP-H2-HKG-10", "2a09:bac5:495e:263c::3cf:6c");
    expect(currentAsipEgress()).toBe("2a09:bac5:495e:263c::3cf:6c");
    // 7893 自己那份不受影响。
    expect(egressForPort("http://127.0.0.1:7893").egress).toBe("2a09:bac5:a5ff:25a5::3c0:27");
  });

  it("端口没记录时返回空，不拿别的端口的地址顶替", () => {
    expect(egressForPort("http://127.0.0.1:7894")).toEqual({ egress: null, since: null });
    expect(egressForPort(null)).toEqual({ egress: null, since: null });
    expect(egressForPort("socks5://example.com:1080")).toEqual({ egress: null, since: null });
  });

  it("地址未知时把 since 归零，不沿用上一个地址的接入时刻", () => {
    notePortLine("http://127.0.0.1:7895", "WARP-CF-G", null, 1234);
    expect(egressForPort("http://127.0.0.1:7895")).toEqual({ egress: null, since: 1234 });
  });

  it("asip 不可达时 asipEgressForPort 返回未知而不是抛错", async () => {
    await expect(asipEgressForPort("http://127.0.0.1:7892")).resolves.toEqual({
      egress: null,
      tag: null,
      since: null,
    });
  });

  it("第七闸口没有 IP 时返回池节点 tag 作为出口身份", async () => {
    notePortLine("http://127.0.0.1:7897", "upoz.example:28065-any", null, 4321);
    await expect(asipEgressForPort("http://127.0.0.1:7897")).resolves.toEqual({
      egress: null,
      tag: "upoz.example:28065-any",
      since: 4321,
    });
  });
});
