// 出口闸只有一个定义，两个真正发请求的路口都得过。
//
// 2026-10-28 复核发现：闸原来只装在 proxyFetch.proxyAwareFetch 里，而
// OpenCodeExecutor.fetchUpstream 在 OPENCODE_TRANSPORT=auto 下先问 Bun
// sidecar（fetchViaTransport），proxyAwareFetch 根本不会被调用 —— panel 把
// baseUrl 指到 169.254.169.254 时那条闸形同虚设。
//
// 这里钉的是行为，不是源码文本：两条路径各自真的调用一次，看是否都拒。
import { describe, expect, it } from "vitest";

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { fetchViaTransport } from "../../open-sse/utils/opencodeTransport.js";
import { assertEgressTargetAllowed } from "../../open-sse/utils/proxyResolution.js";

const METADATA = "http://169.254.169.254/latest/meta-data/iam/security-credentials/";
const PUBLIC_LOOKUP = async () => [{ address: "104.18.0.1", family: 4 }];

describe("出口闸：undici 与 sidecar 同一判据", () => {
  it("undici 路径拒绝字面量元数据地址", async () => {
    await expect(proxyAwareFetch(METADATA)).rejects.toThrow(/link-local\/metadata/);
  });

  it("sidecar 路径也拒绝 —— 闸不能只装在一个路口", async () => {
    await expect(
      fetchViaTransport(METADATA, { method: "POST", headers: {}, body: "{}" }, null),
    ).rejects.toThrow(/link-local\/metadata/);
  });

  it("IPv6 元数据地址被拒", async () => {
    await expect(assertEgressTargetAllowed("http://[fd00:ec2::254]/latest/meta-data/"))
      .rejects.toThrow(/link-local\/metadata/);
  });

  it("字面量干净、解析后才落进元数据段的域名被拒", async () => {
    const lookup = async () => [{ address: "169.254.169.254", family: 4 }];
    await expect(
      assertEgressTargetAllowed("http://metadata.example.test/latest/", lookup),
    ).rejects.toThrow(/resolving to link-local/);
  });

  it("公网地址放行", async () => {
    await expect(
      assertEgressTargetAllowed("https://opencode.ai/inference/v1/chat/completions", PUBLIC_LOOKUP),
    ).resolves.toBeUndefined();
  });
});
