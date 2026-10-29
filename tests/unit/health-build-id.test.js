import { describe, it, expect, vi, beforeEach } from "vitest";

// health 端点把「磁盘上的构建标识」暴露出来，是「构建了但没重启」可被发现的前提：
// 外部只需比对 /api/health 的 buildId 与 .next/BUILD_ID，不需要读进程启动时刻
// （本机 btime 漂移，同一 pid 三次读数 10:04 / 11:07 / 12:04，判据不可用）。

const { readBuildIdMock } = vi.hoisted(() => ({ readBuildIdMock: vi.fn() }));
vi.mock("@/lib/buildInfo", () => ({ readBuildId: readBuildIdMock }));

// route 里的缓存是 module 级变量，每个用例要拿到干净模块，否则「只读一次」会被
// 上一个用例的缓存掩盖成「这次也没读」。
async function loadRoute() {
  vi.resetModules();
  return import("../../src/app/api/health/route.js");
}

beforeEach(() => {
  readBuildIdMock.mockReset();
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

  it("reads BUILD_ID once across repeated requests (module-level cache)", async () => {
    readBuildIdMock.mockReturnValue("BUILD-abc123");
    const { GET } = await loadRoute();
    await GET();
    await GET();
    expect(readBuildIdMock).toHaveBeenCalledTimes(1);
  });
});
