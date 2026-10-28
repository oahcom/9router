// 出口错误 → 是否值得换出口。纯函数，无 I/O，便于单测。
//
// WHY 需要这张判据：只有「按出口 IP 判定」的两类错误换 IP 才有用。
//   429 配额 / FreeUsageLimitError —— 免费额度按 IP 计，换出口即新配额。
//   403 abusive traffic        —— IP 信誉标记，换出口即新信誉。
// 其余 403（典型是 opencode 的 FreeTierError）是**请求指纹/请求形状**被拒：
// 换出口无效，还会把一条干净的线拖进 6 小时惩罚期。
//
// 与 daemon 的 _classify_egress_error 同一套判据：那边是从 9router 的
// requestDetails 里读正文，这边是在请求路径上看上游响应的正文。

export function classifyRotateReason(status, bodyText) {
  if (status === 429) return "rate429";
  if (status !== 403) return null;
  return /abusive traffic/i.test(bodyText || "") ? "abuse403" : null;
}
