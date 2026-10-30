#!/usr/bin/env python3
"""DEF-04 独立复核：跨源跳转必须剥掉凭据头，同源必须保留。

不重新实现断言 —— 只读 vitest 的 JSON 报告，按用例标题逐个核对。
这样变异掉 stripCredentialsForCrossOrigin 时这里会跟着红，而不是重复一份
写死的「看起来对」。

用法: python3 scripts/verify_def04_credential_strip.py
退出码: 0 全部命中且通过；1 有用例缺失或失败；2 报告自身读不出来。
"""
import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEST_FILE = "tests/unit/proxy-redirect-hop-guard.test.js"
REQUIRED = [
    "strips credentials when a 302 crosses to another origin",
    "keeps credentials on a same-origin 302",
    "strips credentials on a cross-origin 307 too",
    "accepts a Headers instance and still strips on cross-origin",
]


def collect_report(report_path: pathlib.Path) -> dict:
    """status -> {title: 'passed'|'failed'|...}"""
    data = json.loads(report_path.read_text(encoding="utf-8"))
    results = {}
    for suite in data.get("testResults", []):
        for case in suite.get("assertionResults", []):
            results[case["title"]] = case["status"]
    return results


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        report = pathlib.Path(tmp) / "vitest.json"
        proc = subprocess.run(
            ["npx", "vitest", "run", TEST_FILE, "--reporter=json", f"--outputFile={report}"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        if not report.exists():
            print(f"FAIL 报告未生成，vitest rc={proc.returncode}")
            print((proc.stderr or proc.stdout)[-2000:])
            return 2
        results = collect_report(report)

    missing = [t for t in REQUIRED if t not in results]
    failed = [t for t in REQUIRED if results.get(t) != "passed"]
    for title in REQUIRED:
        print(f"{results.get(title, 'MISSING'):>8}  {title}")
    print(f"命中 {len(REQUIRED) - len(missing)}/{len(REQUIRED)}，通过 {len(REQUIRED) - len(failed)}/{len(REQUIRED)}")
    if missing or failed:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
