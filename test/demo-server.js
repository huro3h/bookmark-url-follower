// 手で挙動を見るためのデモサーバ。`npm run demo` で起動し、http://localhost:18790/ を開く。
// 一覧のリンクをブックマークバーへドラッグして監視すると、開くたびに転送されてブックマークが書き換わる。
//
// 「開くたびに転送する」ために、転送先の URL にはトークンを入れる。発行したトークンは最初の1回だけページを返し、
// 2回目以降(= 書き換わったブックマークから開いた)はまた新しいトークンへ転送する。
// 知らないトークン(サーバを再起動した後など)も転送する。
// ドメインの変化は v1.localhost, v2.localhost … を使う(Chrome は *.localhost を自分の PC に向ける)。
const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT ?? 18790);
const issued = new Set(); // 発行したが、まだページを返していないトークン
let hostCounter = 0;

const token = () => {
  const t = crypto.randomUUID().slice(0, 8);
  issued.add(t);
  return t;
};
const nextHost = () => `v${++hostCounter}.localhost:${PORT}`;

const DEMOS = [
  { path: "/domain", title: "ドメインが変わる(302)", note: "開くたびに別のドメイン(vN.localhost)へサーバがリダイレクトします。[ドメイン] でも [パス] でも書き換わります" },
  { path: "/path", title: "パスだけ変わる(302)", note: "同じドメインの別のパスへリダイレクトします。[パス] のときだけ書き換わります" },
  { path: "/js", title: "JavaScript で転送(ドメインが変わる)", note: "ページを表示して 1 秒後に location.replace で別のドメインへ移ります" },
  { path: "/meta", title: "meta refresh(ドメインが変わる)", note: "meta refresh で別のドメインへ移ります" },
  { path: "/hash", title: "# 以降だけ変わる", note: "表示するたびに JS で # 以降をランダムに付け替えます(separator.mayastudios.com と同じ)。[パス] のときだけ書き換わります" },
  { path: "/spa", title: "replaceState でパスが変わる", note: "表示するたびに history.replaceState でパスを変えます。[パス] のときだけ書き換わります" },
  { path: "/login", title: "同じサイトのログイン画面へ(302)", note: "同じドメインの /signin へリダイレクトします。[ドメイン] では書き換わりません(誤検知の確認用)" },
];

function page(res, title, body, head = "") {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${title}</title>${head}
<style>
  body { font: 15px/1.7 -apple-system, "Hiragino Sans", sans-serif; max-width: 760px; margin: 40px auto; padding: 0 16px; color: #1f2330; }
  code { background: #f1f3f4; padding: 2px 6px; border-radius: 4px; word-break: break-all; }
  li { margin: 10px 0; }
  .note { color: #6b7280; font-size: 13px; }
  @media (prefers-color-scheme: dark) { body { background: #1b1e27; color: #e8eaf0; } code { background: #23262f; } .note { color: #9aa0ad; } }
</style></head>
<body><h1>${title}</h1>${body}
<p>今の URL: <code id="here"></code></p>
<p><a href="http://localhost:${PORT}/">デモの一覧へ</a></p>
<script>
  const show = () => (document.getElementById("here").textContent = location.href);
  show();
  addEventListener("hashchange", show);
  setInterval(show, 500);
</script>
</body></html>`);
}

function redirect(res, location) {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

// /<kind>/<token> のページを返すか、新しいトークンへ転送するか
function landing(res, kind, t, render) {
  if (issued.delete(t)) return render();
  const target = kind === "path" ? `/path/${token()}` : `http://${nextHost()}/${kind}/${token()}`;
  if (kind === "js") {
    return page(res, "1 秒後に転送します", `<p>JavaScript で <code>${target}</code> へ移ります。</p>`, `<script>setTimeout(() => location.replace(${JSON.stringify(target)}), 1000)</script>`);
  }
  if (kind === "meta") {
    return page(res, "meta refresh で転送します", `<p><code>${target}</code> へ移ります。</p>`, `<meta http-equiv="refresh" content="1;url=${target}">`);
  }
  return redirect(res, target);
}

function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const [, kind, t = "start"] = url.pathname.split("/");
  const demo = DEMOS.find((d) => d.path === `/${kind}`);

  if (url.pathname === "/") {
    const items = DEMOS.map(
      (d) => `<li><a href="http://localhost:${PORT}${d.path}">${d.title}</a><br><span class="note">${d.note}</span></li>`,
    ).join("");
    return page(
      res,
      "Bookmark URL Follower のデモ",
      `<p>下のリンクをブックマークバーへドラッグし、拡張の設定画面で監視してから開いてください。
       開くたびに転送されるので、ブックマークが書き換わってトーストが出ます。</p><ul>${items}</ul>`,
    );
  }
  if (["domain", "path", "js", "meta"].includes(kind)) {
    return landing(res, kind, t, () =>
      page(res, `転送されて来ました(${demo.title})`, `<p>もう一度ブックマークから開くと、また別の URL へ転送されます。</p>`),
    );
  }
  if (kind === "hash") {
    return page(res, demo.title, `<p>${demo.note}</p>`, `<script>location.replace("#k-" + crypto.randomUUID().slice(0, 8))</script>`);
  }
  if (kind === "spa") {
    return page(res, demo.title, `<p>${demo.note}</p>`, `<script>history.replaceState(null, "", "/spa/" + crypto.randomUUID().slice(0, 8))</script>`);
  }
  if (kind === "login") return redirect(res, "/signin");
  if (kind === "signin") return page(res, "ログイン(ダミー)", "<p>同じドメインのログイン画面です。</p>");
  res.writeHead(404);
  res.end();
}

// localhost は IPv6(::1)と IPv4 のどちらで来るか分からないので両方で待つ。外からは繋がらないよう loopback だけ
for (const host of ["127.0.0.1", "::1"]) http.createServer(handle).listen(PORT, host);
console.log(`デモサーバ: http://localhost:${PORT}/`);
