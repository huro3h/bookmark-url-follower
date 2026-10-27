// ブックマークの木を表示順に平らに並べる(bookmark-set-opener の readTree と同じ形)。
// 要素は { kind: "folder" | "bookmark", id, title, url?, depth }。
// ブックマークを子孫に1つも持たないフォルダは除く。ブックマークレット(javascript:)は転送しないので出さない。
export async function readTree() {
  const [root] = await chrome.bookmarks.getTree();
  const result = [];

  function walk(node, depth) {
    const index = result.length;
    result.push({ kind: "folder", id: node.id, title: node.title, depth });
    let hasAny = false;
    for (const child of node.children) {
      if (child.children) {
        if (walk(child, depth + 1)) hasAny = true;
      } else if (child.url && !child.url.startsWith("javascript:")) {
        result.push({ kind: "bookmark", id: child.id, title: child.title, url: child.url, depth: depth + 1 });
        hasAny = true;
      }
    }
    if (!hasAny) result.splice(index);
    return hasAny;
  }

  // ルート(id "0")自体は名前がないので出さず、ブックマーク バーなどを最上位にする
  for (const top of root.children) walk(top, 0);
  return result;
}
