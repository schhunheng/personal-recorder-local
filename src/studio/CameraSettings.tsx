import { Eye, EyeOff } from 'lucide-react';
import type { Camera } from './model';
import { cameraAtCorner, cameraCorners, selectedCameraCorner } from './camera';
import { Field, Slider, Toggle } from './controls';
export function CameraSettings({
  camera,
  onChange,
  ratio = 16 / 9,
  recording = false,
}: {
  camera: Camera;
  onChange: (patch: Partial<Camera>) => void;
  ratio?: number;
  recording?: boolean;
}) {
  const corner = selectedCameraCorner(camera, ratio);
  return (
    <div className="camera-settings">
      <Toggle
        label="Show camera / avatar"
        checked={camera.visible}
        onChange={(visible) => onChange({ visible })}
        description={
          recording
            ? 'Visibility affects the preview and the finished video.'
            : 'Show or hide the overlay in the preview and export.'
        }
      />
      <div
        className={`overlay-visibility ${camera.visible ? 'visible' : ''}`}
        role="status"
      >
        {camera.visible ? <Eye size={14} /> : <EyeOff size={14} />}{' '}
        {camera.visible ? 'Overlay visible' : 'Overlay hidden'}
        {recording && !camera.visible && (
          <small>You can show it again here or in the editor.</small>
        )}
      </div>
      <div className="overlay-position-label">
        Where to show{' '}
        <span>
          {cameraCorners.find((c) => c.id === corner)?.label ||
            'Custom position'}
        </span>
      </div>
      <div
        className="corner-grid overlay-corners"
        role="group"
        aria-label="Camera or avatar position"
      >
        {cameraCorners.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={corner === id}
            onClick={() => {
              const next = cameraAtCorner(camera, id, ratio);
              onChange({ x: next.x, y: next.y });
            }}
          >
            <span className={`corner-symbol ${id}`} aria-hidden="true">
              <i />
            </span>
            {label}
          </button>
        ))}
      </div>
      <Slider
        label="Overlay size"
        value={Math.round(camera.size * 100)}
        min={8}
        max={50}
        step={1}
        suffix="%"
        onChange={(value) => {
          const next = { ...camera, size: value / 100 };
          onChange(
            corner ? cameraAtCorner(next, corner, ratio) : { size: next.size }
          );
        }}
      />
      <Field label="Overlay shape">
        <select
          value={camera.shape}
          onChange={(event) =>
            onChange({ shape: event.target.value as Camera['shape'] })
          }
        >
          <option value="circle">Circle</option>
          <option value="rounded">Rounded square</option>
        </select>
      </Field>
      <details className="overlay-appearance">
        <summary>More appearance settings</summary>
        <Toggle
          label="Mirror camera / avatar"
          checked={camera.mirror}
          onChange={(mirror) => onChange({ mirror })}
        />
        <Toggle
          label="Thin border"
          checked={camera.border}
          onChange={(border) => onChange({ border })}
        />
        <Toggle
          label="Soft shadow"
          checked={camera.shadow}
          onChange={(shadow) => onChange({ shadow })}
        />
        <Slider
          label="Overlay opacity"
          value={Math.round(camera.opacity * 100)}
          min={10}
          max={100}
          step={5}
          suffix="%"
          onChange={(value) => onChange({ opacity: value / 100 })}
        />
      </details>
      <p className="inspector-footnote">
        Drag the overlay in the preview for a custom position. This layout
        applies to the whole video and can be changed again in the editor.
      </p>
    </div>
  );
}
