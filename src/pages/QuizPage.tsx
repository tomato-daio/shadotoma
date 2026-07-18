import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PlayerUI } from '../features/player/PlayerUI';
import {
  cryptoRandom,
  generateSectionBlanks,
  isBlankCorrect,
  selectRecentDoneSections,
  type QuizBlank,
} from '../features/quiz/quizGen';
import { articleHeadingTitle } from '../lib/articleTitle';
import { addQuizResult, getAllMaterialProgress, getMaterialsByArticleId, newId, type Material } from '../lib/db';
import { learningDate } from '../lib/dates';
import { latestDate } from '../lib/practiceFlow';

interface QuizSection {
  material: Material;
  audioSrc: string;
  blanks: QuizBlank[];
}

interface QuizResultSummary {
  total: number;
  correct: number;
}

function resolveAudioSrc(material: Material): string | undefined {
  if (material.source === 'local' && material.audioBlob) {
    return URL.createObjectURL(material.audioBlob);
  }
  if (material.audioUrl) {
    return `${import.meta.env.BASE_URL}${material.audioUrl}`;
  }
  return undefined;
}

function blankKey(materialId: string, blank: QuizBlank): string {
  return `${materialId}:${blank.sentenceIndex}:${blank.wordIndex}`;
}

/**
 * 確認テスト（穴埋め）画面（DESIGN.md §8b）。タブの上に全画面で開く（PracticePageと同様の配置）。
 * 記事内でstatus='done'のセクションから直近最大3つを出題し、各セクションのスクリプトから
 * 内容語を穴埋めにする。音声プレーヤーで何度でも聴き直しながら回答し、まとめて採点する。
 */
export function QuizPage() {
  const { articleId } = useParams<{ articleId: string }>();
  const navigate = useNavigate();

  // undefined=読み込み中, null=出題できるセクションが無い
  const [sections, setSections] = useState<QuizSection[] | null | undefined>(undefined);
  const [answers, setAnswers] = useState<Map<string, string>>(new Map());
  const [graded, setGraded] = useState(false);
  const [result, setResult] = useState<QuizResultSummary | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!articleId) return;
    let cancelled = false;
    setSections(undefined);
    setAnswers(new Map());
    setGraded(false);
    setResult(null);

    void (async () => {
      const [materials, progresses] = await Promise.all([getMaterialsByArticleId(articleId), getAllMaterialProgress()]);
      if (cancelled) return;

      const progressByMaterial = new Map(progresses.map((p) => [p.materialId, p]));
      const doneMaterials = materials.filter((m) => progressByMaterial.get(m.id)?.status === 'done');

      // DESIGN.md §8b: doneセクションから直近最大3つを出題対象にする。
      const candidates = doneMaterials.map((m) => ({
        material: m,
        part: m.part ?? 0,
        lastPracticedDate: latestDate(progressByMaterial.get(m.id)?.daysPracticed ?? []),
      }));
      const selected = selectRecentDoneSections(candidates, 3);

      const built: QuizSection[] = [];
      for (const candidate of selected) {
        const audioSrc = resolveAudioSrc(candidate.material);
        if (!audioSrc) continue;
        const blanks = generateSectionBlanks(candidate.material.sentences, cryptoRandom);
        // 内容語が1つも作れない極端なケースは、そのセクションを出題対象から外す（安全化。DESIGN.md §8b）。
        if (blanks.length === 0) continue;
        built.push({ material: candidate.material, audioSrc, blanks });
      }

      if (cancelled) return;
      setSections(built.length > 0 ? built : null);
    })();

    return () => {
      cancelled = true;
    };
  }, [articleId]);

  // ローカル取り込み教材（Blob URL）のクリーンアップ。bundled教材はbase相対URLなので対象外。
  useEffect(() => {
    return () => {
      sections?.forEach((s) => {
        if (s.audioSrc.startsWith('blob:')) URL.revokeObjectURL(s.audioSrc);
      });
    };
  }, [sections]);

  const totalBlanks = useMemo(() => sections?.reduce((n, s) => n + s.blanks.length, 0) ?? 0, [sections]);

  const handleAnswerChange = (key: string, value: string) => {
    setAnswers((prev) => {
      const next = new Map(prev);
      next.set(key, value);
      return next;
    });
  };

  const handleGrade = async () => {
    if (!sections || !articleId || graded) return;
    let correct = 0;
    let total = 0;
    for (const section of sections) {
      for (const blank of section.blanks) {
        total += 1;
        if (isBlankCorrect(answers.get(blankKey(section.material.id, blank)) ?? '', blank.answer)) {
          correct += 1;
        }
      }
    }
    setResult({ total, correct });
    setGraded(true);
    setSaving(true);
    try {
      await addQuizResult({
        id: newId('quiz'),
        articleId,
        date: learningDate(new Date()),
        sectionIds: sections.map((s) => s.material.id),
        total,
        correct,
        createdAt: Date.now(),
      });
    } finally {
      setSaving(false);
    }
  };

  const articleTitle = sections?.[0] ? articleHeadingTitle(sections[0].material.title) : '確認テスト';

  if (sections === undefined) {
    return <div className="p-6 text-center text-sm text-neutral-400">読み込み中…</div>;
  }

  if (sections === null || !articleId) {
    return (
      <div className="flex flex-col items-center gap-4 p-6 text-center">
        <p className="text-sm text-neutral-500">
          この記事はまだ確認テストに挑戦できません。まずセクションを1つ以上完了しましょう。
        </p>
        <button
          type="button"
          onClick={() => navigate('/materials')}
          className="rounded-full bg-tomato-500 px-4 py-2 text-sm font-semibold text-white"
        >
          教材一覧に戻る
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-4 pb-10">
      <header className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="rounded-full border border-neutral-300 px-3 py-1 text-sm text-neutral-600"
        >
          ← 戻る
        </button>
        <h1 className="flex-1 truncate text-base font-semibold text-neutral-800">確認テスト: {articleTitle}</h1>
      </header>

      <p className="text-xs text-neutral-500">
        完了したセクションから{sections.length}つ、聴き取り穴埋め問題（全{totalBlanks}問）です。何度でも聴き直してOKです。
      </p>

      {graded && result ? (
        <div className="rounded-xl border border-tomato-300 bg-tomato-50/60 p-4 text-center">
          <p className="text-lg font-bold text-tomato-700">
            {result.correct} / {result.total} 正解
          </p>
        </div>
      ) : null}

      {sections.map((section, sIndex) => (
        <QuizSectionBlock
          key={section.material.id}
          index={sIndex}
          section={section}
          answers={answers}
          onAnswerChange={handleAnswerChange}
          graded={graded}
        />
      ))}

      {!graded ? (
        <button
          type="button"
          onClick={() => void handleGrade()}
          className="rounded-full bg-tomato-500 px-4 py-3 text-sm font-semibold text-white active:bg-tomato-600"
        >
          採点する
        </button>
      ) : (
        <button
          type="button"
          onClick={() => navigate('/materials')}
          disabled={saving}
          className="rounded-full bg-tomato-500 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          教材一覧に戻る
        </button>
      )}
    </div>
  );
}

interface QuizSectionBlockProps {
  index: number;
  section: QuizSection;
  answers: Map<string, string>;
  onAnswerChange: (key: string, value: string) => void;
  graded: boolean;
}

function QuizSectionBlock({ index, section, answers, onAnswerChange, graded }: QuizSectionBlockProps) {
  const blankBySentence = useMemo(() => {
    const map = new Map<number, Map<number, QuizBlank>>();
    for (const b of section.blanks) {
      const inner = map.get(b.sentenceIndex) ?? new Map<number, QuizBlank>();
      inner.set(b.wordIndex, b);
      map.set(b.sentenceIndex, inner);
    }
    return map;
  }, [section.blanks]);

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-3">
      <p className="text-sm font-semibold text-neutral-700">
        セクション {index + 1}（{section.material.part ?? '?'}/{section.material.partCount ?? '?'}）
      </p>

      <PlayerUI src={section.audioSrc} sentences={[]} initialScriptVisible={false} />

      <div className="flex flex-col gap-2 rounded-lg bg-neutral-50 p-3 text-sm leading-loose">
        {section.material.sentences.map((sentence, si) => (
          <p key={si}>
            {sentence.en.split(/\s+/).map((word, wi) => {
              const blank = blankBySentence.get(si)?.get(wi);
              if (!blank) {
                return <span key={wi}>{word} </span>;
              }
              const key = blankKey(section.material.id, blank);
              const userAnswer = answers.get(key) ?? '';
              const isCorrect = graded ? isBlankCorrect(userAnswer, blank.answer) : false;
              return (
                <span key={wi} className="mr-1 inline-flex items-baseline gap-1">
                  <input
                    type="text"
                    inputMode="text"
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="____"
                    value={userAnswer}
                    disabled={graded}
                    onChange={(e) => onAnswerChange(key, e.target.value)}
                    aria-label={`空欄 セクション${index + 1} ${si + 1}文目`}
                    className={`w-16 rounded border px-1 py-0.5 text-center text-sm sm:w-20 ${
                      !graded
                        ? 'border-tomato-300 bg-white'
                        : isCorrect
                          ? 'border-green-400 bg-green-50 text-green-700'
                          : 'border-red-400 bg-red-50 text-red-700'
                    }`}
                  />
                  {graded && !isCorrect ? (
                    <span className="text-xs font-medium text-green-700">{blank.answer}</span>
                  ) : null}
                </span>
              );
            })}
          </p>
        ))}
      </div>
    </section>
  );
}
