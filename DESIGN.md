# シャドとま (Shadotoma) — 設計書

シャドテン風の英語シャドーイング練習PWA。**個人利用・ランニングコスト0円・iPhone完結**が絶対条件。
この文書が実装の正本。実装エージェントはこの仕様に従うこと。

## 0. 絶対ルール

- 個人情報（本名・実年齢・勤務先・個人メール）をコード・コメント・package.json author等に一切書かない。作者名義は `tomato-daio`。
- 学習データ・録音・取り込み教材は**端末内(IndexedDB)のみ**。外部送信するコードを書かない。
- リポジトリに同梱してよい教材はパブリックドメイン（VOA Learning English）のみ。ユーザーがローカル取り込みした音源（TED等）は絶対にリポジトリへ入れない。
- 依存は最小限。指定スタック以外のランタイム依存を勝手に追加しない。

## 1. 技術スタック

| 項目 | 選定 |
|---|---|
| ビルド | Vite 7 + React 18 + TypeScript (strict) |
| スタイル | Tailwind CSS v4（@tailwindcss/vite プラグイン方式） |
| PWA | vite-plugin-pwa（autoUpdate、オフラインキャッシュ） |
| 状態管理 | Zustand |
| 永続化 | IndexedDB（idb ライブラリ） |
| テスト | Vitest（ロジックモジュールは必須。UIテストは不要） |
| 添削STT | @huggingface/transformers（transformers.js）+ Whisper tiny.en 量子化（M3で導入） |

- GitHub Pages 配信のため `vite.config.ts` の `base` は `/shadotoma/`（`npm run dev` 時は `/`）。
- モバイル(iPhone Safari)ファースト。画面幅 375px 基準、下タブナビゲーション。
- 音声再生は `HTMLAudioElement`（playbackRate 使用時は `preservesPitch = true`）。録音は `MediaRecorder`。
  - iPhone Safari の録音は `audio/mp4`(aac)、Chrome/Edge は `audio/webm`(opus)。`MediaRecorder.isTypeSupported` で選択し、Blobの実際のmimeTypeをそのまま保存・再生に使う（変換しない）。

## 2. 画面構成（下タブ4つ）

1. **今日** (`/`) — 進行中教材と今日のステップ表示、練習開始ボタン、連続日数バッジ
2. **教材** (`/materials`) — 教材ライブラリ（レベル・カテゴリでフィルタ）、ローカル取り込み
3. **進捗** (`/progress`) — 連続日数カレンダー、提出履歴、スコア推移
4. **設定** (`/settings`) — データのエクスポート/インポート、アプリ情報

練習画面 (`/practice/:materialId`) はタブの上に全画面で開く。ルーティングは react-router-dom（HashRouter — GitHub Pagesでのリロード404回避）。

## 3. データモデル（IndexedDB: DB名 `shadotoma`, idbで管理）

```ts
// store: materials（教材メタ。音声本体は bundled=URL参照 / local=audioBlob保存）
interface Material {
  id: string;                 // bundled: "voa-xxxx", local: "local-" + crypto.randomUUID()
  source: 'voa' | 'local';
  title: string;
  level: 1 | 2 | 3 | 0;       // VOAレベル。0=不明(ローカル)
  category: string;           // 例 "As It Is", "Local"
  audioUrl?: string;          // bundled: base相対 "materials/audio/xxx.mp3"
  audioBlob?: Blob;           // local のみ
  sentences: { en: string; ja?: string }[];  // 文分割済みスクリプト
  durationSec?: number;
  wordCount: number;
  addedAt: number;            // epoch ms
}

// store: sessions（練習1回=1レコード。回数カウントの元データ）
interface PracticeSession {
  id: string;
  materialId: string;
  date: string;               // "YYYY-MM-DD"（その日の学習日。日付切替は午前3時: 3時前は前日扱い）
  step: 'listening' | 'script' | 'overlapping' | 'shadowing';
  loops: number;              // このセッションで再生し切った回数
  startedAt: number;
}

// store: submissions（提出=録音+添削結果）
interface Submission {
  id: string;
  materialId: string;
  date: string;               // sessionsと同じ日付規則
  audioBlob: Blob;
  mimeType: string;
  transcript?: string;        // Whisper文字起こし（M3）
  judge?: JudgeResult;        // 添削結果（M3）
  createdAt: number;
}

// JudgeResult（M3で実装。型だけ先に定義しておく）
interface JudgeResult {
  matchRate: number;          // 0-1 スクリプト語のうち言えた割合
  wpm: number;
  wordMarks: { word: string; si: number; status: 'ok' | 'missed' | 'sub' }[]; // si=文index
  goodPoints: string[];       // 3件
  devPoints: string[];        // 3件
  engine: 'whisper-local' | 'manual';
}

// store: materialProgress（教材ごとの通算状況）
interface MaterialProgress {
  materialId: string;         // keyPath
  daysPracticed: string[];    // 練習した日付の配列（"何日目"= length）
  totalLoops: number;
  lastStep: PracticeSession['step'];
  status: 'not-started' | 'active' | 'done';
}

// store: appState（key-value: streak計算はsubmissions/sessionsから導出、設定値など）
```

日付ユーティリティ `src/lib/dates.ts` : `learningDate(now: Date): string`（午前3時切替）、連続日数計算 `calcStreak(dates: string[], today: string): number`。**純関数にしてVitestでテスト**。

## 4. 練習フロー仕様（シャドテン式）

練習画面はステップウィザード。教材の `MaterialProgress.daysPracticed.length`（何日目か）で推奨ステップを変える:

- **1日目**: ①リスニング（スクリプト非表示、3回聴く）→ ②スクリプト確認（英文+和訳表示、意味理解）→ ③オーバーラッピング（スクリプト表示のまま音声と同時発話、目安10回）
- **2〜4日目**: ④シャドーイング（スクリプト非表示で音声を追いかけて発話、目安15回）→ ⑤録音・提出
- 4日目終了時（または matchRate ≥ 0.85 のとき）「次の教材へ進みましょう」を提案（マンネリ防止）

ステップはあくまでガイド。ユーザーは自由にスキップ/戻り可能。ループ再生完了ごとに回数を自動カウントし「10回中3回」のように表示。

## 5. プレーヤー仕様（M1）

`src/features/player/`（AudioPlayerクラス + usePlayerフック + PlayerUI）

- 再生/停止、シークバー、現在時間/総時間
- 速度: 0.5〜2.0を0.05刻み（UIはプリセット 0.7/0.85/1.0/1.15 + スライダー）、preservesPitch必須
- 3秒巻き戻しボタン
- ABリピート: 「A設定」「B設定」「解除」。timeupdateで currentTime>B なら A へ戻す（timeupdate粒度が粗いため ±0.25s 許容でよい）
- ループ再生: ended時に自動で先頭から再再生し、ループ回数をコールバック通知
- スクリプト表示/非表示トグル（ステップに応じた初期値、手動切替可）

## 6. 録音・聴き比べ仕様（M1）

`src/features/recorder/`

- マイク許可 → MediaRecorderで録音開始/停止。録音中は経過秒とレベルメーター（AnalyserNodeの簡易表示）
- 「イヤホンをつけて、お手本を流しながら録音しましょう」の注意表示（イヤホン無しだとお手本音声が録音に混入するため）
- 録音直後: 自分の録音を再生 / お手本を再生 の切替ボタン（聴き比べ）。録り直し可
- 「提出」ボタンで submissions に保存（M1時点では添削なし=保存と履歴表示のみ。M3で添削接続）

## 7. VOA教材パイプライン（M2）

`scripts/fetch-voa.mjs`（Node 24, 依存追加可: なし想定。fetch+正規表現/簡易DOMで）

- 対象: VOA Learning English（learningenglish.voanews.com）。米国政府制作＝パブリックドメイン
- RSSまたはセクションページから記事を取得 → 記事HTML内の音声mp3 URLとトランスクリプト本文を抽出
- 文分割（略語 Mr./U.S. 等を考慮した regex ベース。`src/lib/sentences.ts` に置きVitestテスト）
- 出力: `public/materials/index.json`（Material[] のメタ、audioUrlは相対パス）+ `public/materials/audio/*.mp3`
- 実行例: `npm run fetch-voa -- --level 1 --count 5`。既存index.jsonへ追記（重複URLはスキップ）
- 記事下部の定型文（"I'm Dan Friedell." 等の署名、Words in This Story等）はスクリプトから除外してよいが、除外しすぎに注意
- アプリ起動時に `materials/index.json` をfetchしIndexedDBのbundled教材を同期（追加・更新のみ、削除はしない）

## 8. 添削エンジン（M3）

`src/features/judge/`

1. 提出音声Blob → AudioContext.decodeAudioData → 16kHzモノラルFloat32へリサンプル
2. transformers.js の `automatic-speech-recognition` パイプライン（`onnx-community/whisper-tiny.en` 量子化, 常にWASM。dtype:'q8'固定のためWebGPU実行プロバイダには非対応カーネルがあり使用しない）で文字起こし。モデルは初回DL後キャッシュ（Cache API）
3. 整列: スクリプト語列 vs 認識語列を正規化（小文字化・約物除去・数字/短縮形の揺れ吸収）して Needleman-Wunsch（一致+1/不一致-1/ギャップ-1程度）で単語アライン → wordMarks生成。`src/lib/align.ts` 純関数・**Vitest必須**
4. スコア: matchRate、WPM（認識語数/録音秒×60）
5. Good/Development Point各3件をルールベース生成（例: 最長連続一致区間、前回提出比の改善、missedが集中した文とその文頭語、速度がお手本比±15%以内か等）。`src/lib/feedback.ts` 純関数・Vitestテスト
6. 失敗時フォールバック: モデルDL失敗/実行エラー時は「AIに詳しく添削してもらう」（スクリプト+状況を定型プロンプトでクリップボードコピー→ChatGPT/Claudeに貼る）だけを表示
7. 判定結果画面: 色分けスクリプト（ok=緑/missed=赤/sub=黄）、スコア、Good/Dev Points、過去提出との比較

## 9. ディレクトリ構成

```
shadotoma/
  DESIGN.md
  package.json / vite.config.ts / tsconfig.json / index.html
  scripts/fetch-voa.mjs
  public/materials/{index.json, audio/*.mp3}
  src/
    main.tsx / App.tsx（HashRouter+タブレイアウト）
    lib/{db.ts, dates.ts, sentences.ts, align.ts, feedback.ts, audio.ts}
    stores/（zustand: usePracticeStore など）
    features/
      player/  recorder/  materials/  practice/  judge/  progress/  settings/
    pages/{TodayPage, MaterialsPage, ProgressPage, SettingsPage, PracticePage}.tsx
  tests/（またはsrc内 *.test.ts。lib配下の純関数は必ずテスト）
  .github/workflows/deploy.yml（M3: Pages公開）
```

## 10. マイルストーン分割

- **M1**: 雛形（Vite+TS+Tailwind+PWA+router+タブUI）、db.ts/dates.ts、プレーヤー、録音・聴き比べ、提出保存（添削なし）。開発確認用に「音声ファイルを開く」で一時教材を作れること
- **M2**: fetch-voa.mjs、sentences.ts、教材ライブラリUI、ローカル取り込み（永続化）、練習フローウィザード、セッション記録
- **M3**: judge一式（whisper/align/feedback）、判定結果画面、進捗ページ（カレンダー・スコア推移）、エクスポート/インポート、deploy.yml

## 11. 検収基準（共通）

- `npm run build` と `npm test` がエラーゼロで通る
- PC Chrome/Edgeで動作（iPhone実機はユーザー検収）
- console.errorが出ない。TypeScript strictでany乱用しない
