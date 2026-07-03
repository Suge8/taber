export type ClipboardStatus = 'idle' | 'success' | 'failure';

export class UseClipboard {
  #status = $state<ClipboardStatus>('idle');
  #timer: ReturnType<typeof setTimeout> | undefined;
  #delay: number;

  constructor(options: { delay?: number } = {}) {
    this.#delay = options.delay ?? 1200;
  }

  get status(): ClipboardStatus {
    return this.#status;
  }

  async copy(text: string): Promise<ClipboardStatus> {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error('Clipboard API unavailable');
      }
      this.#set('success');
      return 'success';
    } catch {
      this.#set('failure');
      return 'failure';
    }
  }

  #set(next: ClipboardStatus) {
    this.#status = next;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#status = 'idle';
    }, this.#delay);
  }
}
