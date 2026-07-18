import { create } from 'zustand';
import { getAllMaterials, type Material } from '../lib/db';

interface MaterialsState {
  materials: Material[];
  loading: boolean;
  loaded: boolean;
  refresh: () => Promise<void>;
  /** ローカル取り込み直後など、DB往復なしで一覧へ即時反映する。 */
  upsertLocal: (material: Material) => void;
}

export const useMaterialsStore = create<MaterialsState>((set) => ({
  materials: [],
  loading: false,
  loaded: false,
  refresh: async () => {
    set({ loading: true });
    const materials = await getAllMaterials();
    materials.sort((a, b) => b.addedAt - a.addedAt);
    set({ materials, loading: false, loaded: true });
  },
  upsertLocal: (material) => {
    set((state) => {
      const others = state.materials.filter((m) => m.id !== material.id);
      return { materials: [material, ...others] };
    });
  },
}));
