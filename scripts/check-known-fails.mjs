// 把「已知会红的用例」变成能自动核对的东西。
//
// tests/__baseline__/known-fails.txt 从 2026-10-21 就存在，但没有任何东西去
// 核它 —— 于是两头都会腐烂：修好的条目一直留着（这次就有 5 条），新红的没人
// 发现（security-audit 的 AUDIT-002 是 GHSA-vjc7，它红着，基线里却写着
// 「Fixed by decolua/9router#4286」）。
//
// 用法：npm run test:baseline
//   - 有基线之外的新红 → 退出码 1（这条才是门禁）
//   - 基线里已经转绿的 → 只提示，不拦
import { readFileSync } from "node:fs";

const REPORT = process.argv[2] || ".vitest-report.json";
const BASELINE = "tests/__baseline__/known-fails.txt";

function readBaseline() {
  const out = new Set();
  for (const raw of readFileSync(BASELINE, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    out.add(line);
  }
  return out;
}

function readFailures() {
  const report = JSON.parse(readFileSync(REPORT, "utf8"));
  // 存「条目 -> 失败文本」：ABI 这类环境问题只体现在 message 里，
  // 光看标题永远匹配不到（审查发现 exit 2 分支其实不可达）。
  const out = new Map();
  for (const file of report.testResults || []) {
    const rel = file.name.replace(/\\/g, "/").replace(/^.*?(tests\/)/, "$1");
    const suiteText = file.message || "";
    const assertions = file.assertionResults || [];
    if (file.status === "failed" && !assertions.length) {
      out.set(rel + " :: <suite failed to load>", suiteText);
      continue;
    }
    for (const a of assertions) {
      if (a.status !== "failed") continue;
      const name = [...(a.ancestorTitles || []), a.title].join(" ");
      const text = [suiteText, a.message || "", ...(a.failureMessages || [])].join("\n");
      out.set(rel + " :: " + name, text);
    }
  }
  return out;
}

const baseline = readBaseline();
const failures = readFailures();
console.log("node " + process.version + " (abi " + process.versions.modules + ")");

const unexpected = [...failures.keys()].filter((f) => !baseline.has(f)).sort();
const fixed = [...baseline].filter((f) => !failures.has(f)).sort();

if (fixed.length) {
  console.log("基线里已转绿（可以从 known-fails.txt 删掉）：" + fixed.length);
  for (const f of fixed) console.log("  - " + f);
}

// ABI 不符（better_sqlite3 这类原生模块）不是回归：用默认 node 跑就会冒出来。
// 判据看失败文本，不看标题；而且必须先把真实新失败报完，再决定要不要 exit 2 ——
// 不然一次运行里的真回归会被环境问题吞掉（审查发现）。
const isAbi = (f) => /NODE_MODULE_VERSION/.test(failures.get(f) || "");
const abiMismatch = unexpected.filter(isAbi);
const realUnexpected = unexpected.filter((f) => !isAbi(f));

if (realUnexpected.length) {
  console.error("基线之外的新失败：" + realUnexpected.length);
  for (const f of realUnexpected) console.error("  + " + f);
  if (abiMismatch.length) {
    console.error("（另有 " + abiMismatch.length + " 条是 Node ABI 不符，先修上面这些）");
  }
  process.exit(1);
}

if (abiMismatch.length) {
  console.error("环境不符：" + abiMismatch.length + " 条是 Node ABI 不对（本机 " + process.version +
    "，abi " + process.versions.modules + "）。");
  console.error("  用 PATH=/opt/node-v22.23.4/bin:$PATH 重跑，或 npm rebuild 原生模块。");
  for (const f of abiMismatch) console.error("  ! " + f);
  process.exit(2);
}

console.log("没有基线之外的新失败（当前失败 " + failures.size + " 条，基线 " + baseline.size + " 条）");
