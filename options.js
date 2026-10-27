import { readTree } from "./bookmarks.js";
import { load, modeOf } from "./store.js";

const $ = (id) => document.getElementById(id);

let tree = [];
let watched = new Set(); // 監視中のブックマーク ID。押した時点で background に保存を頼む
let modes = {}; // ブックマークごとの書き換える条件(store.js の modes)

// ---- 部品 ----

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function span(className, text) {
  return el("span", { className, textContent: text });
}

// ブラウザがキャッシュしているファビコン(ブックマークバーと同じもの)。favicon 権限が要る。
// 一度も開いたことのないサイトは既定の地球儀アイコンになる。高解像度の画面向けに 32px を 16px で表示する。
function favicon(url) {
  return el("img", {
    className: "favicon",
    alt: "",
    width: 16,
    height: 16,
    src: chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`),
  });
}

const FOLDER_SVG = `<svg class="node-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
  <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"
    fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
</svg>`;

const REMOVE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

// tree を引きやすくした索引。フォルダの子孫のブックマーク、フォルダ直下の要素
let descendantsOf = new Map(); // folderId -> bookmarkId[]
let childrenOf = new Map(); // folderId | null -> entry[](null は最上位のフォルダ)
let bookmarkOf = new Map(); // bookmarkId -> entry

function indexHierarchy() {
  descendantsOf = new Map();
  childrenOf = new Map([[null, []]]);
  bookmarkOf = new Map();
  const stack = [];
  for (const e of tree) {
    while (stack.length && stack.at(-1).depth >= e.depth) stack.pop();
    childrenOf.get(stack.at(-1)?.id ?? null).push(e);
    if (e.kind === "folder") {
      descendantsOf.set(e.id, []);
      childrenOf.set(e.id, []);
      stack.push(e);
    } else {
      bookmarkOf.set(e.id, e);
      for (const f of stack) descendantsOf.get(f.id).push(e.id);
    }
  }
}

// ---- 監視の切り替えと Undo / Redo ----
// 監視を変える操作(ブックマークを押す・すべて選択/解除・一覧の ×)はすべて changeWatched を通し、
// 操作前の写しを積む。この画面を開いている間だけの履歴。

const HISTORY_LIMIT = 200;
const undoStack = [];
const redoStack = [];

function save() {
  return send({ type: "setWatched", ids: [...watched] });
}

// 保存は background に頼み、{ ok: true } の返事で確かめる。返事がなければ(拡張を更新したのに再読み込みしておらず、
// 古い service worker がメッセージを知らない・拡張が無効になった等)画面に出し、保存されている状態に戻す。
// 頼んでいる間は storage の変更通知を取り込まない: 前の保存の通知が遅れて届くと選択が一瞬古くなり、
// そこで次を押すと直前の選択が消えるため。全部の返事が来たら storage と突き合わせる。
let pendingSaves = 0;

async function send(message) {
  pendingSaves++;
  let ok = false;
  try {
    ok = (await chrome.runtime.sendMessage(message))?.ok === true;
  } catch {}
  $("saveError").hidden = ok;
  pendingSaves--;
  if (!pendingSaves) await reconcile();
}

async function reconcile() {
  const state = await load();
  const next = new Set(state.watched);
  if (next.size !== watched.size || [...next].some((id) => !watched.has(id))) {
    watched = next;
    syncSelection();
  }
  if (JSON.stringify(state.modes) !== JSON.stringify(modes)) {
    modes = state.modes;
    renderSelectedList();
  }
}

function changeWatched(apply) {
  const before = new Set(watched);
  apply(watched);
  if (before.size === watched.size && [...before].every((id) => watched.has(id))) return;
  undoStack.push(before);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  syncSelection();
  save();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(watched);
  watched = undoStack.pop();
  syncSelection();
  save();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(watched);
  watched = redoStack.pop();
  syncSelection();
  save();
}

$("undo").addEventListener("click", undo);
$("redo").addEventListener("click", redo);

// ⌘Z / ⇧⌘Z(Windows などは Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y)
document.addEventListener("keydown", (ev) => {
  if (!(ev.metaKey || ev.ctrlKey) || ev.altKey) return;
  if (ev.target.closest("input, textarea")) return;
  const key = ev.key.toLowerCase();
  if (key === "z" && !ev.shiftKey) undo();
  else if ((key === "z" && ev.shiftKey) || (key === "y" && ev.ctrlKey)) redo();
  else return;
  ev.preventDefault();
});

function toggleBookmark(id) {
  changeWatched((w) => (w.has(id) ? w.delete(id) : w.add(id)));
}

// まとめて選択する。全部選択済みなら全部解除する
function toggleAll(ids) {
  changeWatched((w) => {
    const all = ids.length > 0 && ids.every((id) => w.has(id));
    for (const id of ids) all ? w.delete(id) : w.add(id);
  });
}

// 押すと選択/解除が切り替わるボタン。選択中は枠とハイライトで示す(チェックボックスは使わない)
function pickButton(className, kind, id, onClick) {
  const b = el("button", { type: "button", className });
  b.dataset.kind = kind;
  b.dataset.id = id;
  b.addEventListener("click", onClick);
  return b;
}

// ---- ブックマークバー ----
// ブラウザ上部のブックマークバーをそのまま再現する(bookmark-set-opener の編集画面と同じ)。
// ブックマーク バー(id "1")の中身を横に並べ、ほかの最上位フォルダ(その他のブックマーク等)は右端に置く。
// ブックマークは押すと選択/解除。フォルダは押すとドロップダウンのメニューを開き、サブフォルダは右にサブメニューを出す。
// 入りきらない分はブラウザと同じく右端の「»」にしまい、押すとフォルダと同じメニューで出す。
const OVERFLOW = "overflow"; // 「»」のメニューの folderId の代わり
let overflowEntries = []; // 「»」にしまったもの(バーの並び順)

function renderBar() {
  closeMenus(0);
  const items = el("div", { className: "bmbar-items" });
  for (const e of childrenOf.get("1") ?? []) items.append(barItem(e));
  const more = el("button", { type: "button", className: "bm-chip bmbar-more", title: "入りきらないブックマーク", textContent: "»" });
  more.dataset.kind = "overflow-menu";
  more.setAttribute("aria-label", "入りきらないブックマーク");
  menuOpener(more, OVERFLOW, 0);
  const rest = el("div", { className: "bmbar-rest" });
  for (const top of childrenOf.get(null)) if (top.id !== "1") rest.append(barItem(top));
  const bar = el("div", { className: "bmbar" }, items, more, rest);
  $("picker").replaceChildren(bar);
  layoutBar();
  barObserver.disconnect();
  barObserver.observe(bar);
}

// 幅が変わるたびに、バーに収まる分だけ出す。収まらないものから後ろは全部「»」へ(ブラウザと同じく途中を飛ばさない)
const barObserver = new ResizeObserver(() => layoutBar());

function layoutBar() {
  const items = document.querySelector(".bmbar-items");
  const more = document.querySelector(".bmbar-more");
  if (!items) return;
  const chips = [...items.children];
  for (const c of chips) c.hidden = false;
  more.hidden = true;
  if (items.scrollWidth > items.clientWidth) {
    more.hidden = false; // 「»」の分だけ狭くなってから測り直す
    const limit = items.getBoundingClientRect().right;
    const first = chips.findIndex((c) => c.getBoundingClientRect().right > limit);
    for (const c of chips.slice(first)) c.hidden = true;
  }
  const entries = childrenOf.get("1") ?? [];
  const hidden = chips.flatMap((c, i) => (c.hidden ? [entries[i]] : []));
  const changed = hidden.length !== overflowEntries.length || hidden.some((e, i) => e !== overflowEntries[i]);
  overflowEntries = hidden;
  // 開いている「»」のメニューは、中身が変わったら閉じる
  if (!changed) return;
  if (openMenus[0]?.folderId === OVERFLOW) closeMenus(0);
  syncSelection();
}

function barItem(e) {
  if (e.kind === "folder") return folderMenuButton(e, "bm-chip folder", 0);
  const b = pickButton("bm-chip", "bookmark", e.id, () => toggleBookmark(e.id));
  b.title = e.title ? `${e.title}\n${e.url}` : e.url;
  // タイトルが空のブックマークは、ブラウザと同じくファビコンだけ
  b.append(favicon(e.url));
  if (e.title) b.append(span("title", e.title));
  return b;
}

// フォルダのボタン(バーの上とメニューの中で共通)。level はこのボタンが開くメニューの階層
function folderMenuButton(e, className, level) {
  const b = el("button", { type: "button", className });
  b.dataset.kind = "folder-menu";
  b.dataset.id = e.id;
  b.insertAdjacentHTML("beforeend", FOLDER_SVG);
  b.append(span("title", e.title || "(名前なし)"));
  if (level > 0) b.append(span("submenu-arrow", "›"));
  menuOpener(b, e.id, level);
  return b;
}

// 押すとメニューを開くボタンの動き(フォルダと「»」で共通)
function menuOpener(b, folderId, level) {
  const open = () => openMenu(folderId, b, level);
  let hoveredOpenAt = 0;
  b.addEventListener("click", () => {
    // バーのフォルダは押すたびに開閉する。メニューの中のフォルダは開くだけ。
    // ただし乗せただけで開いた直後のクリックでは閉じない(開いたものを押した瞬間に閉じてしまうため)
    const justHovered = Date.now() - hoveredOpenAt < 600;
    if (level === 0 && openMenus[0]?.folderId === folderId && !justHovered) closeMenus(0);
    else open();
  });
  // ブラウザと同じく、メニューの中ではマウスを乗せただけでサブメニューを開く。
  // バーの上でも、どれかのメニューを開いている間は乗せるだけで切り替える
  b.addEventListener("mouseenter", () => {
    if (level > 0 || (openMenus.length && openMenus[0].folderId !== folderId)) {
      open();
      hoveredOpenAt = Date.now();
    }
  });
}

let openMenus = []; // [{ folderId, el, anchor }] 階層の浅い順

function closeMenus(fromLevel) {
  for (const m of openMenus.splice(fromLevel)) m.el.remove();
  for (const b of document.querySelectorAll("[data-kind$=-menu].open")) {
    if (!openMenus.some((m) => m.anchor === b)) b.classList.remove("open");
  }
}

function openMenu(folderId, anchor, level) {
  if (openMenus[level]?.folderId === folderId) return;
  closeMenus(level);
  anchor.classList.add("open");

  const menu = el("div", { className: "bm-menu" });
  menu.setAttribute("role", "menu");
  const children = folderId === OVERFLOW ? overflowEntries : childrenOf.get(folderId);
  for (const e of children) {
    if (e.kind === "folder") {
      menu.append(folderMenuButton(e, "menu-item folder", level + 1));
    } else {
      const b = pickButton("menu-item", "bookmark", e.id, () => toggleBookmark(e.id));
      b.title = e.url;
      b.append(favicon(e.url), span("title", e.title || e.url));
      // ブックマークに乗ったら、それより深いサブメニューは閉じる(ブラウザと同じ)
      b.addEventListener("mouseenter", () => closeMenus(level + 1));
      menu.append(b);
    }
  }
  // 「»」はフォルダではないので「すべて選択」を付けない
  const ids = descendantsOf.get(folderId) ?? [];
  if (ids.length) {
    menu.append(el("hr", { className: "menu-sep" }));
    const all = pickButton("menu-item select-all", "select-all", folderId, () => toggleAll(ids));
    all.addEventListener("mouseenter", () => closeMenus(level + 1));
    menu.append(all);
  }

  $("menus").append(menu);
  openMenus.push({ folderId, el: menu, anchor });

  // バーのフォルダは真下に、サブメニューは親メニューの右に出す。横にはみ出すなら反対側へ。
  // 縦はブラウザと同じく常にバーより下に出し、収まらない分はメニューの中をスクロールさせる
  // (上にずらすとバーに重なって、ほかのフォルダを押せなくなる)。
  const a = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  let left, top;
  if (level === 0) {
    left = Math.min(a.left, innerWidth - w - 8);
    top = anchor.closest(".bmbar").getBoundingClientRect().bottom + 2; // ボタンではなくバーの下端から出す
  } else {
    const parent = openMenus[level - 1].el.getBoundingClientRect();
    left = parent.right + w > innerWidth - 8 ? parent.left - w : parent.right - 2;
    // サブメニューは下に収まらなければ持ち上げるが、バーのすぐ下(最初のメニューの上端)より上には出さない
    const floor = parseFloat(openMenus[0].el.style.top);
    top = Math.max(floor, Math.min(a.top - 5, innerHeight - menu.offsetHeight - 8));
  }
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${top}px`;
  menu.style.maxHeight = `${innerHeight - top - 8}px`;
  syncSelection();
}

// メニューの外を押す・Esc・スクロールで閉じる(メニューは position: fixed なので、スクロールするとずれる)
document.addEventListener("mousedown", (ev) => {
  if (openMenus.length && !ev.target.closest(".bm-menu, .bm-chip.folder, .bmbar-more")) closeMenus(0);
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && openMenus.length) closeMenus(0);
});
window.addEventListener("scroll", () => closeMenus(0));
window.addEventListener("resize", () => closeMenus(0));

// 選択状態を見た目に反映する。描き直すとメニューが閉じるので、今ある要素のクラスだけを書き換える。
//   ブックマーク: 監視中は .selected(枠とハイライト)
//   バーとメニューのフォルダ: 中(サブフォルダを含む)に監視中があれば .has-selected。「»」はしまったものの中にあれば
//   メニューの「すべて選択」: 全部選択済みなら「すべて解除」に変える
function syncSelection() {
  for (const node of document.querySelectorAll("#picker [data-kind], #menus [data-kind]")) {
    const { kind, id } = node.dataset;
    if (kind === "bookmark") {
      node.classList.toggle("selected", watched.has(id));
      node.setAttribute("aria-pressed", String(watched.has(id)));
    } else if (kind === "folder-menu") {
      node.classList.toggle("has-selected", descendantsOf.get(id).some((t) => watched.has(t)));
    } else if (kind === "overflow-menu") {
      const ids = overflowEntries.flatMap((e) => (e.kind === "folder" ? descendantsOf.get(e.id) : [e.id]));
      node.classList.toggle("has-selected", ids.some((t) => watched.has(t)));
    } else if (kind === "select-all") {
      const ids = descendantsOf.get(id);
      const all = ids.every((t) => watched.has(t));
      node.textContent = `${all ? "このフォルダをすべて解除" : "このフォルダをすべて選択"} (${ids.length})`;
    }
  }
  $("undo").disabled = undoStack.length === 0;
  $("redo").disabled = redoStack.length === 0;
  renderSelectedList();
}

// 書き換える条件の切り替え。[ドメイン] [パス] の2択で、選んでいる方を塗る
const MODE_BUTTONS = [
  { mode: "host", label: "ドメイン", title: "ドメインが変わったときだけ書き換える" },
  { mode: "any", label: "パス", title: "パスや # 以降を含め、URL が少しでも変わったら書き換える" },
];

function modeSwitch(id) {
  const current = modeOf(modes, id);
  const group = el("div", { className: "mode-switch" });
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "書き換える条件");
  for (const { mode, label, title } of MODE_BUTTONS) {
    const b = el("button", { type: "button", className: "mode-btn", textContent: label, title });
    b.dataset.mode = mode;
    b.classList.toggle("active", mode === current);
    b.setAttribute("aria-pressed", String(mode === current));
    b.addEventListener("click", () => {
      if (modeOf(modes, id) === mode) return;
      modes = { ...modes, [id]: mode };
      renderSelectedList();
      send({ type: "setMode", id, mode });
    });
    group.append(b);
  }
  return group;
}

// 監視中のブックマークの一覧(バーと同じ並び)。右端に書き換える条件と ×
function renderSelectedList() {
  const items = tree.filter((e) => e.kind === "bookmark" && watched.has(e.id));
  $("selectedHeading").textContent = `${items.length} 件を監視中`;
  $("selectedEmpty").classList.toggle("hidden", items.length > 0);
  $("selectedList").replaceChildren(
    ...items.map((item) => {
      const remove = el("button", { type: "button", className: "icon-btn danger", title: "監視を外す", innerHTML: REMOVE_ICON });
      remove.setAttribute("aria-label", "監視を外す");
      remove.addEventListener("click", () => changeWatched((w) => w.delete(item.id)));
      const li = el(
        "li",
        { className: "sel-row", title: item.url },
        favicon(item.url),
        span("title", item.title || item.url),
        span("url", item.url),
        modeSwitch(item.id),
        remove,
      );
      li.dataset.key = item.id;
      return li;
    }),
  );
}

// ---- 更新履歴 ----

const dateFormat = new Intl.DateTimeFormat("ja-JP", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function renderHistory(history) {
  const list = $("history");
  list.replaceChildren();
  if (!history.length) {
    list.append(el("li", { className: "empty", textContent: "まだ書き換えていません" }));
    return;
  }
  for (const entry of history) {
    const action = entry.undoneAt
      ? span("done", "戻し済み")
      : el("button", { type: "button", className: "button", textContent: "元に戻す" });
    if (!entry.undoneAt) {
      action.addEventListener("click", async () => {
        action.disabled = true;
        await chrome.runtime.sendMessage({ type: "undo", entryIds: [entry.id] });
      });
    }
    list.append(
      el(
        "li",
        {},
        el("div", { className: "entry-head" }, el("time", { textContent: dateFormat.format(entry.at) }), span("title", entry.title || entry.to), action),
        el("div", { className: "url from", textContent: entry.from, title: entry.from }),
        el("div", { className: "url", textContent: `→ ${entry.to}`, title: entry.to }),
      ),
    );
  }
}


// ---- 読み込みと更新 ----

async function refreshTree() {
  tree = await readTree();
  indexHierarchy();
  renderBar();
  syncSelection();
}

// background が書いた変更(ブックマークの削除で監視が外れた・書き換えで履歴が増えた)を映す。
// 保存を頼んでいる間の watched / modes は send() の最後の reconcile() に任せる
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.history) renderHistory(changes.history.newValue ?? []);
  if (pendingSaves) return;
  if (changes.watched) {
    const next = new Set(changes.watched.newValue ?? []);
    if (next.size !== watched.size || [...next].some((id) => !watched.has(id))) {
      watched = next;
      syncSelection();
    }
  }
  if (changes.modes) {
    modes = changes.modes.newValue ?? {};
    renderSelectedList();
  }
});

// ブックマークの変更でバーを作り直す(開いているメニューは閉じる)
for (const event of ["onCreated", "onRemoved", "onChanged", "onMoved"]) {
  chrome.bookmarks[event].addListener(refreshTree);
}

const state = await load();
watched = new Set(state.watched);
modes = state.modes;
renderHistory(state.history);
await refreshTree();
