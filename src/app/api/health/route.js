import { NextResponse } from "next/server";
import { readBuildId } from "@/lib/buildInfo";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// 读启动时刻钉住的构建标识，不是「第一次请求」时的盘上值。
// instrumentation.js 的 register() 在进程启动时求值（实测 0 请求即执行），
// 那里把 BUILD_ID 写进 globalThis；路由模块顶层要等首个请求才跑
// （实测 next start / standalone 空闲 16s 仍 0 次求值），放这里读就是原缺陷。
// 未经过 instrumentation（单测、精简部署）时在这里读一次盘并钉住 —— 那是降级；
// 启动时就读不到（null）同样钉住，回落到盘上值会把启动后新建的产物伪装成运行态。
function bootBuildId() {
  if (globalThis.__NINEROUTER_BOOT_BUILD_ID__ === undefined) {
    globalThis.__NINEROUTER_BOOT_BUILD_ID__ = readBuildId(process.env.NEXT_DIST_DIR || ".next");
  }
  return globalThis.__NINEROUTER_BOOT_BUILD_ID__;
}

export async function GET() {
  const buildId = bootBuildId();

  // 读不到构建标识 = 部署态不可判定，返回 503 而不是假装健康：
  // 探针只读 res.ok，200 会让它把「不知道」当成「好的」。
  if (!buildId) {
    return NextResponse.json(
      { ok: false, error: "BUILD_ID unreadable" },
      { status: 503, headers: CORS_HEADERS },
    );
  }

  // ok:true 必须保留 —— src/ 下 5 处调用点只读 res.ok / ping.type === "opaque"。
  return NextResponse.json({ ok: true, buildId }, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
