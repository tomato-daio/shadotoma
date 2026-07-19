# シャドとま (Shadotoma) — 設計書

英語シャドーイング練習PWA。**個人利用・ランニングコスト0円・iPhone完結**が絶対条件。
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
  id: string;                 // bundled: "voa-<記事ID>-p<part>" (例 voa-8002695-p1), local: "local-" + crypto.randomUUID()
  source: 'voa' | 'local';
  title: string;              // 表示名。分割教材は「元記事タイトル (part/partCount)」
  level: 1 | 2 | 3 | 0;       // VOAレベル。0=不明(ローカル)
  category: string;           // 例 "As It Is", "Local"
  audioUrl?: string;          // bundled: base相対 "materials/audio/xxx.mp3"（セクションごとに独立したmp3）
  audioBlob?: Blob;           // local のみ
  sentences: { en: string; ja?: string }[];  // このセクションに割り当てられた文
  durationSec?: number;
  wordCount: number;
  addedAt: number;            // epoch ms
  // ---- セクション分割（M4）----
  articleId?: string;         // 元記事のグループキー（例 "voa-8002695"）。ライブラリで同一記事をまとめて表示
  part?: number;              // 1始まりのセクション番号
  partCount?: number;         // 記事内の総セクション数
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

## 4. 練習フロー仕様（段階式シャドーイング）

練習画面はステップウィザード。教材の `MaterialProgress.daysPracticed.length`（何日目か）で推奨ステップを変える:

- **1日目**: ①リスニング（スクリプト非表示、3回聴く）→ ②スクリプト確認（英文+和訳表示、意味理解）→ ③オーバーラッピング（スクリプト表示のまま音声と同時発話、目安10回）→ ④録音・提出
- **2〜4日目**: ①シャドーイング（スクリプト非表示で音声を追いかけて発話、目安15回）→ ②録音・提出
- **録音・提出は毎日ステップの最後に必ず置く**（シャドテン同様、1日目から毎日提出できる。M4で修正済みの仕様）
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
- **シャドーイング提出（M5）**: 「録音開始」と同時にお手本音声を先頭から自動再生する（ユーザーはそれを追いかけて発話する）。**録音の停止は必ずユーザーの停止ボタン操作で行う（お手本が終わっても自動停止しない）**。お手本終了後は「お手本が終わりました。話し終えたら停止を押してください」と表示。録音中はお手本の進行バー（現在位置/総時間）を表示。録音UIに速度プリセット（0.7/0.85/1/1.15）を置き、お手本はその速度で再生（preservesPitch必須）。録り直し時も同じ挙動
- **iOS対策（M6）**: iPhone Safariではマイク許可ダイアログが出た瞬間にiOSが音声再生を一時停止し、許可後も自動では再開されない。対策: (1) クリックハンドラ内（ジェスチャ文脈）でplay()して要素をアンロックしつつ、**getUserMedia解決後に必ず先頭へ巻き戻して再play()する**（アンロック済み要素の再playはジェスチャ外でも許可される）。(2) それでも再生できない場合に備え、録音中は常に「▶ お手本を最初から流す」ボタンを表示（直接タップ＝確実に再生できる。流し直しにも使える）。(3) play()失敗はエラーにせず録音は継続
- **録音中のスクリプト表示（M6）**: 録音ステップにもスクリプト（英文）を表示/非表示トグル付きで置く。**初期値は非表示**（シャドーイングの建前）だが、ユーザーがいつでも表示に切り替えられる
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
- アプリ起動時に `materials/index.json` をfetchしIndexedDBのbundled教材を同期（追加・更新に加え、**indexから消えたbundled教材はIndexedDBからも削除**する。source:'local'の教材は決して消さない）

### 7b. 教材のセクション分割（M4）

シャドテンと同じく**1練習単位＝30〜60秒**にするため、fetch-voaは記事を「セクション」に分割して出力する:

- ffmpeg（PCにインストール済みの前提。無ければエラーで案内）の `silencedetect`（例: -35dB / 0.3秒以上）で無音区間を検出し、無音位置だけで切る
- 目標45秒・範囲30〜60秒（上限75秒）でセクション境界を選ぶ。15秒未満の端切れは隣とマージ
- 各セクションは `ffmpeg -ss/-to`（copy優先）で独立したmp3に切り出し `audio/<記事ID>-p<n>.mp3` として保存
- 文の割り当て: 記事全体の語数比で各文の推定時刻を出し、文の中点が入るセクションに割り当てる（全文を漏れなく1回ずつ・順序維持）。無音＝文境界に近いVOAの読み上げ特性を利用した近似
- index.jsonには分割後のセクションのみを載せる（元の長尺教材は載せない）。id/articleId/part/partCountは§3の通り

## 8. 添削エンジン（M3）

`src/features/judge/`

1. 提出音声Blob → AudioContext.decodeAudioData → 16kHzモノラルFloat32へリサンプル
2. transformers.js の `automatic-speech-recognition` パイプライン（`onnx-community/whisper-tiny.en` 量子化, 常にWASM。dtype:'q4'固定。dtype:'q8'はこのtransformers.js/onnxruntime-webの組み合わせだとセッション生成が`Missing required scale ... MatMulNBits`エラーで失敗するため使用不可と判明し、q4に変更した。WebGPU実行プロバイダにも対応する量子化カーネルが無いため使用しない）で文字起こし。モデルは初回DL後キャッシュ（Cache API）。ONNX Runtime WebのWASM実行は数分間メインスレッドをブロックしうる（iPhone Safari等で無応答ページとして強制終了されうる）ため、実処理は`whisper.worker.ts`（module worker）内で行い、UIスレッドをブロックしない
3. 整列: スクリプト語列 vs 認識語列を正規化（小文字化・約物除去・数字/短縮形の揺れ吸収）して Needleman-Wunsch（一致+1/不一致-1/ギャップ-1程度）で単語アライン → wordMarks生成。`src/lib/align.ts` 純関数・**Vitest必須**
4. スコア: matchRate、WPM（認識語数/録音秒×60）
5. Good/Development Point各3件をルールベース生成（例: 最長連続一致区間、前回提出比の改善、missedが集中した文とその文頭語、速度がお手本比±15%以内か等）。`src/lib/feedback.ts` 純関数・Vitestテスト
6. 失敗時フォールバック: モデルDL失敗/実行エラー時は「AIに詳しく添削してもらう」（スクリプト+状況を定型プロンプトでクリップボードコピー→ChatGPT/Claudeに貼る）だけを表示
7. 判定結果画面: 色分けスクリプト（ok=緑/missed=赤/sub=黄）、スコア、Good/Dev Points、過去提出との比較

## 8b. 確認テスト（穴埋め・M5）

シャドテンの「Dailyプチテスト」に相当する、聴き取り穴埋めテスト。`src/features/quiz/`、ルート `/quiz/:articleId`。

- **セクションの完了(done)遷移**（前提。未実装だったものをここで定義）: 提出の judge.matchRate ≥ 0.85、または4日目の練習完了時に `MaterialProgress.status = 'done'`
- **出題**: 対象記事内で status='done' のセクションから直近最大3つ。セクションごとに: 音声プレーヤー（何度でも再生可・速度変更可）＋スクリプト表示。スクリプトの一部の語を穴埋め（空欄）にする
  - 空欄の選び方: 内容語（英字4文字以上、the/and/that等のストップワード除外）から無作為に、1文あたり最大2箇所・セクションあたり3〜6箇所
- **解答**: 空欄はテキスト入力。判定は align.ts の正規化（小文字化・約物除去・数字/短縮形の揺れ）を再利用し、正規化後一致で正解
- **結果**: 「8/10 正解」形式で表示し、間違えた箇所は正答を表示。IndexedDBの新store `quizResults` に保存:
  `{ id, articleId, date, sectionIds: string[], total, correct, createdAt }`（DBバージョンを上げてupgradeで追加）
- **導線**: 教材タブの記事グループヘッダーに「確認テスト」ボタン（doneセクションが1つ以上で活性、0なら「セクションを完了すると挑戦できます」）。記事内のdoneセクションが3の倍数に達した直後は今日タブでも提案
- 進捗ページに最近のテスト結果（日付・記事・スコア）を数件表示

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
