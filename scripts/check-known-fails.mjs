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
  const out = new Set();
  for (const file of report.testResults || []) {
    const rel = file.name.replace(/\\/g, "/").replace(/^.*?(tests\/)/, "$1");
    if (file.status === "failed" && !(file.assertionResults || []).length) {
      out.add(`${rel} :: <suite failed to load>`);
      continue;
    }
    for (const a of file.assertionResults || []) {
      if (a.status !== "failed") continue;
      const name = [...(a.ancestorTitles || []), a.title].join(" ");
      out.add(`${rel} :: ${name}`);
    }
  }
  return out;
}

const baseline = readBaseline();
const failures = readFailures();
const unexpected = [...failures].filter((f) => !baseline.has(f)).sort();
console.log("node " + process.version + " (abi " + process.versions.modules + ")");
const fixed = [...baseline].filter((f) => !failures.has(f)).sort();

if (fixed.length) {
  console.log(`基线里已转绿（可以从 known-fails.txt 删掉）：${fixed.length}`);
  for (const f of fixed) console.log("  - " + f);
}

// ABI 不符（better_sqlite3 这类原生模块）不是回归：用默认 node 跑就会冒出来。
// 单独说清楚，别混进「基线之外的新失败」里让人以为代码坏了。
const abiMismatch = unexpected.filter((f) => /NODE_MODULE_VERSION/.test(f));
const realUnexpected = unexpected.filter((f) => !abiMismatch.includes(f));

if (abiMismatch.length) {
  console.error(
    "环境不符：" + abiMismatch.length + " 条是 Node ABI 不对（本机 " +
    process.version + "，abi " + process.versions.modules + "）。"
  );
  console.error("  用 PATH=/opt/node-v22.23.4/bin:$PATH 重跑，或 npm rebuild 原生模块。");
  for (const f of abiMismatch) console.error("  ! " + f);
  process.exit(2);
}

if (unexpected.length) {
  console.error(`基线之外的新失败：${unexpected.length}`);
  for (const f of unexpected) console.error("  + " + f);
  process.exit(1);
}

console.log(`没有基线之外的新失败（当前失败 ${failures.size} 条，基线 ${baseline.size} 条）`);
