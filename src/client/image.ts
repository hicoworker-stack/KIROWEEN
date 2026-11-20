/**
 * Preparación de fotografías en el navegador (compartida por órdenes de trabajo, reportes de campo e incidentes).
 * Las fotos de celular pesan varios MB: se reducen a 1600 px (JPEG) antes de subirlas. El hash que se sella en el ledger
 * es el de la imagen que realmente se envía.
 */
const MAX_DIM = 1600;
const RESIZE_THRESHOLD_BYTES = 1.5 * 1024 * 1024;

export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });
}

export async function prepareImage(file: File): Promise<string> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    throw new Error('Formato no permitido. Usa una foto JPEG, PNG o WebP.');
  }
  if (file.size <= RESIZE_THRESHOLD_BYTES) return readAsDataUrl(file);
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) throw new Error('No se pudo comprimir la imagen.');
  return readAsDataUrl(blob);
}
