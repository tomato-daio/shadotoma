# シャドとま (Shadotoma) — 設計書

英語シャドーイング練習PWA。**個人利用・ランニングコスト0円・iPhone完結**が絶対条件。
この文書が実装の正本。実装エージェントはこの仕様に従うこと。

## 0. 絶対ルール

- 個人情報（本名・実年齢・勤務先・個人メール）をコード・コメント・package.json author等に一切書かない。作者名義は `tomato-daio`。
- 学習データ・録音・取り込み教材は**端末内(IndexedDB)のみ**。外部送信するコードを書かない。**唯一の例外はAzure発音評価（§8c・M9）**: ユーザーが自分のAPIキーを設定した場合に限り、採点対象の提出音声とスクリプトのみをAzure Speechへ送信してよい（それ以外の音声・データは決して送らない）。
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
  sentences: { en: string; ja?: string; vocab?: { term: string; ja: string }[] }[];  // このセクションの文（ja/vocabはM14のクリップボード往復取り込みで後付け）
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
- ABリピート: 「A設定」「B設定」「解除」。timeupdateで currentTime>B なら A へ戻す（timeupdate粒度が粗いため ±0.25s 許容でよい）。**A≧B・0.5s未満の退化区間はAB無効扱い**（M14: timeupdate毎にAへ戻り続けるライブロック防止）
- ループ再生: ended時に自動で先頭から再再生し、ループ回数をコールバック通知。**再開位置は検証する**（M14: A地点が末尾から0.5s未満なら0秒へフォールバック。加えて直前の自動再開から0.5s未満のendedでは再生を再開しない。A地点末尾での「ended→即ended」暴走でカウントが一瞬で数十〜100に達したバグの対策）
- スクリプト表示/非表示トグル（ステップに応じた初期値、手動切替可）

## 6. 録音・聴き比べ仕様（M1）

`src/features/recorder/`

- マイク許可 → MediaRecorderで録音開始/停止。録音中は経過秒とレベルメーター（AnalyserNodeの簡易表示）
- **シャドーイング提出（M5）**: 「録音開始」と同時にお手本音声を先頭から自動再生する（ユーザーはそれを追いかけて発話する）。**録音の停止は必ずユーザーの停止ボタン操作で行う（お手本が終わっても自動停止しない）**。お手本終了後は「お手本が終わりました。話し終えたら停止を押してください」と表示。録音中はお手本の進行バー（現在位置/総時間）を表示。録音UIに速度プリセット（0.7/0.85/1/1.15）を置き、お手本はその速度で再生（preservesPitch必須）。録り直し時も同じ挙動
- **iOS対策（M6）**: iPhone Safariではマイク許可ダイアログが出た瞬間にiOSが音声再生を一時停止し、許可後も自動では再開されない。対策: (1) クリックハンドラ内（ジェスチャ文脈）でplay()して要素をアンロックしつつ、**getUserMedia解決後に必ず先頭へ巻き戻して再play()する**（アンロック済み要素の再playはジェスチャ外でも許可される）。(2) それでも再生できない場合に備え、録音中は常に「▶ お手本を最初から流す」ボタンを表示（直接タップ＝確実に再生できる。流し直しにも使える）。(3) play()失敗はエラーにせず録音は継続
- **録音中のスクリプト表示（M6）**: 録音ステップにもスクリプト（英文）を表示/非表示トグル付きで置く。**初期値は非表示**（シャドーイングの建前）だが、ユーザーがいつでも表示に切り替えられる
- **画面スリープ防止（M11）**: 録音中および提出の添削処理中は Screen Wake Lock API（`navigator.wakeLock.request('screen')`）で画面の自動ロックを防ぐ（iOSは画面ロックで録音・処理が止まるため）。録音開始/提出開始で取得、停止・完了・エラー・アンマウントで解放。`visibilitychange` で復帰時に再取得。API非対応環境では黙ってスキップ（機能に影響させない）
- **iOSオーディオセッション対策（M7）**: iPhone実機で「④到着後の初回録音開始で即停止、③で再生してから戻ると正常」という現象が確認された。原因はgetUserMedia直後にHTMLAudioElementの再生を始めるとiOSがオーディオセッションを再構成し、マイクトラックを終了させるため。対策: (1) お手本再生を録音用と同一のAudioContextに一本化する（MediaElementAudioSourceNode→destination。レベルメーターのAnalyserと同じContextを使い、生成後にresume()する）。(2) 録音中にマイクトラックの ended/mute を検知したら、UIを固まらせず「マイクがOSに停止されました。もう一度録音開始を押してください」を表示して後始末する。(3) 手動▶ボタンは維持
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
- **文割り当ての実測補正（M11）**: 語数比の近似は末尾文がずれることがある（実機で「音声に無い文がスクリプトに載る」報告あり）。`scripts/fix-sentence-alignment.mjs` で全セクションを補正する: 各セクション音声の**末尾約12秒**をWhisper（transformers.jsのNode実行・tiny.en）で文字起こしし、認識された最後の語群と文末の語群を正規化して照合し「実際に読まれている最後の文」を特定 → 文ポインタを進めながら各セクションに再割り当てする（探索窓は推定位置±3文。全文保存・順序維持・欠落/重複ゼロをスクリプト内で検証）。実行はPC側1回・index.jsonを再生成（教材IDは不変。アプリの削除同期で全端末に反映）
- index.jsonには分割後のセクションのみを載せる（元の長尺教材は載せない）。id/articleId/part/partCountは§3の通り

## 8. 添削エンジン（M3）

`src/features/judge/`

1. 提出音声Blob → AudioContext.decodeAudioData → 16kHzモノラルFloat32へリサンプル
2. transformers.js の `automatic-speech-recognition` パイプライン（常にWASM。dtype:'q4'固定。dtype:'q8'はこのtransformers.js/onnxruntime-webの組み合わせだとセッション生成が`Missing required scale ... MatMulNBits`エラーで失敗するため使用不可と判明し、q4に変更した。WebGPU実行プロバイダにも対応する量子化カーネルが無いため使用しない）で文字起こし。モデルは初回DL後キャッシュ（Cache API）。ONNX Runtime WebのWASM実行は数分間メインスレッドをブロックしうる（iPhone Safari等で無応答ページとして強制終了されうる）ため、実処理は`whisper.worker.ts`（module worker）内で行い、UIスレッドをブロックしない
   - **モデル選択（M8）**: 設定ページで「高精度（`onnx-community/whisper-base.en`、初期値）/ 標準（`onnx-community/whisper-tiny.en`・高速）」を切替。選択は appState に保存し、判定・自己テスト双方が参照。baseはtiny比で認識誤りが目に見えて減るが、処理時間は約2倍・初回DLも大きい。切替時はワーカーのパイプラインを作り直して次回文字起こしから反映
3. 整列: スクリプト語列 vs 認識語列を正規化（小文字化・約物除去・数字/短縮形の揺れ吸収）して Needleman-Wunsch（一致+1/不一致-1/ギャップ-1程度）で単語アライン → wordMarks生成。`src/lib/align.ts` 純関数・**Vitest必須**
4. スコア: matchRate、WPM。**WPMの分母は録音全体ではなく発話区間（M10）**: 録音PCMの先頭・末尾の無音（エネルギーしきい値ベース、例: RMS窓で最大値の3%未満が続く区間）を除いた「最初に声が出た時刻〜最後に声が出た時刻」を使う。冒頭のBGM中の待ち時間や停止ボタンまでの空白でWPMが過小になるのを防ぐ。`src/lib/audio.ts` か専用モジュールに純関数 `speechBounds(pcm, sampleRate)` として置き**Vitestテスト必須**（無音のみ・先頭無音・末尾無音・全区間発話のケース）。判定結果画面のWPM注記も「発話区間ベース」に更新
5. Good/Development Point各3件をルールベース生成（例: 最長連続一致区間、前回提出比の改善、missedが集中した文とその文頭語、速度がお手本比±15%以内か等）。`src/lib/feedback.ts` 純関数・Vitestテスト

### 5b. 音声現象ベースの指摘と前回比較（M7）

シャドテンの添削に寄せ、Development Pointを「どの音声現象がどの語でできていないか」の名指しにする。

- **検出器** `src/lib/phenomena.ts`（純関数・Vitestテスト必須）: スクリプト文と wordMarks から、以下の音声現象に関わる箇所を検出し、missed/subと突き合わせて「できていない候補」を挙げる:
  - リンキング（連結）: 子音終わり語+母音始まり語のペア（例: turned on → ターンドン）でどちらかが missed/sub
  - フラップ: 母音に挟まれた t/tt を含む語（water, better, got a）が missed/sub（例: water → ワラのような音）
  - 脱落（エリジョン）: 語末破裂音+子音始まり語（next day, just now）のペアで missed
  - 弱形: 機能語（of, to, for, and, them, can等）の missed（弱く速く発音される語）
  - 語尾の -s/-ed: sub で語幹が一致し語尾だけ違う（wanted→want）
- **JudgeResult拡張**: `issues: { type: 'linking'|'flap'|'elision'|'weak'|'ending'; words: string[]; si: number }[]` を追加保存（既存データはissues無しでも壊れないようoptional）
- **Development Point生成**: 検出結果を優先度順（同一typeの多発 > 単発）に**毎回3件へ絞り**、ヒント付き文言で出す
- **文言は必ずその教材の実際の語から組み立てる（M8）**: 固定の例文（turned on→ターンドン等）を教材と無関係に使い回してはならない。ヒントの構成: (1) 検出された実際の語（同typeが複数あれば最大2ペア列挙）、(2) つながる/落ちる実際の音を文字で示す（例: 「picked it」は d と i がつながります）、(3) カタカナヒントは「頻出語の辞書（約60語＋機能語ペア）にある場合」と「単純な綴りで機械変換の信頼度が高い場合」のみ付け、無理な自動変換はしない（誤ったカタカナを出すくらいなら文字ベースの説明だけにする）
- **前回比較**: 同一教材の前回提出の issues と比較し、判定結果画面に「前回の指摘」欄を出す: 前回指摘の語が今回 ok → 「✅ 改善」、まだ missed/sub → 「△ もう一歩」。Good Pointにも「前回指摘の◯◯が改善」を優先的に採用
- 検出はあくまでスクリプト文字列＋認識結果からのヒューリスティック（音素解析はしない）。断定調を避け「〜の可能性」の文言にはしない（シャドテン同様言い切るが、対象語を明示して根拠を示す）
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

## 8c. Azure発音評価（M9・任意機能）

シャドテンのプロ添削に最も近づく「音素レベルの発音採点」。**完全に付加的**な機能とし、キー未設定・エラー時も既存のWhisper採点は一切影響を受けない。

- **依存追加（指定）**: `microsoft-cognitiveservices-speech-sdk`（Microsoft公式・本件のための唯一の追加。60秒超音声に対応するためRESTではなくSDKを使う）
- **設定**（設定ページ「発音スコア（Azure・任意）」セクション）:
  - APIキー入力（type=password）・リージョン選択（japaneast初期値/japanwest/eastus/westus/southeastasia）・「接続テスト」（issueTokenエンドポイントでキー検証）・「削除」
  - 保存先は appState（keys: 'azureSpeechKey' / 'azureSpeechRegion'）。**端末内のみ**
  - 説明文: 無料枠は月5時間で毎日数分なら0円 / 送信されるのは採点する提出音声とスクリプトのみ / キーは端末内にのみ保存
  - **backup.tsのエクスポートからazureSpeechKeyを除外**（バックアップファイル共有時のキー漏えい防止。restore時も上書きしない）
- **採点フロー**: 提出時、キーが設定されていればWhisper採点の後に実行（進捗表示「発音スコア取得中…」）。
  - PronunciationAssessmentConfig: referenceText=セクション全文、GradingSystem=HundredMark、Granularity=Phoneme、EnableProsodyAssessment、enableMiscue=true。SpeechConfigの `speechRecognitionLanguage='en-US'` を明示
  - **プロソディ・フォールバック（M10）**: 韻律採点はリージョンにより未対応の場合がある（東日本で失敗報告あり）。韻律有効で失敗（キャンセル/エラー）した場合は**韻律なし設定で1回だけ自動リトライ**し、成功したらprosodyScoreなしで保存・表示（カードの韻律欄は「―」）。両方失敗した場合のみエラー扱い
  - **エラー詳細（M10）**: 失敗時は汎用文言に加え、SDKのcancellation errorDetails（先頭120字程度）を `azureError` に含めて表示する（原因特定を可能にする）
  - 音声は decodeToMono16k の結果をWAV(16kHz mono PCM16)化して pushStream で送る。60秒超に対応するため continuous recognition で最後まで処理し、複数結果はスコアを長さ加重で統合
  - 結果は `JudgeResult.azure?: { pronScore, accuracyScore, fluencyScore, prosodyScore, completenessScore, words: { word, accuracyScore, errorType }[] }` としてSubmissionに保存（optional・後方互換）
- **表示**（判定結果画面）: 「発音スコア」カード＝総合/正確さ/流暢さ/韻律/完全性（0-100、80以上=緑/60-79=黄/60未満=赤）。スコアの低い単語ワースト5（点数付き）。エラー時は1行メッセージ（キー無効・ネットワーク等）のみ表示しWhisper結果は通常表示
- **Azureコメント（M12）**: Azureの詳細データから日本語の短いコメントを最大3件、ルールベースで生成しカード内に表示する。
  - 取得データの拡張: 応答パース時に (a) 単語ごとの**音素スコア**（Phoneme granularity応答のWords[].Phonemes）を集計し、低スコア音素トップ（音素記号・平均点・該当語の例最大2つ）を `AzurePronunciationResult.weakPhonemes?: { phoneme: string; avgScore: number; examples: string[] }[]`（上位3件）として保存、(b) プロソディのFeedback（UnexpectedBreak/MissingBreak/Monotoneの件数）を `prosodyFeedback?: { unexpectedBreaks: number; missingBreaks: number; monotone: boolean }` として保存（いずれもoptional・後方互換）
  - コメント生成 `src/features/judge/azureComments.ts`（純関数・**Vitestテスト必須**）: 優先度順に最大3件 — ①低スコア音素（平均60点未満）: **手書きの音素アドバイス辞書**（日本人の苦手音15種程度: r, l, θ, ð, v, f, w, æ, ʌ, ə, ɜː, ɪ/iː, s/ʃ, 語末子音など。カタカナ+口の動きのコツを人手で執筆。辞書に無い音素は記号と例語のみでコツ文なし）から「◯の音が苦手です（例語 点数）: コツ」形式で生成、②流暢さ<75 かつ unexpectedBreaks>0: 「不要な間がN箇所…」、③monotone or 韻律<70: 「抑揚が平坦気味…」、④completeness<80: 「読み飛ばしがあります…」。該当なしなら「発音は安定しています」等の肯定コメント1件
  - 過去データ（weakPhonemes等が無い提出）ではコメント欄を出さない（後方互換）
- **進捗ページ**: 発音総合スコア（pronScore）の推移を一致率グラフに第2系列として追加（簡易でよい）
- WAVエンコードとスコア統合・応答パースは純関数化してVitestテスト（API呼び出し自体はモック不要・手動検証）

## 8d. 弱点分析とパーソナライズ推薦（M13）

提出データを「弱点プロファイル」に集約し、教材推薦へつなげる適応ループ。新storeは作らず提出データから都度導出する。

- **教材メタの音素情報**: `scripts/annotate-phonemes.mjs`（新規）が CMUdict（パブリックドメイン・PCで1回DL・リポジトリには辞書本体を含めずキャッシュ利用）で全セクションの語を音素列化し、**対象15音素（M12の音素アドバイス辞書と同一キー体系）の出現数** `phonemeCounts?: Record<string, number>` を index.json の各セクションへ追記（音声・文・IDは不変）。fetch-voa 完了時にも自動実行
- **弱点プロファイル** `src/features/insights/weakness.ts`（純関数・Vitestテスト必須）: `buildWeaknessProfile(submissions, quizResults)` →
  - 苦手音素: Azure音素スコアの時間減衰加重平均（半減期10提出）で低スコア音素を抽出、傾向（改善中/停滞）付き。直近平均75以上になったら「克服」扱い
  - 苦手現象: issuesの指摘頻度 ×**未改善率**（1−previousIssueOutcomesの改善割合。下限0.1）。「頻繁に指摘され、かつ改善できていない現象」が最優先（M13検収時に確定）
  - 苦手単語: missed/sub/Azure低スコア語/クイズ誤答が2回以上重なった語（normalizeWord正規化で同一視）
- **見える化**: 進捗タブに「苦手分析」セクション＝苦手音トップ3（M12辞書のコツ文を再利用）・苦手現象・繰り返し間違う単語トップ5・克服バッジ
- **推薦** `recommendMaterials(profile, materials, progresses)`（純関数・テスト必須）: スコア＝苦手音素の出現密度（phonemeCounts）＋苦手現象の練習機会数（phenomena検出器を教材文に適用して都度計算）＋苦手単語の出現＋レベル適正（直近平均一致率<60%なら低レベル優先・>85%なら上へ）。対象はdone以外のbundledセクション。今日タブ「あなたへのおすすめ」カードに上位2件を**推薦理由つき**で表示。プロファイルが薄い間（提出数不足）はレベル順の未着手教材にフォールバック（コールドスタート）
- **将来拡張（未実装・記録のみ）**: 苦手音・苦手単語を狙ったカスタム教材のTTS生成（OpenAI TTS等・1教材数円・要APIキー）。推薦が機能した後の次段階

## 8e. 訳・語彙とスクリプト添削オーバーレイ（M14）

練習画面のスクリプト表示を共有コンポーネント `src/components/ScriptView.tsx` に統合し（PlayerUI/RecorderUIから利用）、2つのオーバーレイを載せる。どちらもトグルチップで表示/非表示（初期は表示）。

**a. 日本語訳・重要語彙（クリップボード往復方式）**
- LLM APIは使わない。`src/lib/scriptAnnotations.ts` が番号付き文一覧+JSON出力形式を指定した依頼プロンプトを組み立て、練習画面下部の `TranslationImportPanel` からコピー → ユーザーがChatGPT/Claude等に貼る → 返答JSONを貼り戻す → パース・検証して `Sentence.ja`/`Sentence.vocab` へ保存（外部送信なし。clipboardFallback.tsと同方式）
- パースはコードフェンス・前後の説明文に耐性を持たせる（全体parse失敗時は最初の`{`〜最後の`}`で再試行）。不正JSONと文数不一致は別メッセージでエラー表示
- **バンドル教材の起動時同期（§7のsyncBundledMaterials）は丸ごと上書きのため、同一indexでenが一致する文のja/vocabを既存レコードから引き継ぐ**（`mergeSentenceAnnotations`）。enが変わった文（再分割等）は破棄

**b. 前回結果ハイライト+コメントカード（シャドテン風）**
- `usePracticeWizard` がマウント時に取得済みの直近judged提出から `previousJudge` を渡し、`src/lib/scriptFeedback.ts` が文ごとの表示データを組み立てる
- できなかった語（wordMarksのmissed/sub、issuesの対象語）=ピンク地、improved=trueの前回指摘の語=青緑地。「🔥 Development」（issues）/「✓ Good」（improved）カードは常時表示せず、**点線下線付きのハイライト語をタップしたときに該当箇所（アンカー語）の直後へ割り込み表示する**（シャドテン風。`FeedbackCard.anchorPosition`。再タップ・カードタップで閉じる）。タップアンカーが無いカード（語数不一致フォールバック時・位置マッチ0件の旧データ）のみ常時表示にフォールバック（`FeedbackCard.anchored`）
- `PreviousIssueOutcome` はsiを持たないため、対象語が全てokで存在する文を逆引きする（comparePreviousIssuesと同じヒューリスティック）
- スクリプト総語数とwordMarks長が不一致（教材差し替え等）ならハイライトを諦めプレーン表示にフォールバック（phenomena.tsのpositionsReliableと同じ安全側）

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
