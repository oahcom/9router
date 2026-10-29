import fs from "node:fs";
import path from "node:path";

// 读盘上的构建标识。不缓存：缓存属于 route 层，这里每次调用都真读，
// 否则调用方的单测无法区分「读了」和「缓存了」。
// 任何异常（ENOENT / EACCES / 目录不是目录）返回 null 而不是 throw，
// 因为调用方要把 null 映射成 503；让异常冒泡会变成 500。
export function readBuildId(distDir = ".next") {
  try {
    return fs.readFileSync(path.join(distDir, "BUILD_ID"), "utf8").trim();
  } catch {
    return null;
  }
}
