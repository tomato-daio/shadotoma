import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { syncBundledMaterials } from './lib/db';
import { useMaterialsStore } from './stores/useMaterialsStore';
import './index.css';

registerSW({ immediate: true });

// アプリ起動時にVOAバンドル教材のindex.jsonを取得しIndexedDBへ同期する（DESIGN.md §7末尾）。
// オフライン時は失敗しても既存DBのまま動作を継続する。完了後、教材一覧を表示中なら
// zustandストア経由で再取得し新着教材を反映する。
void syncBundledMaterials(import.meta.env.BASE_URL).then(() => {
  const { loaded, refresh } = useMaterialsStore.getState();
  if (loaded) void refresh();
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
