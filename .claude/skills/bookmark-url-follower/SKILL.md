---
name: bookmark-url-follower
description: Bookmark URL Follower (リダイレクト先にブックマークの URL を書き換える Chrome 拡張) を改修・デバッグするときに使う。webNavigation での転送の追い方、ブックマーク ID で監視する理由、トーストの差し込み方、テスト手順を記録している。
---

# Bookmark URL Follower 開発メモ

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `background.js` | 遷移の追跡・書き換え・元に戻す・通知。`watched` / `history` を書くのはここだけ |
| `store.js` | ストレージの既定値、`shouldFollow`(書き換えるかの判定)、`trimHistory` |
| `toast.js` | ページに差し込むトースト。`scripting.executeScript` の `func` |
| `bookmarks.js` | ブックマークの木を平らにする `readTree()`(bookmark-set-opener と同じ形) |
| `options.*` | 監視の選択(ブックマークバー)、監視中の一覧と書き換える条件、更新履歴 |
| `icons/icon.svg` | アイコンの原本(ブックマークのリボンと右向きの矢印。矢じりだけ塗り) |

ツールバーのアイコンはポップアップを持たず、クリックで設定画面を開く(`action.onClicked`)。

## ストレージ(すべて `chrome.storage.local`)

```
watched: [bookmarkId]                                        監視するブックマーク
history: [{ id, bookmarkId, title, from, to, at, undoneAt? }] 新しい順。ブックマークごとに 5 件
modes:   { [bookmarkId]: "host" | "any" }                    書き換える条件。ないものは "host"(DEFAULT_MODE)
```

## 中心にある設計判断

### 監視はブックマークの ID で持つ

ID は編集・移動・再起動では変わらないので、拡張が URL を書き換えた後も同じ ID で追い続けられる。
URL で持つと、書き換えた瞬間に監視が外れる。

ただし ID は**端末・プロフィールごとに別の番号**(同期で届いたものにも受け取った側が振る。
bookmark-set-opener の skill に詳しい)。だから `storage.sync` に置かない。

削除→作り直しは別 ID になる。`bookmarks.onRemoved` で監視と履歴から消す(フォルダごと消されたら
`removeInfo.node` の子孫も全部)。

### 遷移の追い方(webNavigation)

- **サーバのリダイレクト**は、元の URL では `onCommitted` が来ず、転送先の URL で1回だけ commit される
  (`transitionQualifiers` に `server_redirect`)。元の URL が分かるのは `onBeforeNavigate` だけ。
  そこで `onBeforeNavigate` で「監視中のブックマークの URL か」を調べて `pending` に置き、
  `onCommitted` で取り出して連鎖(`chains`)を始める
- **JS・meta refresh の転送**は、元の URL の commit の後に `client_redirect` 付きの commit が続く。
  連鎖があって `client_redirect` なら `to` を進める。それ以外の commit は利用者が自分で移ったとみなして連鎖を捨てる
- **ハッシュだけの変化**(`location.hash` / `location.replace("#...")`)は `onReferenceFragmentUpdated`、
  **`history.pushState` / `replaceState`** は `onHistoryStateUpdated` で来る(同じ文書の中なので `onCommitted` は来ない)。
  連鎖の途中ならこれも `to` を進める。ホストは変わらないので、書き換わるのは条件が `"any"` のブックマークだけ。
  きっかけは separator.mayastudios.com(読み込むたびに JS でハッシュをランダムな UUID に付け替える)で、
  最初の版は `onCommitted` しか見ておらずフラグメントも比較で捨てていたため、「URL が少しでも変わったら」でも何も起きなかった
- **転送先に着いた段(`step()`)ですぐ書き換えてトーストを出す。** 連鎖は最後の commit / `onCompleted` から
  `CHAIN_IDLE_MS`(2秒)残し、その間に続きの転送が来たら同じ書き換えを最終の URL に直す
  (`chain.applied` で履歴の entry を覚え、`to` を書き換えるだけ。履歴は1件、「元に戻す」は連鎖の最初の URL へ)。
  元に戻した後に続きが来ても触らない
  - 以前は最後の遷移から2秒待って確定していたが、「トーストがワンテンポ遅い・動いていないのかと思った」と言われて変えた(2026-10-27)
  - 書き換えている間に次の転送が来ていたら(`movedOn()`)、その段の通知は出さない。トーストの差し込みが途中の転送で
    失敗したときも OS の通知に切り替えない(次の段がトーストを出す)。そうしないと何段も続く転送で OS の通知が出てしまう
- `transitionType` が `auto_bookmark` かどうかは見ていない。新しいタブで開いた・URL を直接打った場合も
  拾えるよう、URL の一致だけで判断する
- `pending` は Promise のまま入れる。URL→ID の表を引く非同期の間に `onCommitted` が来ても取りこぼさないため。
  表(`urlIndex`)はブックマークの変更・`watched` の変更で捨てて、次の遷移で作り直す
- 書き換える直前にブックマークの URL がまだ `from` か確かめる(開いている間に手で直されていたら触らない)

### 誤った書き換えを防ぐ

書き換える条件は**ブックマークごと**(`modes`)。設定画面では監視中の一覧の各行の右端に
[ドメイン] [パス] [×] と並べた切り替えで選ぶ(ユーザーの指定した形)。

- `"host"`(既定・[ドメイン]): ホスト(ポート込み)が変わったときだけ書き換える。同じサイト内の
  ログイン画面やトップへの転送で書き換えないため
- `"any"`([パス]): フラグメント(# 以降)だけの違いも含め、URL が変わったら書き換える
  (ハッシュを毎回変えるサイトでは開くたびに書き換わり、トーストも毎回出る)
- どちらでも、転送先が http(s) でなければ書き換えない
- 同じ URL の監視が複数あれば、`finalize` で条件に合うものだけを書き換える
- 監視を外しても条件は消さない(Undo で監視に戻したとき条件も戻るように)。消すのはブックマークの削除時(`forget`)だけ
- 初めは全体で1つの `mode` だった。`onInstalled` の `migrateModes()` で、`"any"` だったら監視中のものに引き継いで `mode` を消す

### 書き込みは background に集める

複数のタブが同時に書き換えると、`history` の読み→書きが競合して取りこぼす。`serial()` で直列化し、
設定画面からの監視の切り替え・条件の切り替え・元に戻すもメッセージ(`setWatched` / `setMode` / `undo`)で background に頼む
(`modes` は `forget` も書くので、条件の切り替えも直列化の対象にしている)。

### 保存は返事で確かめる(古い service worker 対策)

パッケージ化されていない拡張は、**設定画面などの拡張のページは開くたびにディスクの最新ファイルを読む**が、
**service worker は拡張を再読み込み(↻)するまで古いまま**。メッセージの名前を変えた(`watch` → `setWatched`)後、
再読み込みせずに使われて、古い service worker が知らないメッセージを黙って無視し、画面だけ監視中に見えて
閉じると外れている、という報告があった(2026-10-27。原因は再読み込みしていなかったこと)。

- `setWatched` / `setMode` は `{ ok: true }` を返し、設定画面の `send()` が確かめる。返事がなければ `#saveError` を出し、
  `reconcile()` で保存されている状態に戻す
- 保存を頼んでいる間(`pendingSaves`)は `storage.onChanged` の watched / modes を取り込まず、全部の返事の後に突き合わせる
  (前の保存の通知が遅れて届くと選択が一瞬古くなり、そこで次を押すと直前の選択が消えるため)
- メッセージの形を変えたら、利用者には「拡張の再読み込み」を必ず案内する

### トースト

- `scripting.executeScript({ func: showToast })` で差し込む。func は**本体だけがシリアライズされる**ので、
  `toast.js` の中で外の変数や import を参照しない
- ページの CSS の影響を受けないよう、閉じた shadow DOM に入れて `:host { all: initial }`
- 差し込めない(chrome:// ページ・タブが閉じられた等)ときは `chrome.notifications` のボタン付き通知に切り替える。
  通知 ID を `undo:<entryId,...>` にして、ボタンのクリックで元に戻す
- `<all_urls>` はトーストのためだけに要る(転送先のドメインは事前に分からない)

### 設定画面の監視の選択(ブックマークバー)

bookmark-set-opener のセット編集画面のバーをそのまま移植した(ユーザーの要望。最初はチェックボックス付きの
平らな一覧+絞り込みだった)。バー・ドロップダウン・サブメニュー・「»」へのしまい方・`.selected` のハイライト・
`syncSelection()` でクラスだけ書き換える作り・選択中の一覧は**同じ挙動**なので、細かい理由(メニューを常にバーの下に出す、
hover で開いた直後のクリックで閉じない、など)は bookmark-set-opener の skill の「セット編集画面」節を見る。
片方を直したら、もう片方にも同じ直しが要るか確かめる。

違いは次のとおり:

- **保存ボタンがない。** 押した時点で `{ type: "setWatched", ids }` を background に送って保存する。1件ずつではなく
  全体を送るのは、Undo/Redo と「すべて選択」がまとめて変えるため
- Undo/Redo は見出しの行の右端。この画面を開いている間だけの履歴(`undoStack` は監視中の Set の写し)
- 選択中の一覧は**ドラッグで並べ替えない**(監視に順番はない)。バーと同じ木の並び。見出しは「n 件を監視中」
- `storage.onChanged` の `watched` は、中身が違うときだけ取り込む(ブックマークの削除で background が外したときなど)。
  自分が送った保存も返ってくるが、中身が同じなので描き直さない
- バーの欄だけ横幅いっぱい(`section.wide`)。履歴は 720px で左端をそろえる

### 元に戻す

`entry.from` に戻して `undoneAt` を付けるだけ。監視は続くので、次に開けばまた書き換わる
(誤検知が続くなら監視を外してもらう)。

## テスト

`npm test` → `test/e2e.js`。browser-testing skill の手順(Playwright + Brave Nightly を背面で起動。
ヘルパーは `test/background-browser.js` にコピー済み)。

- `localhost:<port>` と `127.0.0.1:<port>` を別のドメインとして使い、Node の HTTP サーバで
  302・`location.replace`・meta refresh・同じホスト内の 302 を返す
- 転送するページを `openPage(url, { width, height })` で直接開くと、ヘルパーのサイズ合わせの `evaluate` が
  遷移で壊れる。`about:blank` を開いてから `goto` する
- トーストは閉じた shadow DOM なのでロケータで掴めない。右下の座標をクリックして「元に戻す」を押している
  (トーストの位置や余白を変えたらテストの座標も直す)
- 同じ URL(ハッシュ付き)へそのまま `goto` すると、再読み込みにならずハッシュの移動として扱われるので、
  「開き直し」を確かめるときは別のページ(`about:blank`)を挟む
- `SHOT_DIR=<dir> npm test` でトーストと設定画面のスクリーンショットを保存する

## デモサーバ(手で挙動を見る)

`npm run demo` → `test/demo-server.js`、http://localhost:18790/(127.0.0.1 と ::1 の両方で待つ。外からは繋がらない)。
ドメイン(302)・パス(302)・JS(1 秒後の `location.replace`)・meta refresh・ハッシュ・replaceState・同じサイトの /signin への
302 を並べている。**開くたびに転送する**ため、転送先の URL に入れたトークンは発行後の最初の1回だけページを返し、
2回目以降(書き換わったブックマークから開いたとき)はまた新しいトークンへ転送する。知らないトークン(再起動後)も転送する。
ドメインは `vN.localhost`(Chrome は `*.localhost` を loopback に解決するので hosts 不要)。
ページを表示した 1 秒後の `location.replace` にも `client_redirect` が付き、追従できることをこれで確かめた。
