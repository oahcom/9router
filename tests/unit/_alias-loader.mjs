// 让 node 直跑 open-sse 源码：复刻 tests/vitest.config.js 的 "@/" → src/ 别名。
const ROOT = new URL("../../", import.meta.url);
export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    return next(new URL("src/" + specifier.slice(2), ROOT).href, context);
  }
  return next(specifier, context);
}
