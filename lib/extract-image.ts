import { isPageAccessError, pageAccessErrorMessage } from './browser-access.ts';

export const extractImageRequestType = 'taber.extractImage.request';

export type ExtractImageFormat = 'png' | 'jpeg';

export type ExtractImageInput =
  | { source: 'viewport'; tabId?: number; format?: ExtractImageFormat; jpegQuality?: number; selector?: never }
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

export async function captureVisibleTarget(options: {
  targetTabId: number;
  readActiveTabId(): Promise<number | undefined>;
  activate(tabId: number): Promise<void>;
  waitForPaint(): Promise<void>;
  capture(): Promise<string>;
}) {
  const previousTabId = await options.readActiveTabId();
  const activated = previousTabId !== options.targetTabId;
  if (activated) {
    await options.activate(options.targetTabId);
    await options.waitForPaint();
  }
  try {
    if (await options.readActiveTabId() !== options.targetTabId) throw new Error('Target tab changed before viewport capture.');
    const dataUrl = await options.capture();
    if (await options.readActiveTabId() !== options.targetTabId) throw new Error('Target tab changed during viewport capture.');
    return dataUrl;
  } finally {
    if (activated && previousTabId !== undefined && await options.readActiveTabId() === options.targetTabId) {
      await options.activate(previousTabId);
    }
  }
}

export const extractImageInputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['source'],
  properties: {
    source: { type: 'string', enum: ['viewport', 'imageElement', 'canvas', 'backgroundImage'], description: 'viewport captures the current visible viewport; imageElement reads an <img> URL; canvas captures canvas pixels; backgroundImage reads a CSS background-image URL.' },
    selector: { type: 'string', minLength: 1, description: 'Required for source:"imageElement", source:"canvas", and source:"backgroundImage". Native CSS selector on the controlled tab. Omit for source:"viewport".' },
    format: { type: 'string', enum: ['png', 'jpeg'], description: 'Only for source:"viewport" or source:"canvas". Image format. Defaults to png.' },
    jpegQuality: { type: 'integer', minimum: 0, maximum: 100, description: 'Only for source:"viewport" or source:"canvas" with format:"jpeg". JPEG quality from 0 to 100.' },
  },
} as const;

type ExtractImageViewportInput = Extract<ExtractImageInput, { source: 'viewport' }>;
export type ExtractImagePageInput = Exclude<ExtractImageInput, ExtractImageViewportInput>;


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
  return { source: 'viewport', ...readEncoding(value), ...readOptionalTabId(value) };
}

function readImageElementInput(value: Record<string, unknown>): Extract<ExtractImageInput, { source: 'imageElement' }> {
  return { source: 'imageElement', selector: readSelector(value, 'imageElement'), ...readOptionalTabId(value) };
}

function readCanvasInput(value: Record<string, unknown>): Extract<ExtractImageInput, { source: 'canvas' }> {
  return { source: 'canvas', selector: readSelector(value, 'canvas'), ...readEncoding(value), ...readOptionalTabId(value) };
}

function readBackgroundImageInput(value: Record<string, unknown>): Extract<ExtractImageInput, { source: 'backgroundImage' }> {
  return { source: 'backgroundImage', selector: readSelector(value, 'backgroundImage'), ...readOptionalTabId(value) };
}

function readOptionalTabId(value: Record<string, unknown>): { tabId?: number } {
  return 'tabId' in value ? { tabId: readPositiveInteger(value.tabId, 'tabId') } : {};
}

function readEncoding(value: Record<string, unknown>): { format?: ExtractImageFormat; jpegQuality?: number } {
  const format = 'format' in value ? readFormat(value.format) : undefined;
  // Models pad non-jpeg requests with a placeholder jpegQuality; it is meaningless there, ignore it.
  const jpegQuality = format === 'jpeg' && value.jpegQuality !== undefined ? readJpegQuality(value.jpegQuality) : undefined;
  return { ...(format ? { format } : {}), ...(jpegQuality !== undefined ? { jpegQuality } : {}) };
}

export function createExtractImageController(options: {
  getCurrentTabId(): Promise<number>;
  captureVisibleTab(input: ExtractImageViewportInput): Promise<{ dataUrl: string; width?: number; height?: number }>;
  executeInTab(tabId: number, input: ExtractImagePageInput): Promise<unknown>;
}) {
  async function run(value: unknown): Promise<ExtractImageResult> {
    const input = parseExtractImageInput(value);
    if (input.source === 'viewport') {
      let captured: { dataUrl: string; width?: number; height?: number };
      try {
        captured = await options.captureVisibleTab(input);
      } catch (error) {
        if (isTaskAborted(error)) throw error;
        if (isPageAccessError(error)) return pageAccessRequired(error);
        return screenshotUnavailable(error);
      }
      if (!captured.dataUrl.startsWith('data:')) throw new Error('extractImage.viewport returned no data URL');
      return {
        ok: true as const,
        source: 'viewport' as const,
        dataUrl: captured.dataUrl,
        mediaType: mediaTypeFromDataUrl(captured.dataUrl) ?? mediaType(input),
        ...(captured.width && captured.height ? { width: captured.width, height: captured.height } : {}),
      };
    }
    const tabId = input.tabId ?? (await options.getCurrentTabId());
    try {
      return requireExtractImageResult(await options.executeInTab(tabId, input));
    } catch (error) {
      if (isPageAccessError(error)) return pageAccessRequired(error);
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

function screenshotUnavailable(error: unknown): ExtractImageRecoverableError {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    code: 'SCREENSHOT_UNAVAILABLE',
    message: `Could not capture the visible tab: ${reason}`,
    retryHint: 'Make sure the target tab is visible, then retry.',
  };
}

function pageAccessRequired(error: unknown): ExtractImageRecoverableError {
  // Keep the browser's original error: access failures have many causes
  // (missing grant, minimized window, restricted page) that need diagnosing.
  const reason = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    code: 'PAGE_ACCESS_REQUIRED',
    message: `${pageAccessErrorMessage()} (${reason})`,
    retryHint: 'Complete Browser Control in settings, then retry.',
  };
}

function mediaTypeFromDataUrl(value: string) {
  return /^data:([^;,]+)[;,]/i.exec(value)?.[1].toLowerCase();
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
