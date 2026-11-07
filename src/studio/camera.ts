import { clamp, type Camera } from './model';
export type CameraCorner =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';
export const cameraCorners: { id: CameraCorner; label: string }[] = [
  { id: 'top-left', label: 'Top left' },
  { id: 'top-right', label: 'Top right' },
  { id: 'bottom-left', label: 'Bottom left' },
  { id: 'bottom-right', label: 'Bottom right' },
];
export function cameraRect(camera: Camera, width: number, height: number) {
  const size = Math.min(width, height) * camera.size;
  const x = clamp(camera.x * width, size / 2, width - size / 2),
    y = clamp(camera.y * height, size / 2, height - size / 2);
  return { left: x - size / 2, top: y - size / 2, size };
}
export function cameraAtCorner(
  camera: Camera,
  corner: CameraCorner,
  ratio = 16 / 9
): Camera {
  const shortest = Math.min(ratio, 1),
    radius = (camera.size * shortest) / 2,
    margin = shortest * 0.035;
  const x = (radius + margin) / ratio,
    y = radius + margin;
  return {
    ...camera,
    x: corner.endsWith('left') ? x : 1 - x,
    y: corner.startsWith('top') ? y : 1 - y,
  };
}
export function selectedCameraCorner(camera: Camera, ratio = 16 / 9) {
  return cameraCorners.find(({ id }) => {
    const target = cameraAtCorner(camera, id, ratio);
    return (
      Math.abs(target.x - camera.x) < 0.001 &&
      Math.abs(target.y - camera.y) < 0.001
    );
  })?.id;
}
