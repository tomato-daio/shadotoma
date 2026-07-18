/**
 * Whisperモデルのダウンロード・実行に失敗した場合のフォールバック
 * （DESIGN.md §8手順6: 「AIに詳しく添削してもらう」ボタン）。
 *
 * スクリプト全文と自己申告の状況を定型プロンプトにまとめ、クリップボードへコピーする。
 * 外部へは一切送信しない（ユーザー自身がChatGPT/Claude等に貼り付けて使う想定）。
 */

export interface FallbackPromptInput {
  materialTitle: string;
  sentences: { en: string }[];
  /** 「モデルのダウンロードに失敗しました」等、失敗理由の自己申告テキスト。 */
  situation: string;
}

export function buildFallbackPrompt({ materialTitle, sentences, situation }: FallbackPromptInput): string {
  const script = sentences.map((s) => s.en).join(' ');
  return [
    '英語シャドーイング練習の自己添削をお願いします。',
    '',
    `【教材】${materialTitle}`,
    '【スクリプト（お手本の原文）】',
    script,
    '',
    `【状況】${situation}`,
    '',
    '上記スクリプトをお手本として、私がどれくらい正確に発話できていたかを見積もったうえで、',
    '良かった点を3つ、改善点を3つ、それぞれスクリプト中の具体的な文を挙げながら教えてください。',
  ].join('\n');
}

/** テキストをクリップボードへコピーする。失敗時はfalseを返す（例外は投げない）。 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
