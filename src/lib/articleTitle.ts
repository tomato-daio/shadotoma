/**
 * 分割教材（DESIGN.md §7b）のタイトル表記ユーティリティ。
 * Material.title は分割教材だと「元記事タイトル (part/partCount)」形式なので、
 * 末尾のこの部分を取り除いて記事見出しにする。教材タブ・進捗タブ・確認テスト画面で共通して使う。
 */

const SECTION_TITLE_SUFFIX_RE = /\s*\(\d+\/\d+\)\s*$/;

export function articleHeadingTitle(title: string): string {
  return title.replace(SECTION_TITLE_SUFFIX_RE, '');
}
