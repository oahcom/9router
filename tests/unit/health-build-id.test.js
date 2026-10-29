import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// health 端点把「进程启动时的构建标识」暴露出来，是「构建了但没重启」可被发现的前提：
// 外部只需比对 /api/health 的 buildId 与 .next/BUILD_ID，不需要读进程启动时刻
// （本机 btime 漂移，同一 pid 三次读数 10:04 / 11:07 / 12:04，判据不可用）。
//
// 启动值由 instrumentation.js 的 register() 写进 globalThis：路由模块顶层要等首个
// 请求才求值（实测 next start / standalone 空闲 16s 仍 0 次求值），在那里读盘得到的
// 是「首请求时刻」的盘上值 —— 进程跑旧构建、磁盘已换新构建时会报假 MATCH。

const { readBuildIdMock } = vi.hoisted(() => ({ readBuildIdMock: vi.fn() }));
vi.mock("@/lib/buildInfo", () => ({ readBuildId: readBuildIdMock }));

const BOOT_KEY = "__NINEROUTER_BOOT_BUILD_ID__";

// route 的取值钉在 globalThis 上，每个用例要拿到干净模块，否则上一个用例的
// 值会被当成这次也读了。
async function loadRoute() {
  vi.resetModules();
  return import("../../src/app/api/health/route.js");
}

beforeEach(() => {
  readBuildIdMock.mockReset();
  delete globalThis[BOOT_KEY];
});

afterEach(() => {
  delete globalThis[BOOT_KEY];
});

describe("GET /api/health", () => {
  it("returns the on-disk buildId and keeps ok:true for existing callers", async () => {
    readBuildIdMock.mockReturnValue("BUILD-abc123");
    const { GET } = await loadRoute();
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.buildId).toBe("BUILD-abc123");
    expect(body.ok).toBe(true);
  });

  it("returns 503 instead of a healthy-looking body when BUILD_ID is unreadable", async () => {
    readBuildIdMock.mockReturnValue(null);
    const { GET } = await loadRoute();
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.ok).not.toBe(true);
  });

  it("reports the build id captured at process start, not the one now on disk", async () => {
    // 进程跑 BUILD-OLD，期间磁盘换成了 BUILD-NEW。读盘就会报 NEW → 判据假 MATCH。
    globalThis[BOOT_KEY] = "BUILD-OLD";
    readBuildIdMock.mockReturnValue("BUILD-NEW");
    const { GET } = await loadRoute();
    const body = await (await GET()).json();
    expect(body.buildId).toBe("BUILD-OLD");
    expect(readBuildIdMock).not.toHaveBeenCalled();
  });

  it("does not re-read the disk across repeated requests", async () => {
    readBuildIdMock.mockReturnValue("BUILD-abc123");
    const { GET } = await loadRoute();
    await GET();
    await GET();
    expect(readBuildIdMock).toHaveBeenCalledTimes(1);
  });

  it("stays 503 when the boot-time read failed, even if BUILD_ID appears later", async () => {
    // 启动时读不到 = 部署态不可判定。回落到盘上值会把「启动后新建的产物」伪装成运行态。
    globalThis[BOOT_KEY] = null;
    readBuildIdMock.mockReturnValue("BUILD-NEW");
    const { GET } = await loadRoute();
    const res = await GET();
    expect(res.status).toBe(503);
    expect(readBuildIdMock).not.toHaveBeenCalled();
  });
});
