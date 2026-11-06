export type Mode = 'off' | 'fast' | 'balanced' | 'ai';
export interface Capabilities { ready: boolean; ai_available: boolean; ai_message: string; max_bytes: number; max_duration: number; retention_days: number }
export interface Job { id: string; status: string; stage: string; progress: number | null; error?: string; version: number; processed_file?: string; original_file: string; created_at: number; duration?: number; mode?: Mode; strength?: number; audio?: { gain_db: number } }
export const activeJob = (job?: Job) => Boolean(job && ['queued', 'validating', 'extracting', 'cleaning', 'encoding', 'uploading'].includes(job.status));
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw Error(typeof body?.detail === 'string' ? body.detail : `Local server returned ${response.status}.`);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
export function upload(blob: Blob, mode: Mode, strength: number, onProgress: (value: number) => void, signal: AbortSignal): Promise<Job> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/recordings?mode=${mode}&strength=${strength}`);
    xhr.setRequestHeader('Content-Type', blob.type.split(';')[0]);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total * 100); };
    const abort = () => xhr.abort(); signal.addEventListener('abort', abort, { once: true });
    xhr.onloadend = () => signal.removeEventListener('abort', abort);
    xhr.onerror = () => reject(Error('Local backend is unreachable. Your original is safe in this browser.'));
    xhr.onabort = () => reject(Error('Upload cancelled. Your original is retained.'));
    xhr.onload = () => {
      let result; try { result = JSON.parse(xhr.responseText); } catch { reject(Error('Invalid server response. Check the local backend.')); return; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(result);
      else reject(Error(typeof result.detail === 'string' ? result.detail : `Upload failed (${xhr.status}).`));
    };
    if (signal.aborted) { reject(Error('Upload cancelled')); return; }
    xhr.send(blob);
  });
}
