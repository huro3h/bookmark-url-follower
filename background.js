import { migrateModes, modeOf, shouldFollow, trimHistory } from "./store.js";
import { showToast } from "./toast.js";

// 転送先に着いたらすぐ書き換える。そのあと最後の遷移からこの時間は続きの転送を待ち、
// 来たら同じ書き換えを最終の URL に直す(履歴は1件のまま、トーストも出し直す)
const CHAIN_IDLE_MS = 2000;

// タブごとの状態(service worker が止まれば消えるが、追跡は数秒で終わるので困らない)
const pending = new Map(); // tabId -> Promise<{ url, ids } | null>  onBeforeNavigate で開始した遷移
const chains = new Map(); // tabId -> { ids, from, to, applied, timer } 監視中のブックマークから始まった遷移
//                           applied: Map<bookmarkId, 履歴の entry.id>  この連鎖で書き換えたもの

// storage の読み書きを直列にする(複数のタブが同時に書き換えても履歴を取りこぼさない)
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

// --- 監視中のブックマークの URL → ID の表 ------------------------------------

let urlIndex = null;

function watchedByUrl() {
  urlIndex ??= buildIndex();
  return urlIndex;
}

async function buildIndex() {
  const { watched } = await chrome.storage.local.get({ watched: [] });
  const index = new Map();
  for (const id of watched) {
    const [node] = await chrome.bookmarks.get(id).catch(() => []);
    if (!node?.url) continue;
    index.set(node.url, [...(index.get(node.url) ?? []), id]);
  }
  return index;
}

function invalidate() {
  urlIndex = null;
}

chrome.bookmarks.onChanged.addListener(invalidate);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.watched) invalidate();
});
chrome.bookmarks.onRemoved.addListener((id, { node }) => {
  invalidate();
  serial(() => forget(collectIds(node)));
});

function collectIds(node) {
  return [node.id, ...(node.children ?? []).flatMap(collectIds)];
}

// --- 遷移の追跡 ----------------------------------------------------------------

chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  pending.set(
    tabId,
    watchedByUrl().then((index) => {
      const ids = index.get(url);
      return ids ? { url, ids } : null;
    }),
  );
});

chrome.webNavigation.onErrorOccurred.addListener(({ tabId, frameId }) => {
  if (frameId === 0) pending.delete(tabId);
});

// サーバのリダイレクト(301/302 など)は、元の URL では commit されず転送先の URL で1回だけ commit される。
// JS や meta refresh の転送は、元の URL の commit の後に client_redirect 付きの commit が続く。
chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId, url, transitionQualifiers }) => {
  if (frameId !== 0) return;
  const start = pending.get(tabId);
  pending.delete(tabId);

  const chain = chains.get(tabId);
  if (chain && transitionQualifiers.includes("client_redirect")) {
    chain.to = url;
    step(tabId);
    return;
  }
  drop(tabId); // 利用者が自分で別のページへ移った

  const found = await start;
  if (!found) return;
  chains.set(tabId, { ids: found.ids, from: found.url, to: url, applied: new Map() });
  step(tabId);
});

// ハッシュだけの変化(location.hash / location.replace("#...")) と history.pushState / replaceState は
// 同じ文書の中の移動なので onCommitted が来ない。連鎖の途中ならこれも転送先として追う
// (ホストは変わらないので、書き換わるのは条件が "any" のブックマークだけ)
function sameDocument({ tabId, frameId, url }) {
  const chain = frameId === 0 && chains.get(tabId);
  if (!chain) return;
  chain.to = url;
  step(tabId);
}
chrome.webNavigation.onReferenceFragmentUpdated.addListener(sameDocument);
chrome.webNavigation.onHistoryStateUpdated.addListener(sameDocument);

chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => {
  if (frameId === 0 && chains.has(tabId)) keepAlive(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pending.delete(tabId);
  drop(tabId);
});

// 連鎖が進んだ: 今の URL で書き換える(または前の書き換えを直す)
function step(tabId) {
  const chain = chains.get(tabId);
  keepAlive(tabId);
  const to = chain.to;
  serial(() => follow(chain, to)).then((entries) => {
    // 書き換えている間に次の転送が来ていたら、通知はそちらの段に任せる
    if (entries.length && !movedOn(tabId, to)) notify(tabId, entries);
  });
}

function movedOn(tabId, to) {
  const chain = chains.get(tabId);
  return Boolean(chain) && chain.to !== to;
}

function keepAlive(tabId) {
  const chain = chains.get(tabId);
  clearTimeout(chain.timer);
  chain.timer = setTimeout(() => chains.delete(tabId), CHAIN_IDLE_MS);
}

function drop(tabId) {
  clearTimeout(chains.get(tabId)?.timer);
  chains.delete(tabId);
}

// --- 書き換えと元に戻す ----------------------------------------------------------

// 書き換える条件はブックマークごと。同じ URL の監視が複数あれば、条件に合うものだけ書き換える。
// 条件は連鎖の始まり(from)と今の URL(to)で見る。返すのは今回書き換えた・直した履歴
async function follow(chain, to) {
  const { modes, history } = await chrome.storage.local.get({ modes: {}, history: [] });
  const entries = [];
  const added = [];
  for (const id of chain.ids) {
    if (!shouldFollow(chain.from, to, modeOf(modes, id))) continue;
    const applied = chain.applied.has(id) && history.find((e) => e.id === chain.applied.get(id));
    if (applied) {
      // この連鎖で書き換え済み: 最終の URL に直す。元に戻した後なら触らない
      if (applied.undoneAt || applied.to === to) continue;
      const [node] = await chrome.bookmarks.get(id).catch(() => []);
      if (node?.url !== applied.to) continue;
      await chrome.bookmarks.update(id, { url: to });
      Object.assign(applied, { to, at: Date.now() });
      entries.push(applied);
    } else {
      const [node] = await chrome.bookmarks.get(id).catch(() => []);
      if (node?.url !== chain.from) continue; // 開いている間に手で直された
      await chrome.bookmarks.update(id, { url: to });
      const entry = { id: crypto.randomUUID(), bookmarkId: id, title: node.title, from: chain.from, to, at: Date.now() };
      chain.applied.set(id, entry.id);
      added.push(entry);
      entries.push(entry);
    }
  }
  if (entries.length) await chrome.storage.local.set({ history: trimHistory([...added, ...history]) });
  return entries;
}

async function undo(entryIds) {
  const { history } = await chrome.storage.local.get({ history: [] });
  let restored = 0;
  for (const entry of history) {
    if (!entryIds.includes(entry.id) || entry.undoneAt) continue;
    const ok = await chrome.bookmarks.update(entry.bookmarkId, { url: entry.from }).then(
      () => true,
      () => false,
    );
    if (!ok) continue;
    entry.undoneAt = Date.now();
    restored++;
  }
  await chrome.storage.local.set({ history });
  return { restored };
}

// 設定画面は Undo / Redo やまとめて選択があるので、1件ずつではなく監視中の全体を送ってくる
// 返事の { ok: true } は、設定画面が「保存できた」と確かめるためのもの(古い service worker が知らない
// メッセージを黙って無視したときに、画面だけ選択済みに見えてしまうのを防ぐ)
async function setWatched(ids) {
  await chrome.storage.local.set({ watched: ids });
  return { ok: true };
}

// 監視を外しても条件は残す(Undo で監視に戻したときに条件も戻るように)。消すのはブックマークが削除されたときだけ
async function setMode(id, mode) {
  const { modes } = await chrome.storage.local.get({ modes: {} });
  await chrome.storage.local.set({ modes: { ...modes, [id]: mode } });
  return { ok: true };
}

async function forget(ids) {
  const { watched, history, modes } = await chrome.storage.local.get({ watched: [], history: [], modes: {} });
  for (const id of ids) delete modes[id];
  await chrome.storage.local.set({
    watched: watched.filter((id) => !ids.includes(id)),
    history: history.filter((entry) => !ids.includes(entry.bookmarkId)),
    modes,
  });
}

chrome.runtime.onInstalled.addListener(() =>
  serial(async () => {
    const stored = await chrome.storage.local.get(["mode", "watched", "modes"]);
    if (stored.mode === undefined) return;
    await chrome.storage.local.set({ modes: migrateModes(stored) });
    await chrome.storage.local.remove("mode");
  }),
);

// --- 通知 ------------------------------------------------------------------------

async function notify(tabId, entries) {
  const payload = {
    titles: entries.map((e) => e.title || e.to),
    to: entries[0].to,
    entryIds: entries.map((e) => e.id),
  };
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: showToast, args: [payload] });
  } catch {
    // 差し込む途中で次の転送が始まって失敗した: 次の段がトーストを出すので何もしない
    if (movedOn(tabId, payload.to)) return;
    // chrome:// やストアのページ、閉じたタブにはトーストを出せないので OS の通知にする
    chrome.notifications.create(`undo:${payload.entryIds.join(",")}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "ブックマークの URL を更新しました",
      message: `${payload.titles[0]}\n→ ${payload.to}`,
      buttons: [{ title: "元に戻す" }],
    });
  }
}

chrome.notifications.onButtonClicked.addListener((notificationId) => {
  if (!notificationId.startsWith("undo:")) return;
  serial(() => undo(notificationId.slice(5).split(",")));
  chrome.notifications.clear(notificationId);
});

// --- メッセージ・アイコン ----------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "undo") {
    serial(() => undo(msg.entryIds)).then(sendResponse);
    return true;
  }
  if (msg?.type === "setMode") {
    serial(() => setMode(msg.id, msg.mode)).then(sendResponse);
    return true;
  }
  if (msg?.type === "setWatched") {
    serial(() => setWatched(msg.ids)).then(sendResponse);
    return true;
  }
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
