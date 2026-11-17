// WebP dimensions live in the first image or extended header, even for animated files.
function inspectWebP(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fourCC = (index) => String.fromCharCode(...bytes.subarray(index, index + 4));
  if (bytes.length < 25 || fourCC(0) !== 'RIFF' || fourCC(8) !== 'WEBP')
    throw new Error('图片缺少有效的 WebP 文件头。');
  switch (fourCC(12)) {
    case 'VP8X': {
      if (bytes.length < 30) break;
      const dimension = (index) => 1 + bytes[index] + (bytes[index + 1] << 8) + (bytes[index + 2] << 16);
      return {
        width: dimension(24),
        height: dimension(27),
        alpha: Boolean(bytes[20] & 16),
        animated: Boolean(bytes[20] & 2),
      };
    }
    case 'VP8L': {
      if (bytes[20] !== 0x2f) break;
      const bits = view.getUint32(21, true);
      // The lossless alpha flag is informational. Preserve alpha for every VP8L image.
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
        alpha: true,
        animated: false,
      };
    }
    case 'VP8 ':
      if (bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
        return {
          width: view.getUint16(26, true) & 0x3fff,
          height: view.getUint16(28, true) & 0x3fff,
          alpha: false,
          animated: false,
        };
      }
  }
  throw new Error('无法识别这张 WebP 图片。');
}

const encode = (canvas, mime, quality) =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('浏览器编码图片失败。'))),
      mime,
      quality,
    ),
  );

export async function normalizeWebP(file) {
  const header = inspectWebP(new Uint8Array(await file.slice(0, 32).arrayBuffer()));
  if (!header.width || !header.height) throw new Error('WebP 图片尺寸无效。');
  const maxBytes = 5 * 1024 * 1024;
  const scale = Math.min(1, 4096 / Math.max(header.width, header.height));
  let width = Math.max(1, Math.round(header.width * scale));
  let height = Math.max(1, Math.round(header.height * scale));
  const bitmap = await createImageBitmap(file, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'high',
  }).catch(() => {
    throw new Error('浏览器无法解码这张 WebP 图片。');
  });
  const canvas = document.createElement('canvas');
  const mime = header.alpha ? 'image/png' : 'image/jpeg';
  const ext = header.alpha ? 'png' : 'jpg';
  let blob;
  try {
    do {
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: header.alpha });
      if (!context) throw new Error('当前浏览器未提供图片转换功能。');
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, width, height);
      blob = await encode(canvas, mime, 0.91);
      if (blob.size <= maxBytes) break;
      const shrink = Math.min(0.85, Math.sqrt(maxBytes / blob.size) * 0.95);
      width = Math.max(1, Math.floor(width * shrink));
      height = Math.max(1, Math.floor(height * shrink));
    } while (true);
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 1;
  }
  const basename = file.name.replace(/\.[^.]+$/, '') || 'image';
  return { file: new File([blob], basename + '.' + ext, { type: mime }), animated: header.animated };
}
