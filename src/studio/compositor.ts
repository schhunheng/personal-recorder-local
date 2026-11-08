import type { Edits } from './model';
import { zoomAt } from './timeline';
export function contrastColor(background: string) {
  const hex = /^#[0-9a-f]{6}$/i.test(background) ? background : '#182b29';
  const channels = [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.05
    ? '#ffffff'
    : '#000000';
}
export function watermarkColor(appearance: Edits['appearance']) {
  return appearance.watermarkColor && appearance.watermarkColor !== 'auto'
    ? appearance.watermarkColor
    : contrastColor(appearance.background);
}
export function screenBounds(
  video: HTMLVideoElement,
  edits: Edits,
  width: number,
  height: number
) {
  const padX =
    (edits.appearance.paddingX ?? edits.appearance.padding) *
    Math.min(width, height);
  const padY =
    (edits.appearance.paddingY ?? edits.appearance.padding) *
    Math.min(width, height);
  const scale = Math.min(
    (width - padX * 2) / (video.videoWidth || width),
    (height - padY * 2) / (video.videoHeight || height)
  );
  const w = (video.videoWidth || width) * scale,
    h = (video.videoHeight || height) * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  camera: HTMLVideoElement | undefined,
  edits: Edits,
  time: number,
  width: number,
  height: number
) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = edits.appearance.background;
  ctx.fillRect(0, 0, width, height);
  if (video.readyState >= 2) {
    const { x, y, w, h } = screenBounds(video, edits, width, height),
      z = zoomAt(edits.zooms, time);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, (edits.appearance.radius * width) / 1920);
    if (edits.appearance.shadow) {
      ctx.shadowColor = '#0009';
      ctx.shadowBlur = (28 * width) / 1920;
      ctx.shadowOffsetY = (12 * width) / 1920;
    }
    ctx.fillStyle = '#080c0f';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.clip();
    const sw = video.videoWidth / z.scale,
      sh = video.videoHeight / z.scale;
    ctx.drawImage(
      video,
      video.videoWidth * z.x - sw / 2,
      video.videoHeight * z.y - sh / 2,
      sw,
      sh,
      x,
      y,
      w,
      h
    );
    ctx.restore();
  }
  const c = edits.camera;
  if (camera && camera.readyState >= 2 && c.visible) {
    const d = Math.min(width, height) * c.size,
      x = Math.max(d / 2, Math.min(width - d / 2, c.x * width)),
      y = Math.max(d / 2, Math.min(height - d / 2, c.y * height));
    ctx.save();
    ctx.globalAlpha = c.opacity;
    ctx.beginPath();
    ctx.roundRect(
      x - d / 2,
      y - d / 2,
      d,
      d,
      c.shape === 'circle' ? d / 2 : d * 0.18
    );
    if (c.shadow) {
      ctx.shadowColor = '#0008';
      ctx.shadowBlur = d * 0.1;
    }
    ctx.fillStyle = '#17211f';
    if (!edits.avatar) ctx.fill();
    ctx.shadowColor = 'transparent';
    if (c.border) {
      ctx.strokeStyle = '#f2fff5';
      ctx.lineWidth = Math.max(1, width / 650);
      ctx.stroke();
    }
    ctx.clip();
    const side = Math.min(camera.videoWidth, camera.videoHeight);
    ctx.translate(x + (c.mirror ? d / 2 : -d / 2), y - d / 2);
    ctx.scale(c.mirror ? -1 : 1, 1);
    ctx.drawImage(
      camera,
      (camera.videoWidth - side) / 2,
      (camera.videoHeight - side) / 2,
      side,
      side,
      0,
      0,
      d,
      d
    );
    ctx.restore();
  }
  if (edits.appearance.watermark) {
    ctx.save();
    ctx.font = `600 ${width / 80}px sans-serif`;
    ctx.textAlign = 'right';
    const color = watermarkColor(edits.appearance);
    ctx.fillStyle = color;
    ctx.strokeStyle = contrastColor(color);
    ctx.lineWidth = Math.max(1, width / 960);
    ctx.lineJoin = 'round';
    ctx.strokeText(
      'REANCODE101',
      width - width * 0.025,
      height - height * 0.035
    );
    ctx.fillText('REANCODE101', width - width * 0.025, height - height * 0.035);
    ctx.restore();
  }
  const { title, intro, outro } = edits.appearance;
  if (
    title &&
    ((intro && time < edits.trim.start + 3) ||
      (outro && time > edits.trim.end - 3))
  ) {
    ctx.fillStyle = '#091511da';
    ctx.fillRect(0, height * 0.72, width, height * 0.21);
    ctx.fillStyle = '#b1f4d3';
    ctx.textAlign = 'left';
    ctx.font = `600 ${width / 32}px sans-serif`;
    ctx.fillText(title, width * 0.06, height * 0.84, width * 0.88);
  }
  const caption = edits.captions?.find((c) => c.start <= time && c.end > time),
    style = edits.captionStyle;
  if (caption && style?.burn) {
    ctx.save();
    const fontSize = (style.size * height) / 1080;
    ctx.font = `500 ${fontSize}px "${style.font}", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines: string[] = [];
    for (const paragraph of caption.text.split('\n')) {
      let line = '';
      for (const part of new Intl.Segmenter(undefined, {
        granularity: 'word',
      }).segment(paragraph)) {
        if (ctx.measureText(line + part.segment).width > width * 0.87 && line) {
          lines.push(line);
          line = '';
        }
        line += part.segment;
      }
      if (line) lines.push(line);
    }
    const shown = lines.slice(0, 5),
      lineHeight = fontSize * 1.4;
    const y =
      style.position === 'top'
        ? height * 0.12
        : style.position === 'center'
        ? height * 0.5 - (shown.length * lineHeight) / 2
        : height * 0.9 - (shown.length - 1) * lineHeight;
    if (style.animation === 'fade')
      ctx.globalAlpha = Math.min(
        1,
        (time - caption.start) / 0.08,
        (caption.end - time) / 0.08
      );
    shown.forEach((line, index) => {
      const measured = ctx.measureText(line).width;
      ctx.fillStyle = '#08140cce';
      ctx.fillRect(
        (width - measured) / 2 - fontSize * 0.3,
        y + index * lineHeight - lineHeight / 2,
        measured + fontSize * 0.6,
        lineHeight
      );
      ctx.fillStyle = '#ffffff';
      ctx.fillText(line, width / 2, y + index * lineHeight, width * 0.9);
    });
    ctx.restore();
  }
}
