import { NextResponse } from "next/server";
import { readBuildId } from "@/lib/buildInfo";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// 只读一次盘：health 会被探针高频打到，每次读 BUILD_ID 都是多余的 syscall。
// undefined = 还没读过；null = 读过但读不到（照样不再重试，进程重启才会重新读）。
let cachedBuildId;

export async function GET() {
  if (cachedBuildId === undefined) cachedBuildId = readBuildId(process.env.NEXT_DIST_DIR || ".next");

  // 读不到构建标识 = 部署态不可判定，返回 503 而不是假装健康：
  // 探针只读 res.ok，200 会让它把「不知道」当成「好的」。
  if (!cachedBuildId) {
    return NextResponse.json(
      { ok: false, error: "BUILD_ID unreadable" },
      { status: 503, headers: CORS_HEADERS },
    );
  }

  // ok:true 必须保留 —— src/ 下 5 处调用点只读 res.ok / ping.type === "opaque"。
  return NextResponse.json({ ok: true, buildId: cachedBuildId }, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
