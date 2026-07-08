import type { JSONValue } from 'ai';
import type { ExtractImageResult } from './extract-image.ts';

export function extractImageToModelOutput({ output }: { output: ExtractImageResult }) {
  if (output.ok === false || !output.dataUrl) return { type: 'json' as const, value: toJsonValue(output) };

  const file = fileDataFromDataUrl(output.dataUrl, output.mediaType);
  if (!file) return { type: 'json' as const, value: toJsonValue(output) };
  return {
    type: 'content' as const,
    value: [
      { type: 'text' as const, text: `extractImage: ${JSON.stringify(imageMetadata(output))}` },
      { type: 'file-data' as const, mediaType: file.mediaType, data: file.data },
    ],
  };
}

function imageMetadata(output: Exclude<ExtractImageResult, { ok: false }>) {
  const { dataUrl: _dataUrl, ...metadata } = output;
  return metadata;
}

function fileDataFromDataUrl(dataUrl: string, fallbackMediaType?: string) {
  const match = /^data:([^,]*),(.*)$/s.exec(dataUrl);
  if (!match) return undefined;
  const parsedMediaType = match[1].split(';')[0];
  const mediaType = fallbackMediaType ?? (parsedMediaType || 'application/octet-stream');
  const data = /(^|;)base64(?:;|$)/i.test(match[1]) ? match[2] : bytesToBase64(dataUrlPayloadBytes(match[2]));
  return { mediaType, data };
}

function dataUrlPayloadBytes(payload: string) {
  const bytes: number[] = [];
  let text = '';
  const textEncoder = new TextEncoder();
  const flushText = () => {
    if (!text) return;
    bytes.push(...textEncoder.encode(text));
    text = '';
  };
  for (let index = 0; index < payload.length; index += 1) {
    if (payload[index] !== '%' || !isHexByte(payload.slice(index + 1, index + 3))) {
      text += payload[index];
      continue;
    }
    flushText();
    bytes.push(Number.parseInt(payload.slice(index + 1, index + 3), 16));
    index += 2;
  }
  flushText();
  return Uint8Array.from(bytes);
}

function bytesToBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return btoa(binary);
}

function isHexByte(value: string) {
  return /^[\da-f]{2}$/i.test(value);
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}
