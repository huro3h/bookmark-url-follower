// 拡張を読み込んだ Brave Nightly をバックグラウンドで起動し、リダイレクトでブックマークが書き換わるかを確かめる。
// localhost と 127.0.0.1 を「別のドメイン」として使う。
const http = require("http");
const path = require("path");
const { chromium } = require("playwright");
const { launchBackground } = require("./background-browser.js");

const EXT = path.resolve(__dirname, "..");
const W = 900;
const H = 700;

function startServer() {
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    const other = `http://127.0.0.1:${port}`;
    const html = (body) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>${req.url}</title>${body}`);
    };
    switch (req.url) {
      case "/server":
        res.writeHead(302, { location: `${other}/moved-server` });
        return res.end();
      case "/js":
        return html(`<script>location.replace("${other}/moved-js")</script>`);
      case "/meta":
        return html(`<meta http-equiv="refresh" content="0;url=${other}/moved-meta">`);
      case "/hash":
        // separator.mayastudios.com と同じく、読み込むたびにハッシュをランダムに付け替える
        return html(`<script>location.replace("#k-" + crypto.randomUUID())</script>`);
      case "/spa":
        return html(`<script>history.replaceState(null, "", "/spa-home")</script>`);
      case "/fast":
        res.writeHead(302, { location: `${other}/moved-fast` });
        return res.end();
      case "/chain":
        // 302 で別のドメインへ → そこから JS ですぐ3つ目のドメインへ(*.localhost は Chrome が自分の PC に向ける)
        res.writeHead(302, { location: `${other}/chain-mid` });
        return res.end();
      case "/chain-mid":
        return html(`<script>location.replace("http://hop.localhost:${port}/chain-end")</script>`);
      case "/login":
        res.writeHead(302, { location: "/signin" });
        return res.end();
      case "/unwatched":
        res.writeHead(302, { location: `${other}/moved-unwatched` });
        return res.end();
      default:
        return html("<p>page</p>");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `  ${detail}`}`);
}

(async () => {
  const server = await startServer();
  const base = `http://localhost:${server.address().port}`;
  const other = `http://127.0.0.1:${server.address().port}`;
  const b = await launchBackground(chromium, { extension: EXT });
  try {
    const sw = await b.serviceWorker();
    const ids = await sw.evaluate(async (base) => {
      const make = (name, watch) =>
        chrome.bookmarks.create({ parentId: "1", title: name, url: `${base}/${name}` }).then((n) => [name, n.id, watch]);
      const list = await Promise.all([
        make("server", true),
        make("js", true),
        make("meta", true),
        make("login", true),
        make("unwatched", false),
      ]);
      await chrome.storage.local.set({ watched: list.filter((x) => x[2]).map((x) => x[1]) });
      // フォルダのメニューと「このフォルダをすべて選択」を確かめるための、監視していないフォルダ
      const folder = await chrome.bookmarks.create({ parentId: "1", title: "dir" });
      const inner = await Promise.all(
        ["a", "b"].map((n) => chrome.bookmarks.create({ parentId: folder.id, title: `dir-${n}`, url: `${base}/dir-${n}` })),
      );
      return { ...Object.fromEntries(list.map(([name, id]) => [name, id])), inner: inner.map((n) => n.id) };
    }, base);
    const urlOf = (id) => sw.evaluate(async (id) => (await chrome.bookmarks.get(id))[0].url, id);

    const pages = {};
    for (const name of ["server", "js", "meta", "login", "unwatched"]) {
      // 転送するページを直接 openPage すると、サイズ合わせの evaluate が遷移で壊れるので空のページから移る
      pages[name] = await b.openPage("about:blank", { width: W, height: H });
      await pages[name].goto(`${base}/${name}`);
    }
    await pages.server.waitForTimeout(4000);

    check("サーバのリダイレクトに追従", (await urlOf(ids.server)) === `${other}/moved-server`, await urlOf(ids.server));
    check("JS の転送に追従", (await urlOf(ids.js)) === `${other}/moved-js`, await urlOf(ids.js));
    check("meta refresh に追従", (await urlOf(ids.meta)) === `${other}/moved-meta`, await urlOf(ids.meta));
    check("同じドメイン内の転送は書き換えない", (await urlOf(ids.login)) === `${base}/login`, await urlOf(ids.login));
    check("監視していないものは書き換えない", (await urlOf(ids.unwatched)) === `${base}/unwatched`, await urlOf(ids.unwatched));

    const history = await sw.evaluate(async () => (await chrome.storage.local.get("history")).history);
    check("履歴が3件", history.length === 3, JSON.stringify(history));

    const toast = await pages.server.evaluate(() => !!document.getElementById("bookmark-url-follower-toast"));
    check("トーストが出ている", toast);

    if (process.env.SHOT_DIR) await pages.server.screenshot({ path: path.join(process.env.SHOT_DIR, "toast.png") });

    // 閉じた shadow DOM なので座標でクリックする(右下の「元に戻す」)
    const size = await pages.server.evaluate(() => [innerWidth, innerHeight]);
    await pages.server.mouse.click(size[0] - 16 - 14 - 30, size[1] - 16 - 12 - 12);
    await pages.server.waitForTimeout(500);
    check("トーストの「元に戻す」で戻る", (await urlOf(ids.server)) === `${base}/server`, await urlOf(ids.server));

    // 戻した後にもう一度開くと、また書き換わる(ID で追い続けている)
    await pages.server.goto(`${base}/server`);
    await pages.server.waitForTimeout(3000);
    check("もう一度開くと再び追従", (await urlOf(ids.server)) === `${other}/moved-server`, await urlOf(ids.server));

    // 書き換え後の URL でも監視が続く: 転送先がさらに移転した場合
    const options = await b.openPage(`chrome-extension://${new URL(sw.url()).host}/options.html`, { width: W, height: H });
    await options.waitForSelector(".history li .button");
    const rows = await options.locator(".history li").count();
    check("設定画面に履歴が並ぶ", rows === 4, String(rows));
    const watchedNow = () => sw.evaluate(async () => (await chrome.storage.local.get("watched")).watched);
    const chip = (name) => options.locator(".bmbar .bm-chip", { hasText: name }).first();
    check("バーで監視中の4件がハイライト", (await options.locator(".bm-chip.selected").count()) === 4);
    check("監視中の一覧に4件", (await options.locator(".sel-row").count()) === 4);
    check("見出しの件数", (await options.locator("#selectedHeading").textContent()) === "4 件を監視中");

    await options.locator(".history li .button").first().click();
    await options.waitForTimeout(500);
    check("設定画面の「元に戻す」で戻る", (await urlOf(ids.server)) === `${base}/server`, await urlOf(ids.server));
    check("戻し済み表示", (await options.locator(".history li .done").count()) === 2);

    // バーのチップを押すと外れる → ↶ で戻る → ↷ でまた外れる
    await chip("server").click();
    await options.waitForTimeout(300);
    check("チップを押すと監視を外す", !(await watchedNow()).includes(ids.server));
    check("外したチップのハイライトが消える", !(await chip("server").getAttribute("class")).includes("selected"));
    await options.locator("#undo").click();
    await options.waitForTimeout(300);
    check("↶ で監視に戻る", (await watchedNow()).includes(ids.server));
    await options.locator("#redo").click();
    await options.waitForTimeout(300);
    check("↷ でまた外れる", !(await watchedNow()).includes(ids.server));

    // 監視を外すと書き換えない
    await pages.server.goto(`${base}/server`);
    await pages.server.waitForTimeout(3000);
    check("監視を外すと書き換えない", (await urlOf(ids.server)) === `${base}/server`, await urlOf(ids.server));

    // フォルダのメニューから「すべて選択」
    await chip("dir").click();
    await options.locator(".bm-menu .select-all").click();
    await options.waitForTimeout(300);
    const w = await watchedNow();
    check("「このフォルダをすべて選択」", ids.inner.every((id) => w.includes(id)), JSON.stringify(w));
    check("中に監視中があるフォルダに印", (await chip("dir").getAttribute("class")).includes("has-selected"));
    check("メニューの項目もハイライト", (await options.locator(".bm-menu .menu-item.selected").count()) === 2);
    check("「すべて解除」に変わる", (await options.locator(".bm-menu .select-all").textContent()).includes("すべて解除"));
    if (process.env.SHOT_DIR) await options.screenshot({ path: path.join(process.env.SHOT_DIR, "options-menu.png") });
    await options.keyboard.press("Escape");

    // 一覧の × で外す
    await options.locator(`.sel-row[data-key="${ids.inner[0]}"] .icon-btn`).click();
    await options.waitForTimeout(300);
    check("一覧の × で外す", !(await watchedNow()).includes(ids.inner[0]));

    // ブックマークを消すと監視と履歴からも消える
    await sw.evaluate((id) => chrome.bookmarks.remove(id), ids.js);
    await options.waitForTimeout(300);
    const after = await sw.evaluate(async () => chrome.storage.local.get(["watched", "history"]));
    check(
      "削除したブックマークを忘れる",
      !after.watched.includes(ids.js) && !after.history.some((e) => e.bookmarkId === ids.js),
      JSON.stringify(after),
    );

    if (process.env.SHOT_DIR) await options.screenshot({ path: path.join(process.env.SHOT_DIR, "options.png") });

    // 同じ文書の中の URL の変化(ハッシュの付け替え・replaceState)は [パス] のブックマークだけ書き換える
    const same = await sw.evaluate(async (base) => {
      const hash = await chrome.bookmarks.create({ parentId: "1", title: "hash", url: `${base}/hash#k-original` });
      const spa = await chrome.bookmarks.create({ parentId: "1", title: "spa", url: `${base}/spa` });
      const { watched } = await chrome.storage.local.get("watched");
      await chrome.storage.local.set({ watched: [...watched, hash.id, spa.id] });
      return { hash: hash.id, spa: spa.id };
    }, base);
    const page = await b.openPage("about:blank", { width: W, height: H });
    const visit = async (url) => {
      await page.goto(url);
      await page.waitForTimeout(3000);
    };
    await visit(`${base}/hash#k-original`);
    await visit(`${base}/spa`);
    check("[ドメイン]: ハッシュの付け替えは無視", (await urlOf(same.hash)) === `${base}/hash#k-original`, await urlOf(same.hash));
    check("[ドメイン]: replaceState は無視", (await urlOf(same.spa)) === `${base}/spa`, await urlOf(same.spa));

    // 書き換える条件はブックマークごと: hash と spa だけ [パス] にする
    const modeBtn = (id, mode) => options.locator(`.sel-row[data-key="${id}"] .mode-btn[data-mode="${mode}"]`);
    check("新しく監視したものは [ドメイン]", (await modeBtn(same.hash, "host").getAttribute("aria-pressed")) === "true");
    await modeBtn(same.hash, "any").click();
    await modeBtn(same.spa, "any").click();
    await options.waitForTimeout(300);
    check("[パス] が選ばれた表示", (await modeBtn(same.hash, "any").getAttribute("class")).includes("active"));
    const modes = await sw.evaluate(async () => (await chrome.storage.local.get("modes")).modes);
    check("条件をブックマークごとに保存", modes[same.hash] === "any" && modes[same.spa] === "any" && !modes[ids.meta], JSON.stringify(modes));
    if (process.env.SHOT_DIR) await options.screenshot({ path: path.join(process.env.SHOT_DIR, "options-modes.png") });
    await visit(`${base}/hash#k-original`);
    const hashed = await urlOf(same.hash);
    check("[パス]: ハッシュの付け替えに追従", /\/hash#k-[0-9a-f-]{36}$/.test(hashed), hashed);
    check("[パス]: トーストが出る", await page.evaluate(() => !!document.getElementById("bookmark-url-follower-toast")));
    await visit(`${base}/spa`);
    check("[パス]: replaceState に追従", (await urlOf(same.spa)) === `${base}/spa-home`, await urlOf(same.spa));
    // 書き換わった後の URL で開いても(ID で追っているので)また追従する
    await visit(hashed);
    const again = await urlOf(same.hash);
    check("書き換えた URL から開いても再び追従", again !== hashed && /#k-/.test(again), again);

    // 素早く続けて押しても、最後に画面で見えている選択がそのまま保存される
    const names = ["meta", "login", "unwatched", "hash", "spa"];
    for (const name of names) await chip(name).click({ delay: 0 });
    await options.waitForTimeout(800);
    const shown = await options.$$eval(".bmbar .bm-chip.selected[data-kind=bookmark]", (els) => els.map((e) => e.dataset.id).sort());
    // フォルダの中(dir-b)はバーのチップではないので比べない
    const stored = (await watchedNow()).filter((id) => !ids.inner.includes(id)).sort();
    check("連打しても画面と保存が一致", JSON.stringify(shown) === JSON.stringify(stored), `${shown} / ${stored}`);

    // 古い service worker がメッセージを無視したとき(返事がない)は知らせて、保存されている状態に戻す
    const beforeFail = await watchedNow();
    await options.evaluate(() => {
      chrome.runtime.sendMessage = async () => undefined;
    });
    await chip("login").click();
    await options.waitForTimeout(500);
    check("保存できないと知らせる", await options.locator("#saveError").isVisible());
    check("保存されている状態に戻す", ((await chip("login").getAttribute("class")).includes("selected")) === beforeFail.includes(ids.login));

    // 着いたらすぐ書き換えてトーストを出す(以前は最後の遷移から2秒待っていた)
    const extra = await sw.evaluate(async (base) => {
      const make = (name) => chrome.bookmarks.create({ parentId: "2", title: name, url: `${base}/${name}` });
      const [fast, chain] = await Promise.all([make("fast"), make("chain")]);
      const { watched } = await chrome.storage.local.get("watched");
      await chrome.storage.local.set({ watched: [...watched, fast.id, chain.id] });
      return { fast: fast.id, chain: chain.id };
    }, base);
    await page.goto("about:blank");
    const t0 = Date.now();
    await page.goto(`${base}/fast`);
    await page.waitForFunction(() => document.getElementById("bookmark-url-follower-toast"), null, { timeout: 5000 });
    const elapsed = Date.now() - t0;
    check("トーストがすぐ出る(1 秒以内)", elapsed < 1000, `${elapsed}ms`);
    check("すぐ書き換わっている", (await urlOf(extra.fast)) === `${other}/moved-fast`, await urlOf(extra.fast));

    // 何段も続く転送: 途中で一度書き換え、最終の URL に直す。履歴は1件、元に戻すと最初の URL へ
    await page.goto("about:blank");
    await page.goto(`${base}/chain`);
    await page.waitForTimeout(2500);
    const end = `http://hop.localhost:${server.address().port}/chain-end`;
    check("何段も続く転送は最終の URL に", (await urlOf(extra.chain)) === end, await urlOf(extra.chain));
    const chainHistory = await sw.evaluate(
      async (id) => (await chrome.storage.local.get("history")).history.filter((e) => e.bookmarkId === id),
      extra.chain,
    );
    check("履歴は1件にまとまる", chainHistory.length === 1 && chainHistory[0].from === `${base}/chain` && chainHistory[0].to === end, JSON.stringify(chainHistory));
    check("トーストは最終のページに出る", await page.evaluate(() => !!document.getElementById("bookmark-url-follower-toast")));
  } finally {
    await b.close();
    server.close();
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `${failed} 件失敗` : "すべて成功");
  process.exit(failed ? 1 : 0);
})();
