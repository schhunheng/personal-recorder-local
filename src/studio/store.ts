import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { defaultPipeline, type PipelineOptions } from './pipeline';
import {
  defaultRecording,
  defaultCamera,
  type Camera,
  type RecordingOptions,
  type Edits,
  type Project,
} from './model';
export const usePreferences = create(
  persist<{
    overlay: Camera;
    setOverlay: (patch: Partial<Camera>) => void;
    avatarId?: string;
    setAvatarId: (id?: string) => void;
    automation: { enabled: boolean; options: PipelineOptions };
    setAutomation: (
      value: Partial<{ enabled: boolean; options: PipelineOptions }>
    ) => void;
    zoom: { scale: number; duration: number };
    setZoom: (value: Partial<{ scale: number; duration: number }>) => void;
    recording: RecordingOptions;
    setRecording: (value: Partial<RecordingOptions>) => void;
  }>(
    (set) => ({
      overlay: { ...defaultCamera },
      setOverlay: (patch) =>
        set((state) => ({ overlay: { ...state.overlay, ...patch } })),
      avatarId: undefined,
      setAvatarId: (avatarId) => set({ avatarId }),
      automation: { enabled: true, options: defaultPipeline },
      setAutomation: (value) =>
        set((state) => ({ automation: { ...state.automation, ...value } })),
      zoom: { scale: 2, duration: 0.7 },
      setZoom: (value) =>
        set((state) => ({ zoom: { ...state.zoom, ...value } })),
      recording: defaultRecording,
      setRecording: (value) =>
        set((state) => ({ recording: { ...state.recording, ...value } })),
    }),
    { name: 'reancode101-preferences' }
  )
);
type EditorState = {
  project?: Project;
  past: Edits[];
  future: Edits[];
  open: (p?: Project) => void;
  edit: (update: (edits: Edits) => Edits) => void;
  undo: () => void;
  redo: () => void;
};
export const useEditor = create<EditorState>((set) => ({
  past: [],
  future: [],
  open: (project) =>
    set({
      project: project ? structuredClone(project) : undefined,
      past: [],
      future: [],
    }),
  edit: (update) =>
    set((state) =>
      state.project
        ? {
            project: {
              ...state.project,
              edits: update(structuredClone(state.project.edits)),
            },
            past: [...state.past.slice(-99), state.project.edits],
            future: [],
          }
        : state
    ),
  undo: () =>
    set((s) =>
      s.project && s.past.length
        ? {
            project: { ...s.project, edits: s.past.at(-1)! },
            past: s.past.slice(0, -1),
            future: [s.project.edits, ...s.future],
          }
        : s
    ),
  redo: () =>
    set((s) =>
      s.project && s.future.length
        ? {
            project: { ...s.project, edits: s.future[0] },
            past: [...s.past, s.project.edits],
            future: s.future.slice(1),
          }
        : s
    ),
}));
