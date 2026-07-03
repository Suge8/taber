export type OffscreenApi = {
  hasDocument(): Promise<boolean>;
  createDocument(parameters: {
    url: string;
    reasons: string[];
    justification: string;
  }): Promise<void>;
  closeDocument(): Promise<void>;
};

const offscreenPath = '/offscreen.html';

export function createOffscreenLifecycle(offscreen: OffscreenApi) {
  let creatingDocument: Promise<void> | undefined;
  let closingDocument: Promise<boolean> | undefined;

  async function ensureDocument() {
    await closingDocument?.catch(() => undefined);
    if (await offscreen.hasDocument()) return true;

    creatingDocument ??= offscreen
      .createDocument({
        url: offscreenPath,
        reasons: ['IFRAME_SCRIPTING'],
        justification: 'Runs the supervised browser agent and its sandbox iframe during active tasks.',
      })
      .finally(() => {
        creatingDocument = undefined;
      });

    await creatingDocument;
    return offscreen.hasDocument();
  }

  function closeDocument() {
    closingDocument ??= closeOpenDocument().finally(() => {
      closingDocument = undefined;
    });
    return closingDocument;
  }

  async function closeOpenDocument() {
    await creatingDocument?.catch(() => undefined);
    if (!(await offscreen.hasDocument())) return false;
    await offscreen.closeDocument();
    return offscreen.hasDocument();
  }

  function hasDocument() {
    return offscreen.hasDocument();
  }

  return { closeDocument, ensureDocument, hasDocument };
}
