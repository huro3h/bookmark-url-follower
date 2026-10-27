// chrome.storage.local のスキーマと、書き換えるかどうかの判定。
// watched / history を書き込むのは background.js だけ(直列化のため)。設定画面はメッセージで頼む。

export const HISTORY_PER_BOOKMARK = 5;

export const DEFAULTS = {
  watched: [], // 監視するブックマークの ID。端末ごとに違う番号なので sync には置かない
  history: [], // [{ id, bookmarkId, title, from, to, at, undoneAt? }] 新しい順
  modes: {}, // { [bookmarkId]: "host" | "any" } 書き換える条件。ないものは DEFAULT_MODE
};

// "host": ドメインが変わったときだけ(設定画面の [ドメイン]) / "any": URL が少しでも変わったら([パス])
export const DEFAULT_MODE = "host";

// 以前は条件が全体で1つ(mode)だった。"any" にしていたら、監視中でまだ条件のないブックマークに引き継ぐ
export function migrateModes({ mode, watched = [], modes = {} }) {
  const next = { ...modes };
  if (mode === "any") for (const id of watched) next[id] ??= "any";
  return next;
}

export function modeOf(modes, id) {
  return modes[id] ?? DEFAULT_MODE;
}

export function load() {
  return chrome.storage.local.get(DEFAULTS);
}

export function shouldFollow(from, to, mode) {
  let a, b;
  try {
    a = new URL(from);
    b = new URL(to);
  } catch {
    return false;
  }
  if (b.protocol !== "http:" && b.protocol !== "https:") return false;
  // "any" はフラグメント(# 以降)だけの違いも書き換える(ページの JS がハッシュを付け替えるサイトがある)
  if (mode === "any") return a.href !== b.href;
  return a.host !== b.host;
}

// ブックマークごとに新しい順で HISTORY_PER_BOOKMARK 件まで残す
export function trimHistory(history) {
  const counts = new Map();
  return history.filter(({ bookmarkId }) => {
    const n = (counts.get(bookmarkId) ?? 0) + 1;
    counts.set(bookmarkId, n);
    return n <= HISTORY_PER_BOOKMARK;
  });
}
