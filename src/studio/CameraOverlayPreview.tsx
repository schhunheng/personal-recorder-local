import { useEffect, useRef, useState } from 'react';
import { Camera as CameraIcon, Move } from 'lucide-react';
import { clamp, type Camera } from './model';
import { cameraRect } from './camera';
export function CameraOverlayPreview({
  camera,
  stream,
  avatarUrl,
  enabled,
  onChange,
}: {
  camera: Camera;
  stream?: MediaStream;
  avatarUrl?: string;
  enabled: boolean;
  onChange: (patch: Partial<Camera>) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    video = useRef<HTMLVideoElement>(null),
    dragOffset = useRef<{ x: number; y: number } | undefined>(undefined);
  const [bounds, setBounds] = useState({ width: 640, height: 360 });
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () =>
      setBounds({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (avatarUrl) {
      element.src = avatarUrl;
      element.loop = true;
    } else if (stream) element.srcObject = stream;
    void element.play().catch(() => {});
    return () => {
      element.pause();
      element.srcObject = null;
      element.removeAttribute('src');
      element.load();
    };
  }, [stream, avatarUrl, camera.visible, enabled]);
  const rect = cameraRect(camera, bounds.width, bounds.height);
  function move(event: React.PointerEvent) {
    const frame = host.current?.getBoundingClientRect();
    if (!frame?.width || !frame.height || !dragOffset.current) return;
    const size = Math.min(frame.width, frame.height) * camera.size;
    onChange({
      x: clamp(
        (event.clientX - frame.left - dragOffset.current.x) / frame.width,
        size / 2 / frame.width,
        1 - size / 2 / frame.width
      ),
      y: clamp(
        (event.clientY - frame.top - dragOffset.current.y) / frame.height,
        size / 2 / frame.height,
        1 - size / 2 / frame.height
      ),
    });
  }
  return (
    <div ref={host} className="recording-overlay-layer">
      {enabled && camera.visible && (
        <div
          className="recording-overlay"
          role="group"
          aria-label={
            avatarUrl
              ? 'Avatar overlay. Drag to reposition.'
              : 'Camera overlay. Drag to reposition.'
          }
          tabIndex={0}
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.size,
            height: rect.size,
            borderRadius: camera.shape === 'circle' ? '50%' : '18%',
            opacity: camera.opacity,
            border: camera.border ? '2px solid #f2fff5' : 'none',
            boxShadow: camera.shadow ? '0 5px 16px #0008' : 'none',
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            const box = event.currentTarget.getBoundingClientRect();
            dragOffset.current = {
              x: event.clientX - box.left - box.width / 2,
              y: event.clientY - box.top - box.height / 2,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (dragOffset.current) move(event);
          }}
          onPointerUp={() => {
            dragOffset.current = undefined;
          }}
          onPointerCancel={() => {
            dragOffset.current = undefined;
          }}
          onLostPointerCapture={() => {
            dragOffset.current = undefined;
          }}
          onKeyDown={(event) => {
            const dx =
                event.key === 'ArrowLeft'
                  ? -0.02
                  : event.key === 'ArrowRight'
                  ? 0.02
                  : 0,
              dy =
                event.key === 'ArrowUp'
                  ? -0.02
                  : event.key === 'ArrowDown'
                  ? 0.02
                  : 0;
            if (dx || dy) {
              event.preventDefault();
              onChange({
                x: clamp(
                  camera.x + dx,
                  rect.size / 2 / bounds.width,
                  1 - rect.size / 2 / bounds.width
                ),
                y: clamp(
                  camera.y + dy,
                  rect.size / 2 / bounds.height,
                  1 - rect.size / 2 / bounds.height
                ),
              });
            }
          }}
        >
          {stream || avatarUrl ? (
            <video
              ref={video}
              muted
              playsInline
              autoPlay
              style={{ transform: camera.mirror ? 'scaleX(-1)' : undefined }}
            />
          ) : (
            <div className="camera-placement-placeholder">
              <CameraIcon size={25} />
              <small>Camera position</small>
            </div>
          )}
          <span className="overlay-drag-hint">
            <Move size={12} />
          </span>
        </div>
      )}
    </div>
  );
}
