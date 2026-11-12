import { EyeOff, Plus, Trash2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Field, Slider } from './controls';
import { clamp, formatTime, type MaskRect, type ScreenMask } from './model';
import { MIN_MASK_SIZE, moveMask, resizeMask } from './masks';

export function HideSettings({
  masks,
  selected,
  duration,
  onSelect,
  onAdd,
  onChange,
  onRemove,
}: {
  masks: ScreenMask[];
  selected: string;
  duration: number;
  onSelect: (id: string) => void;
  onAdd: (rect?: MaskRect) => void;
  onChange: (id: string, patch: Partial<ScreenMask>) => void;
  onRemove: (id: string) => void;
}) {
  const mask = masks.find((item) => item.id === selected);
  return (
    <>
      <div className="feature-note">
        <EyeOff size={20} />
        <p>
          Cover private details.
          <span>Drag across the preview to hide an area.</span>
        </p>
      </div>
      <Button
        className="full"
        variant="secondary"
        disabled={masks.length >= 100}
        onClick={() => onAdd()}
      >
        <Plus size={15} /> Add hidden area
      </Button>
      <div className="keyframe-list">
        {masks.length ? (
          masks.map((item, index) => (
            <button
              key={item.id}
              className={item.id === selected ? 'selected' : ''}
              aria-pressed={item.id === selected}
              onClick={() => onSelect(item.id)}
            >
              <EyeOff size={15} />
              <span>
                Hidden area {index + 1}
                <small>{formatTime(item.start)} – {formatTime(item.end)}</small>
              </span>
            </button>
          ))
        ) : (
          <div className="inspector-empty">
            No hidden areas yet.<br />Draw a box or add one to get started.
          </div>
        )}
      </div>
      {mask && (
        <>
          <Field label="Cover color">
            <input
              type="color"
              value={mask.color}
              onChange={(event) => onChange(mask.id, { color: event.target.value })}
            />
          </Field>
          <div className="two-fields">
            <Slider
              label="Area left"
              value={Math.round(mask.x * 100)}
              min={0}
              max={Math.round((1 - mask.width) * 100)}
              suffix="%"
              onChange={(x) => onChange(mask.id, moveMask(mask, x / 100 - mask.x, 0))}
            />
            <Slider
              label="Area top"
              value={Math.round(mask.y * 100)}
              min={0}
              max={Math.round((1 - mask.height) * 100)}
              suffix="%"
              onChange={(y) => onChange(mask.id, moveMask(mask, 0, y / 100 - mask.y))}
            />
          </div>
          <div className="two-fields">
            <Slider
              label="Area width"
              value={Math.round(mask.width * 100)}
              min={MIN_MASK_SIZE * 100}
              max={Math.round((1 - mask.x) * 100)}
              suffix="%"
              onChange={(width) => onChange(mask.id, resizeMask(mask, width / 100 - mask.width, 0))}
            />
            <Slider
              label="Area height"
              value={Math.round(mask.height * 100)}
              min={MIN_MASK_SIZE * 100}
              max={Math.round((1 - mask.y) * 100)}
              suffix="%"
              onChange={(height) => onChange(mask.id, resizeMask(mask, 0, height / 100 - mask.height))}
            />
          </div>
          <div className="two-fields">
            <Field label="Hide from (seconds)">
              <input
                type="number"
                min={0}
                max={mask.end - 0.01}
                step={0.01}
                value={Number(mask.start.toFixed(3))}
                onChange={(event) => onChange(mask.id, {
                  start: clamp(+event.target.value, 0, mask.end - 0.01),
                })}
              />
            </Field>
            <Field label="Hide until (seconds)">
              <input
                type="number"
                min={mask.start + 0.01}
                max={duration}
                step={0.01}
                value={Number(mask.end.toFixed(3))}
                onChange={(event) => onChange(mask.id, {
                  end: clamp(+event.target.value, mask.start + 0.01, duration),
                })}
              />
            </Field>
          </div>
          <button className="danger-link" onClick={() => onRemove(mask.id)}>
            <Trash2 size={14} /> Remove hidden area
          </button>
        </>
      )}
      <p className="inspector-footnote">
        Areas follow the recorded screen through zooms. Drag a cover to move it
        or its bottom-right handle to resize. Timing uses the original recording.
        Covers appear in the preview and new exports; original files stay available.
      </p>
    </>
  );
}
