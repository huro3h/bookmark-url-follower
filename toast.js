// ページに差し込むトースト。scripting.executeScript の func として渡すので、
// 外の変数や import を参照しない(関数の本体だけがシリアライズされてページで動く)。
export function showToast({ titles, to, entryIds }) {
  const HOST_ID = "bookmark-url-follower-toast";
  const DISMISS_MS = 10000;

  document.getElementById(HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .toast {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      box-sizing: border-box; width: min(380px, calc(100vw - 32px));
      padding: 12px 14px; border-radius: 10px;
      background: #ffffff; color: #1f2330; border: 1px solid #e5e7eb;
      box-shadow: 0 6px 24px rgba(0, 0, 0, .18);
      font: 13px/1.5 -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif;
      transition: opacity .2s, transform .2s;
    }
    .toast.hidden { opacity: 0; transform: translateY(8px); }
    .head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
    .head span { flex: 1; }
    .title, .url { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .title { margin-top: 4px; }
    .url { color: #6b7280; font-size: 12px; }
    .actions { display: flex; justify-content: flex-end; margin-top: 8px; }
    button { font: inherit; cursor: pointer; border-radius: 6px; }
    .undo { padding: 4px 12px; border: 1px solid #1a73e8; background: transparent; color: #1a73e8; }
    .undo:hover { background: #e8f0fe; }
    .undo:disabled { cursor: default; opacity: .6; }
    .close { padding: 0 4px; border: 0; background: transparent; color: #6b7280; font-size: 16px; line-height: 1; }
    @media (prefers-color-scheme: dark) {
      .toast { background: #1b1e27; color: #e8eaf0; border-color: #333846; }
      .url, .close { color: #9aa0ad; }
      .undo { border-color: #5b9cf8; color: #5b9cf8; }
      .undo:hover { background: #1f2c44; }
    }
  `;

  const toast = document.createElement("div");
  toast.className = "toast hidden";
  toast.setAttribute("role", "status");

  const head = document.createElement("div");
  head.className = "head";
  const message = document.createElement("span");
  message.textContent = "ブックマークの URL を更新しました";
  const close = document.createElement("button");
  close.className = "close";
  close.textContent = "×";
  close.title = "閉じる";
  head.append(message, close);

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = titles.length > 1 ? `${titles[0]} ほか ${titles.length - 1} 件` : titles[0];

  const url = document.createElement("div");
  url.className = "url";
  url.textContent = `→ ${to}`;
  url.title = to;

  const actions = document.createElement("div");
  actions.className = "actions";
  const undo = document.createElement("button");
  undo.className = "undo";
  undo.textContent = "元に戻す";
  actions.append(undo);

  toast.append(head, title, url, actions);
  root.append(style, toast);
  document.documentElement.append(host);
  requestAnimationFrame(() => toast.classList.remove("hidden"));

  let timer;
  const dismiss = () => {
    toast.classList.add("hidden");
    setTimeout(() => host.remove(), 250);
  };
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(dismiss, ms);
  };
  toast.addEventListener("mouseenter", () => clearTimeout(timer));
  toast.addEventListener("mouseleave", () => arm(DISMISS_MS));
  close.addEventListener("click", dismiss);
  undo.addEventListener("click", async () => {
    undo.disabled = true;
    try {
      const { restored } = await chrome.runtime.sendMessage({ type: "undo", entryIds });
      message.textContent = restored ? "元の URL に戻しました" : "戻せませんでした(ブックマークが見つかりません)";
      undo.remove();
    } catch {
      message.textContent = "戻せませんでした(拡張が更新された可能性があります)";
    }
    arm(2500);
  });
  arm(DISMISS_MS);
}
