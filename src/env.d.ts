/// <reference types="vite/client" />
interface Window {
  desktop?: {
    sources(): Promise<{ id: string; name: string; thumbnail: string }[]>;
    selectSource(id: string): Promise<void>;
    beginRecording(format?: 'webm' | 'mp4'): Promise<{ id: string; path: string } | null>;
    appendRecording(id: string, data: ArrayBuffer): Promise<void>;
    finishRecording(id: string, preservePartial?: boolean): Promise<string>;
    exportCapabilities(): Promise<{ available: boolean; formats: string[]; message: string }>;
    exportVideo(format: 'mp4' | 'mov'): Promise<string | null>;
    metrics(): Promise<{ cpuPercent: number; memoryMB: number }>;
  };
}
