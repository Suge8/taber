import { isPageAccessError, pageAccessErrorMessage } from './browser-access.ts';

export const extractImageRequestType = 'taber.extractImage.request';

export type ExtractImageFormat = 'png' | 'jpeg';

export type ExtractImageInput =
  | { source: 'viewport'; format?: ExtractImageFormat; jpegQuality?: number; selector?: never }
  | { source: 'imageElement'; selector: string; tabId?: number }
  | { source: 'canvas'; selector: string; tabId?: number; format?: ExtractImageFormat; jpegQuality?: number }
  | { source: 'backgroundImage'; selector: string; tabId?: number };

type ExtractImageDataSuccess = {
  ok: true;
  source: 'viewport' | 'canvas';
  dataUrl: string;
  mediaType: string;
  width?: number;
  height?: number;
  selector?: string;
  url?: never;
  alt?: never;
};

type ExtractImageReferenceSuccess = {
  ok: true;
  source: 'imageElement' | 'backgroundImage';
  selector: string;
  url?: string;
  dataUrl?: string;
  mediaType?: string;
  width?: number;
  height?: number;
  alt?: string;
};

export type ExtractImageErrorCode = 'ELEMENT_NOT_FOUND' | 'INVALID_SELECTOR' | 'SCREENSHOT_UNAVAILABLE' | 'PAGE_ACCESS_REQUIRED';

export type ExtractImageRecoverableError = {
  ok: false;
  code: ExtractImageErrorCode;
  message: string;
  retryHint?: string;
  url?: never;
  dataUrl?: never;
  mediaType?: never;
  width?: never;
  height?: never;
  alt?: never;
  selector?: never;
};

export type ExtractImageSuccess = ExtractImageDataSuccess | ExtractImageReferenceSuccess;
export type ExtractImageResult = ExtractImageSuccess | ExtractImageRecoverableError;

export const extractImageInputJsonSchema = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['source'],
      properties: {
        source: { type: 'string', enum: ['viewport'], description: 'Capture the current visible viewport. To capture another tab, switch to it first.' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format. Defaults to png.' },
        jpegQuality: { type: 'integer', minimum: 0, maximum: 100, description: 'JPEG quality from 0 to 100. Only valid when format is jpeg.' },
      },
      allOf: [
        { if: { required: ['jpegQuality'] }, then: { required: ['format'], properties: { format: { enum: ['jpeg'] } } } },
        { if: { required: ['format'], properties: { format: { enum: ['png'] } } }, then: { not: { required: ['jpegQuality'] } } },
      ],
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['source', 'selector'],
      properties: {
        source: { type: 'string', enum: ['imageElement'], description: 'Read an <img> element URL or data URL from a CSS selector.' },
        selector: { type: 'string', minLength: 1, description: 'CSS selector for the target <img> element.' },
        tabId: { type: 'integer', minimum: 1, description: 'Browser tab id. Defaults to the active tab.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['source', 'selector'],
      properties: {
        source: { type: 'string', enum: ['canvas'], description: 'Capture a <canvas> element from a CSS selector.' },
        selector: { type: 'string', minLength: 1, description: 'CSS selector for the target <canvas> element.' },
        tabId: { type: 'integer', minimum: 1, description: 'Browser tab id. Defaults to the active tab.' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format. Defaults to png.' },
        jpegQuality: { type: 'integer', minimum: 0, maximum: 100, description: 'JPEG quality from 0 to 100. Only valid when format is jpeg.' },
      },
      allOf: [
        { if: { required: ['jpegQuality'] }, then: { required: ['format'], properties: { format: { enum: ['jpeg'] } } } },
        { if: { required: ['format'], properties: { format: { enum: ['png'] } } }, then: { not: { required: ['jpegQuality'] } } },
      ],
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['source', 'selector'],
      properties: {
        source: { type: 'string', enum: ['backgroundImage'], description: 'Read CSS background-image URL or data URL from a CSS selector.' },
        selector: { type: 'string', minLength: 1, description: 'CSS selector for the target element.' },
        tabId: { type: 'integer', minimum: 1, description: 'Browser tab id. Defaults to the active tab.' },
      },
    },
  ],
} as const;

type ExtractImageViewportInput = Extract<ExtractImageInput, { source: 'viewport' }>;
export type ExtractImagePageInput = Exclude<ExtractImageInput, ExtractImageViewportInput>;

const viewportInputKeys = new Set(['source', 'format', 'jpegQuality']);
const imageElementInputKeys = new Set(['source', 'selector', 'tabId']);
const canvasInputKeys = new Set(['source', 'selector', 'tabId', 'format', 'jpegQuality']);
const backgroundImageInputKeys = new Set(['source', 'selector', 'tabId']);

export function parseExtractImageInput(value: unknown): ExtractImageInput {
  if (!isRecord(value) || Array.isArray(value)) throw new Error('extractImage input must be an object');
  if (!('source' in value)) throw new Error('extractImage.source is required');

  const source = readSource(value.source);
  if (source === 'viewport') return readViewportInput(value);
  if (source === 'imageElement') return readImageElementInput(value);
  if (source === 'canvas') return readCanvasInput(value);
  return readBackgroundImageInput(value);
}

function readViewportInput(value: Record<string, unknown>): ExtractImageViewportInput {
  rejectUnknownInputs(value, viewportInputKeys, 'viewport');
  return { source: 'viewport', ...readEncoding(value, 'viewport') };
}

function readImageElementInput(value: Record<string, unknown>): Extract<ExtractImageInput, { source: 'imageElement' }> {
  rejectUnknownInputs(value, imageElementInputKeys, 'imageElement');
  const input: Extract<ExtractImageInput, { source: 'imageElement' }> = { source: 'imageElement', selector: readSelector(value, 'imageElement') };
  if ('tabId' in value) input.tabId = readPositiveInteger(value.tabId, 'tabId');
  return input;
}

function readCanvasInput(value: Record<string, unknown>): Extract<ExtractImageInput, { source: 'canvas' }> {
  rejectUnknownInputs(value, canvasInputKeys, 'canvas');
  const input: Extract<ExtractImageInput, { source: 'canvas' }> = { source: 'canvas', selector: readSelector(value, 'canvas'), ...readEncoding(value, 'canvas') };
  if ('tabId' in value) input.tabId = readPositiveInteger(value.tabId, 'tabId');
  return input;
}

function readBackgroundImageInput(value: Record<string, unknown>): Extract<ExtractImageInput, { source: 'backgroundImage' }> {
  rejectUnknownInputs(value, backgroundImageInputKeys, 'backgroundImage');
  const input: Extract<ExtractImageInput, { source: 'backgroundImage' }> = { source: 'backgroundImage', selector: readSelector(value, 'backgroundImage') };
  if ('tabId' in value) input.tabId = readPositiveInteger(value.tabId, 'tabId');
  return input;
}

function readEncoding(value: Record<string, unknown>, branch: string): { format?: ExtractImageFormat; jpegQuality?: number } {
  const format = 'format' in value ? readFormat(value.format) : undefined;
  if ('jpegQuality' in value && format !== 'jpeg') throw new Error(`extractImage.${branch}.jpegQuality requires format=jpeg`);
  return { ...(format ? { format } : {}), ...('jpegQuality' in value ? { jpegQuality: readJpegQuality(value.jpegQuality) } : {}) };
}

export function createExtractImageController(options: {
  getCurrentTabId(): Promise<number>;
  captureVisibleTab(input: ExtractImageViewportInput): Promise<string>;
  executeInTab(tabId: number, input: ExtractImagePageInput): Promise<unknown>;
}) {
  async function run(value: unknown): Promise<ExtractImageResult> {
    const input = parseExtractImageInput(value);
    if (input.source === 'viewport') {
      let dataUrl: string;
      try {
        dataUrl = await options.captureVisibleTab(input);
      } catch (error) {
        if (isTaskAborted(error)) throw error;
        return screenshotUnavailable();
      }
      if (!dataUrl.startsWith('data:')) throw new Error('extractImage.viewport returned no data URL');
      return { ok: true as const, source: 'viewport' as const, dataUrl, mediaType: mediaTypeFromDataUrl(dataUrl) ?? mediaType(input) };
    }
    const tabId = input.tabId ?? (await options.getCurrentTabId());
    try {
      return requireExtractImageResult(await options.executeInTab(tabId, input));
    } catch (error) {
      if (isPageAccessError(error)) return pageAccessRequired();
      throw error;
    }
  }

  return { run };
}

export function extractImageFromPage(value: unknown): ExtractImageResult {
  if (!isRecord(value)) throw new Error('extractImage page input must be an object');
  const input = value as ExtractImageInput;
  const source = input.source;
  if (source === 'viewport') throw new Error('extractImage.viewport must use captureVisibleTab');
  if (source !== 'imageElement' && source !== 'canvas' && source !== 'backgroundImage') throw new Error(`Unsupported page image source: ${String(source)}`);

  const selector = (input.selector ?? '').trim();
  if (!selector) throw new Error(`extractImage.${source} requires selector`);
  const element = querySelectorLocal(selector);
  if (isRecoverableResultLocal(element)) return element;
  if (source === 'imageElement') return readImageLocal(element, selector);
  if (source === 'canvas') return readCanvasLocal(element, selector, input as Extract<ExtractImageInput, { source: 'canvas' }>);
  return readBackgroundLocal(element, selector);

  function isRecoverableResultLocal(value: Element | ExtractImageRecoverableError): value is ExtractImageRecoverableError {
    return (value as ExtractImageRecoverableError).ok === false;
  }

  function querySelectorLocal(targetSelector: string): Element | ExtractImageRecoverableError {
    try {
      const target = document.querySelector(targetSelector);
      if (!target) {
        return {
          ok: false,
          code: 'ELEMENT_NOT_FOUND',
          message: `No element matches selector: ${targetSelector}`,
          retryHint: 'Check the selector or inspect the page before retrying.',
        };
      }
      return target;
    } catch {
      return {
        ok: false,
        code: 'INVALID_SELECTOR',
        message: `Invalid CSS selector: ${targetSelector}`,
        retryHint: 'Use a valid CSS selector.',
      };
    }
  }

  function readImageLocal(target: Element, targetSelector: string): ExtractImageResult {
    if (!(target instanceof HTMLImageElement)) throw new Error(`Element is not an image: ${targetSelector}`);
    const imageUrl = target.currentSrc || target.src;
    if (!imageUrl) throw new Error(`Image has no src: ${targetSelector}`);
    return {
      ok: true as const,
      source: 'imageElement' as const,
      selector: targetSelector,
      ...imageReferenceLocal(imageUrl),
      width: target.naturalWidth || target.width,
      height: target.naturalHeight || target.height,
      alt: target.alt,
    };
  }

  function readCanvasLocal(target: Element, targetSelector: string, canvasInput: Extract<ExtractImageInput, { source: 'canvas' }>): ExtractImageResult {
    if (!(target instanceof HTMLCanvasElement)) throw new Error(`Element is not a canvas: ${targetSelector}`);
    const fallbackMediaType = canvasInput.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const quality = canvasInput.format === 'jpeg' && canvasInput.jpegQuality !== undefined ? canvasInput.jpegQuality / 100 : undefined;
    const dataUrl = quality === undefined ? target.toDataURL(fallbackMediaType) : target.toDataURL(fallbackMediaType, quality);
    return { ok: true as const, source: 'canvas' as const, selector: targetSelector, dataUrl, mediaType: dataUrlMediaTypeLocal(dataUrl) ?? fallbackMediaType, width: target.width, height: target.height };
  }

  function readBackgroundLocal(target: Element, targetSelector: string): ExtractImageResult {
    const backgroundUrl = firstBackgroundUrlLocal(getComputedStyle(target).backgroundImage);
    if (!backgroundUrl) throw new Error(`Element has no background image: ${targetSelector}`);
    const rect = target.getBoundingClientRect();
    return { ok: true as const, source: 'backgroundImage' as const, selector: targetSelector, ...imageReferenceLocal(backgroundUrl), width: Math.round(rect.width), height: Math.round(rect.height) };
  }

  function imageReferenceLocal(rawUrl: string) {
    const imageUrl = rawUrl.trim();
    const media = dataUrlMediaTypeLocal(imageUrl);
    if (media) return { dataUrl: imageUrl, mediaType: media };
    return { url: new URL(imageUrl, location.href).href };
  }

  function firstBackgroundUrlLocal(backgroundImage: string) {
    const match = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/.exec(backgroundImage);
    return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
  }

  function dataUrlMediaTypeLocal(value: string) {
    return /^data:([^;,]+)[;,]/i.exec(value)?.[1].toLowerCase();
  }
}

function mediaType(input: { format?: ExtractImageFormat }) {
  return input.format === 'jpeg' ? 'image/jpeg' : 'image/png';
}

function requireExtractImageResult(value: unknown): ExtractImageResult {
  if (isRecord(value) && value.ok === true) return value as ExtractImageResult;
  if (isRecord(value) && value.ok === false && isExtractImageErrorCode(value.code) && typeof value.message === 'string') return value as ExtractImageResult;
  throw new Error('extractImage returned invalid result');
}

function isExtractImageErrorCode(value: unknown): value is ExtractImageErrorCode {
  return value === 'ELEMENT_NOT_FOUND' || value === 'INVALID_SELECTOR' || value === 'SCREENSHOT_UNAVAILABLE' || value === 'PAGE_ACCESS_REQUIRED';
}

function screenshotUnavailable(): ExtractImageRecoverableError {
  return {
    ok: false,
    code: 'SCREENSHOT_UNAVAILABLE',
    message: 'Could not capture the visible tab.',
    retryHint: 'Make sure the target tab is visible, then retry.',
  };
}

function pageAccessRequired(): ExtractImageRecoverableError {
  return {
    ok: false,
    code: 'PAGE_ACCESS_REQUIRED',
    message: pageAccessErrorMessage(),
    retryHint: 'Complete Browser Control in settings, then retry.',
  };
}

function mediaTypeFromDataUrl(value: string) {
  return /^data:([^;,]+)[;,]/i.exec(value)?.[1].toLowerCase();
}

function rejectUnknownInputs(value: Record<string, unknown>, allowedKeys: Set<string>, branch: string) {
  for (const key of Object.keys(value)) if (!allowedKeys.has(key)) throw new Error(`Unknown extractImage.${branch} input: ${key}`);
}

function readSource(value: unknown): ExtractImageInput['source'] {
  if (value === 'viewport' || value === 'imageElement' || value === 'canvas' || value === 'backgroundImage') return value;
  throw new Error(`Invalid extractImage source: ${String(value)}`);
}

function readFormat(value: unknown): ExtractImageFormat {
  if (value === 'png' || value === 'jpeg') return value;
  throw new Error(`Invalid image format: ${String(value)}`);
}

function readSelector(value: Record<string, unknown>, branch: string) {
  if (!('selector' in value)) throw new Error(`extractImage.${branch} requires selector`);
  const selector = readString(value.selector, 'selector');
  if (!selector.trim()) throw new Error(`extractImage.${branch} requires selector`);
  return selector;
}

function readString(value: unknown, name: string) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function readPositiveInteger(value: unknown, name: string) {
  if (Number.isInteger(value) && Number(value) > 0) return Number(value);
  throw new Error(`${name} must be a positive integer`);
}

function readJpegQuality(value: unknown) {
  if (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 100) return Number(value);
  throw new Error('jpegQuality must be an integer from 0 to 100');
}

function isTaskAborted(error: unknown) {
  return error instanceof Error ? error.message === 'Task aborted' : String(error) === 'Task aborted';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
