import { useState } from 'react';
import { Download, Plus, Trash2, Upload } from 'lucide-react';
import type { Edits } from './model';
import { defaultCaptionStyle } from './pipeline';
import { parseSRT, outputCaptions, toSRT } from './captions';
import { download } from './storage';
import { Field, Slider, Toggle } from './controls';
import { Button } from '../components/ui/button';
export function CaptionEditor({
  edits,
  duration,
  time,
  onChange,
  setTime,
}: {
  edits: Edits;
  duration: number;
  time: number;
  onChange: (e: Edits) => void;
  setTime: (n: number) => void;
}) {
  const [error, setError] = useState(''),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(0);
  const captions = edits.captions || [],
    style = edits.captionStyle || defaultCaptionStyle,
    filtered = captions.filter((c) =>
      c.text.toLocaleLowerCase().includes(search.toLocaleLowerCase())
    );
  const changeStyle = (values: Partial<typeof style>) =>
    onChange({ ...edits, captionStyle: { ...style, ...values } });
  return (
    <>
      <p className="inspector-footnote">
        Offline transcription appears here after processing with a local Whisper
        model. Khmer captions require review, especially code terminology.
      </p>
      <Toggle
        label="Burn captions into preview & export"
        checked={style.burn}
        onChange={(burn) => changeStyle({ burn })}
      />
      <Field label="Caption font">
        <select
          value={style.font}
          onChange={(e) =>
            changeStyle({ font: e.target.value as typeof style.font })
          }
        >
          {[
            'Khmer Sangam MN',
            'Khmer MN',
            'Noto Sans Khmer',
            'Khmer OS',
            'Arial',
          ].map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
      </Field>
      <Slider
        label="Caption size"
        min={16}
        max={90}
        value={style.size}
        onChange={(size) => changeStyle({ size })}
      />
      <Field label="Caption position">
        <select
          value={style.position}
          onChange={(e) =>
            changeStyle({ position: e.target.value as typeof style.position })
          }
        >
          <option value="bottom">Bottom</option>
          <option value="top">Top</option>
          <option value="center">Center</option>
        </select>
      </Field>
      <Field label="Animation">
        <select
          value={style.animation}
          onChange={(e) =>
            changeStyle({ animation: e.target.value as typeof style.animation })
          }
        >
          <option value="none">None</option>
          <option value="fade">Gentle fade</option>
        </select>
      </Field>
      <div className="caption-actions">
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            onChange({
              ...edits,
              captions: [
                ...captions,
                {
                  id: crypto.randomUUID(),
                  start: Math.min(time, Math.max(0, duration - 0.1)),
                  end: Math.min(duration, Math.max(time + 0.1, time + 2.5)),
                  text: 'New caption',
                },
              ],
            })
          }
        >
          <Plus size={13} /> Add caption
        </Button>
        <label className="upload-label">
          <Upload size={13} /> Import SRT
          <input
            hidden
            type="file"
            accept=".srt,text/plain"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                if (file.size > 5 * 1024 ** 2)
                  throw Error('Use an SRT file under 5 MB.');
                onChange({
                  ...edits,
                  captions: parseSRT(await file.text(), duration),
                });
                setError('');
              } catch (error) {
                setError((error as Error).message);
              }
              e.target.value = '';
            }}
          />
        </label>
        <Button
          variant="secondary"
          size="sm"
          disabled={!captions.length}
          onClick={() =>
            download(
              new Blob([toSRT(outputCaptions(edits))], {
                type: 'application/x-subrip;charset=utf-8',
              }),
              'reancode101-subtitles.srt'
            )
          }
        >
          <Download size={13} /> Export SRT
        </Button>
      </div>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <Field label={`Search ${captions.length} captions`}>
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          placeholder="Khmer or English text…"
        />
      </Field>
      {filtered.slice(page * 20, (page + 1) * 20).map((c) => (
        <div className="caption-row" key={c.id}>
          <button className="small" onClick={() => setTime(c.start)}>
            Seek to {c.start.toFixed(2)}s
          </button>
          <textarea
            aria-label={`Caption text at ${c.start.toFixed(2)} seconds`}
            value={c.text}
            maxLength={1200}
            onChange={(event) =>
              onChange({
                ...edits,
                captions: captions.map((item) =>
                  item.id === c.id
                    ? { ...item, text: event.target.value }
                    : item
                ),
              })
            }
          />
          <div className="two-fields">
            <Field label="Start (s)">
              <input
                type="number"
                min={0}
                max={c.end - 0.05}
                step={0.05}
                value={c.start}
                onChange={(event) =>
                  onChange({
                    ...edits,
                    captions: captions.map((item) =>
                      item.id === c.id
                        ? {
                            ...item,
                            start: Math.max(
                              0,
                              Math.min(c.end - 0.05, +event.target.value)
                            ),
                          }
                        : item
                    ),
                  })
                }
              />
            </Field>
            <Field label="End (s)">
              <input
                type="number"
                min={c.start + 0.05}
                max={duration}
                step={0.05}
                value={c.end}
                onChange={(event) =>
                  onChange({
                    ...edits,
                    captions: captions.map((item) =>
                      item.id === c.id
                        ? {
                            ...item,
                            end: Math.max(
                              c.start + 0.05,
                              Math.min(duration, +event.target.value)
                            ),
                          }
                        : item
                    ),
                  })
                }
              />
            </Field>
          </div>
          <button
            className="danger-link"
            onClick={() =>
              onChange({
                ...edits,
                captions: captions.filter((item) => item.id !== c.id),
              })
            }
          >
            <Trash2 size={12} /> Remove caption
          </button>
        </div>
      ))}
      {filtered.length > 20 && (
        <div className="caption-pagination">
          <button disabled={!page} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span>
            {page + 1} / {Math.ceil(filtered.length / 20)}
          </span>
          <button
            disabled={(page + 1) * 20 >= filtered.length}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </div>
      )}
      {!!edits.chapters?.length && (
        <>
          <h3>Suggested chapters</h3>
          <p className="inspector-footnote">
            Labels use narration excerpts and need review.
          </p>
          {edits.chapters.map((chapter, index) => (
            <Field key={index} label={`${chapter.time.toFixed(1)}s`}>
              <input
                value={chapter.title}
                maxLength={160}
                onChange={(e) =>
                  onChange({
                    ...edits,
                    chapters: edits.chapters!.map((c, i) =>
                      i === index ? { ...c, title: e.target.value } : c
                    ),
                  })
                }
              />
            </Field>
          ))}
        </>
      )}
    </>
  );
}
