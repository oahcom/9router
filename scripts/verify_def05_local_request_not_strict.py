#!/usr/bin/env python3
"""DEF-05 证伪复核：本机请求在生产运行方式下不会误走 strictRedirects。

假设（#469607 DEF-05）：未设置 NINEROUTER_PEER_TOKEN 时 isLocalRequest 恒 false，
本机请求也带 strictRedirects，自托管 LAN 目标的同源 302 被 Blocked URL 拦掉。

本脚本只用可执行证据推翻它，不重新实现被测逻辑：
  1) 源码事实：token 在哪一层设置、包装层如何写 peer 头、isLocal 如何映射到 hop
  2) 运行时事实：真实 require 一次 custom-server.js，看 token 与 fetch 包装是否生效
  3) 线上事实：监听 :20127 的进程，其命令行链是否经过 custom-server.js

用法: python3 scripts/verify_def05_local_request_not_strict.py
退出码: 0 假设被证伪；1 假设成立或有检查项不成立；2 环境读不出来。
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PORT = 20127

failures = []


def check(name: str, ok: bool, evidence: str) -> None:
    print(f"{'OK  ' if ok else 'FAIL'} {name}\n     {evidence}")
    if not ok:
        failures.append(name)


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def line_of(text: str, needle: str) -> int:
    for i, line in enumerate(text.splitlines(), 1):
        if needle in line:
            return i
    return -1


def main() -> int:
    server = read("custom-server.js")
    guard = read("src/dashboardGuard.js")
    peer = read("src/lib/auth/trustedPeer.js")
    route = read("src/app/api/provider-nodes/validate/route.js")
    pkg = json.loads(read("package.json"))

    # 1) token 在模块顶层设置：必须在 `require.main === module` 之前，
    #    否则被 require 进来（standalone 分支）时不会执行。
    set_line = line_of(server, "process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN")
    main_line = line_of(server, "if (require.main === module)")
    check(
        "custom-server.js 在模块顶层设置 NINEROUTER_PEER_TOKEN",
        set_line > 0 and main_line > 0 and set_line < main_line,
        f"custom-server.js:{set_line} 赋值，:{main_line} 才是 require.main 分支",
    )

    # 2) 生产启动路径经过该文件。bun / standalone 两条备用路径也必须过它，
    #    否则「token 一定存在」只在 npm start 上成立。
    bypass = [
        f"{name}: {cmd}"
        for name, cmd in pkg["scripts"].items()
        if re.search(r"\b(start|serve|preview)\b", name) and "custom-server.js" not in cmd
    ]
    check(
        "package.json 里没有绕过 custom-server.js 的启动脚本",
        not bypass,
        f'start 类脚本 = {json.dumps({k: v for k, v in pkg["scripts"].items() if "start" in k}, ensure_ascii=False)}'
        + (f"；绕过项 {bypass}" if bypass else ""),
    )

    # 3) 包装层丢弃客户端自带的 peer 头再写入进程密钥（顺序不能反）
    del_line = line_of(server, 'delete req.headers["x-9r-peer-token"]')
    put_line = line_of(server, 'req.headers["x-9r-peer-token"] = PEER_TOKEN')
    check(
        "客户端伪造的 peer 头被删除后重写为进程密钥",
        del_line > 0 and put_line > 0 and del_line < put_line,
        f"custom-server.js:{del_line} delete → :{put_line} 赋 PEER_TOKEN",
    )

    # 4) isLoopbackPeer 依赖的是 hasTrustedPeerHeaders，而它比对的是同一个 env
    check(
        "hasTrustedPeerHeaders 比对 process.env.NINEROUTER_PEER_TOKEN",
        "process.env.NINEROUTER_PEER_TOKEN" in peer and "x-9r-peer-token" in peer,
        f"src/lib/auth/trustedPeer.js:{line_of(peer, 'process.env.NINEROUTER_PEER_TOKEN')}",
    )
    check(
        "isLoopbackPeer 先验 token，再看 x-9r-real-ip",
        "hasTrustedPeerHeaders(request)" in guard and 'x-9r-real-ip' in guard,
        f"src/dashboardGuard.js:{line_of(guard, 'hasTrustedPeerHeaders(request)')}",
    )

    # 5) isLocal 决定 hop：本地 = 不带 strictRedirects
    hop_line = line_of(route, "const hop = isLocal ? {} : { strictRedirects: true };")
    check(
        "validate 路由：isLocal 为真时不带 strictRedirects",
        hop_line > 0,
        f"src/app/api/provider-nodes/validate/route.js:{hop_line}",
    )

    # 6) 运行时事实：真实 require 一次，看 token 与 fetch 包装是否生效
    probe = subprocess.run(
        [
            "node",
            "-e",
            'process.argv=[process.argv[0],"custom-server.js","--port","0"];'
            'require("./custom-server.js");'
            'const t=process.env.NINEROUTER_PEER_TOKEN||"";'
            'console.log(JSON.stringify({tokenLen:t.length,'
            'patched:String(require("http").createServer).includes("wrapped")}))',
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )
    try:
        got = json.loads(probe.stdout.strip().splitlines()[-1])
    except Exception:
        print(f"FAIL 运行时探针无输出 rc={probe.returncode} stderr={probe.stderr[-500:]}")
        return 2
    check(
        "require custom-server.js 后 token 非空且 createServer 已被包装",
        got["tokenLen"] > 0 and got["patched"] is True,
        f'node -e require 结果 = {json.dumps(got)}',
    )

    # 7) 线上事实：:20127 的进程链里有 custom-server.js
    ss = subprocess.run(["ss", "-ltnp"], capture_output=True, text=True)
    m = re.search(rf":{PORT} .*pid=(\d+)", ss.stdout)
    if not m:
        print(f"FAIL 端口 {PORT} 无监听，无法核对线上运行方式")
        return 2
    pid = m.group(1)
    chain, cur = [], pid
    for _ in range(4):
        try:
            cmd = pathlib.Path(f"/proc/{cur}/cmdline").read_bytes().replace(b"\0", b" ").decode().strip()
            ppid = re.search(r"^PPid:\s+(\d+)", pathlib.Path(f"/proc/{cur}/status").read_text(), re.M)
        except OSError:
            break
        chain.append(cmd)
        if not ppid or ppid.group(1) == "0":
            break
        cur = ppid.group(1)
    check(
        f"线上 pid {pid} 的命令行链经过 custom-server.js",
        any("custom-server.js" in c for c in chain),
        " ← ".join(chain),
    )

    # 8) 反证：token 不是从 shell 继承来的。/proc/<pid>/environ 是 exec 时的初始环境，
    #    若这里能看到该变量，说明有外部注入，第 3/4 项就推不出「客户端不可伪造」。
    environ = pathlib.Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    inherited = [e.decode(errors="replace") for e in environ if e.startswith(b"NINEROUTER_PEER_TOKEN=")]
    check(
        "token 不是进程启动时从外部环境继承的",
        not inherited,
        f"/proc/{pid}/environ 中该变量出现 {len(inherited)} 次（0 = 由 JS 运行时生成）",
    )

    # 9) 端到端：真的走一次包装层，看伪造头会不会被换掉
    e2e = subprocess.run(
        [
            "node",
            "-e",
            'process.argv=[process.argv[0],"x","--port","0"];'
            'require("./custom-server.js");'
            'const http=require("http");let seen=null;'
            'const srv=http.createServer((req,res)=>{seen=req.headers;res.end("ok")});'
            'srv.listen(0,"127.0.0.1",()=>{'
            'const port=srv.address().port;'
            'const r=http.request({host:"127.0.0.1",port,path:"/",headers:{'
            '"x-9r-peer-token":"forged","x-9r-real-ip":"8.8.8.8"}},res=>{'
            'res.resume();res.on("end",()=>{'
            'console.log(JSON.stringify({realIp:seen["x-9r-real-ip"],'
            'token:seen["x-9r-peer-token"],viaProxy:seen["x-9r-via-proxy"]||null}));'
            'srv.close();process.exit(0)})});r.end()})',
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=90,
    )
    try:
        got_e2e = json.loads(e2e.stdout.strip().splitlines()[-1])
    except Exception:
        print(f"FAIL 端到端探针无输出 rc={e2e.returncode} stderr={e2e.stderr[-500:]}")
        return 2
    check(
        "端到端：伪造的 x-9r-real-ip / x-9r-peer-token 被包装层替换",
        got_e2e["realIp"] == "127.0.0.1"
        and got_e2e["token"] != "forged"
        and len(got_e2e["token"] or "") == 48
        and got_e2e["viaProxy"] is None,
        f"发送 forged/8.8.8.8 → handler 收到 {json.dumps(got_e2e)}",
    )

    print()
    if failures:
        print(f"DEF-05 判定: 未能证伪（{len(failures)} 项不成立: {', '.join(failures)}）")
        return 1
    print("DEF-05 判定: 不成立 —— 生产启动必经 custom-server.js，token 在模块顶层生成并写入 env，"
          "包装层用进程密钥覆盖客户端同名头，故本机请求 isLocalRequest 为真、不带 strictRedirects")
    return 0


if __name__ == "__main__":
    sys.exit(main())
