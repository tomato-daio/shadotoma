import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { TabLayout } from './components/TabLayout';
import { MaterialsPage } from './pages/MaterialsPage';
import { PracticePage } from './pages/PracticePage';
import { ProgressPage } from './pages/ProgressPage';
import { SettingsPage } from './pages/SettingsPage';
import { TodayPage } from './pages/TodayPage';

export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<TabLayout />}>
          <Route path="/" element={<TodayPage />} />
          <Route path="/materials" element={<MaterialsPage />} />
          <Route path="/progress" element={<ProgressPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="/practice/:materialId" element={<PracticePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
