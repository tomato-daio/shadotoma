import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PlayerUI } from '../features/player/PlayerUI';
import { RecorderUI } from '../features/recorder/RecorderUI';
import { SubmissionHistory } from '../features/recorder/SubmissionHistory';
import { addSubmission, getMaterial, newId, type Material } from '../lib/db';
import { learningDate } from '../lib/dates';

export function PracticePage() {
  const { materialId } = useParams<{ materialId: string }>();
  const navigate = useNavigate();
  // undefined = 読み込み中, null = 見つからない
  const [material, setMaterial] = useState<Material | null | undefined>(undefined);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!materialId) return;
    let cancelled = false;
    setMaterial(undefined);
    void getMaterial(materialId).then((m) => {
      if (!cancelled) setMaterial(m ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [materialId]);

  const audioSrc = useMemo(() => {
    if (!material) return undefined;
    if (material.source === 'local' && material.audioBlob) {
      return URL.createObjectURL(material.audioBlob);
    }
    if (material.audioUrl) {
      return `${import.meta.env.BASE_URL}${material.audioUrl}`;
    }
    return undefined;
  }, [material]);

  useEffect(() => {
    return () => {
      if (audioSrc?.startsWith('blob:')) {
        URL.revokeObjectURL(audioSrc);
      }
    };
  }, [audioSrc]);

  if (material === undefined) {
    return <div className="p-6 text-center text-sm text-neutral-400">読み込み中…</div>;
  }

  if (material === null || !materialId) {
    return (
      <div className="flex flex-col items-center gap-4 p-6 text-center">
        <p className="text-sm text-neutral-500">教材が見つかりませんでした</p>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="rounded-full bg-tomato-500 px-4 py-2 text-sm font-semibold text-white"
        >
          今日の画面に戻る
        </button>
      </div>
    );
  }

  const handleSubmit = async (blob: Blob, mimeType: string) => {
    await addSubmission({
      id: newId('sub'),
      materialId,
      date: learningDate(new Date()),
      audioBlob: blob,
      mimeType,
      createdAt: Date.now(),
    });
    setRefreshKey((k) => k + 1);
  };

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
        <h1 className="flex-1 truncate text-base font-semibold text-neutral-800">{material.title}</h1>
      </header>

      {audioSrc ? (
        <>
          <PlayerUI src={audioSrc} sentences={material.sentences} />
          <RecorderUI referenceSrc={audioSrc} onSubmit={handleSubmit} />
        </>
      ) : (
        <p className="text-sm text-red-600">音声を読み込めませんでした</p>
      )}

      <section className="flex flex-col gap-2">
        <p className="text-sm font-medium text-neutral-700">提出履歴</p>
        <SubmissionHistory materialId={materialId} refreshKey={refreshKey} />
      </section>
    </div>
  );
}
